import { existsSync } from "node:fs";
import { isActiveState, isRoutable, isTerminalState, roleFor, type Role, type ServiceConfig } from "./config.ts";
import { issueControlKey, RunLedger, type RunCycle } from "./ledger.ts";
import type { IssueMessageRef } from "./iteration.ts";
import { truncate, type Logger } from "./log.ts";
import { localize, type Language } from "./language.ts";
import type { AgentUpdate, SessionSummary, TokenTotals } from "./runner.ts";
import type { MergeConflict, TrackerAdapter } from "./tracker/index.ts";
import type { AgentControl } from "./tracker/types.ts";
import { normalizeState, type Issue } from "./types.ts";
import type { EffectiveWorkflow } from "./workflow.ts";

export interface WorkerParams {
  issue: Issue;
  attempt: number | null;
  /** Decided by the card's state at dispatch; the worker ends when the card moves to the other role. */
  role: Role;
  /** 1-based review round for the reviewer. */
  reviewRound: number;
  control: AgentControl;
  workflow: EffectiveWorkflow;
  tracker: TrackerAdapter;
  signal: AbortSignal;
  log: Logger;
  onUpdate(update: AgentUpdate): void;
}

export interface OrchestratorDeps {
  /** Returns the current effective workflow, re-reading the file if it changed. */
  refreshWorkflow(): EffectiveWorkflow;
  /** Error from the latest failed workflow reload (blocks dispatch until fixed). */
  workflowError(): string | null;
  createTracker(config: ServiceConfig): TrackerAdapter;
  runWorker(params: WorkerParams): Promise<void>;
  removeWorkspace(config: ServiceConfig, issue: Issue, tracker: TrackerAdapter): Promise<void>;
  log: Logger;
  now?: () => number;
  /** Per-issue run limits; in-memory when omitted. */
  ledger?: RunLedger;
  /** Poll and log what would be dispatched, without workspaces or agents. */
  dryRun?: boolean;
}

interface RunningEntry {
  issue: Issue;
  role: Role;
  abort: AbortController;
  startedAt: number;
  attempt: number | null;
  threadId: string | null;
  turnCount: number;
  lastEvent: string | null;
  lastEventAt: number | null;
  lastMessage: string | null;
  tokens: TokenTotals;
  lastReported: TokenTotals;
  cycle: RunCycle;
  authorizationId: string;
  invocationId: string;
  limit: number;
  ordinal: number | null;
  issueMessage: IssueMessageRef | null;
  config: ServiceConfig;
  tracker: TrackerAdapter;
  startupPhase: string;
  startupUncertain: boolean;
  exited: boolean;
  summary: SessionSummary | null;
  termination: { cleanup: boolean; reason: string; state?: string } | null;
  stalled: boolean;
  done: Promise<void>;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  url: string | null;
  attempt: number;
  dueAt: number;
  timer: NodeJS.Timeout;
  error: string | null;
}

const CONTINUATION_DELAY_MS = 1_000;
const startupRecovery = (language: Language) => localize(language,
  "startup remains uncertain; verify/clean up interrupted runtime before reauthorizing; cannot establish automatically",
  "启动状态仍不确定；重新授权前请检查并清理中断的运行时，系统无法自动确认");

function terminalIssue(config: ServiceConfig, issue: Issue): boolean {
  return issue.contentState === "CLOSED" || isTerminalState(config, issue.state);
}

/** Urgent issues first, then priority, oldest, identifier. */
export function sortForDispatch(issues: Issue[], urgent: (issue: Issue) => boolean = () => false): Issue[] {
  const bucket = (p: number | null) => (p !== null && p >= 1 && p <= 4 ? p : 5);
  return [...issues].sort((a, b) =>
    Number(urgent(b)) - Number(urgent(a))
    || bucket(a.priority) - bucket(b.priority)
    || (a.createdAt?.getTime() ?? Infinity) - (b.createdAt?.getTime() ?? Infinity)
    || a.identifier.localeCompare(b.identifier));
}

export function retryDelayMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxBackoffMs);
}

const credits = (value: number) => Number(value.toFixed(2));

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Cosmetic only: never substitute configured model names or unobserved zero usage. */
export function formatUsageFooter(s: SessionSummary, ordinal: number | null, limit: number, language: Language = "en"): string | null {
  const models = [...new Set(s.models.map((m) => m.model.trim()))];
  if (s.usageComplete !== true || ordinal === null || !Number.isFinite(s.aiCredits) || s.aiCredits < 0 ||
    !models.length || models.some((m) => !m || /^(auto|unknown)$/i.test(m) || /[\r\n<>]/.test(m))) return null;
  return localize(language,
    `Usage (this session): ${s.aiCredits.toFixed(2)} · Sessions ${ordinal}/${limit} · Models: ${models.join(", ")}`,
    `用量（本轮）：${s.aiCredits.toFixed(2)} · 轮次 ${ordinal}/${limit} · 模型：${models.join(", ")}`);
}

/** Why this run may not start another session, or null. */
export function runLimitReached(cycle: RunCycle, language: Language = "en"): string | null {
  if (cycle.sessions >= cycle.limit) {
    return localize(language, `It used all ${cycle.limit} sessions allowed per authorization (agent.max_sessions) without handing the issue off.`,
      `本次授权允许的 ${cycle.limit} 次会话 (agent.max_sessions) 已全部用尽，但尚未完成 issue 交接。`);
  }
  return null;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retries = new Map<string, RetryEntry>();
  private readonly totals = { input: 0, output: 0, total: 0, secondsEnded: 0 };
  private readonly ledger: RunLedger;
  private readonly unidentified = new Set<string>();
  private ledgerFailure: string | null = null;
  private rateLimits: unknown = null;
  private tracker: TrackerAdapter | null = null;
  private trackerConfig: ServiceConfig | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
    this.ledger = deps.ledger ?? new RunLedger();
  }

  /** Validates, sweeps terminal workspaces, and schedules the first tick. Throws when startup validation fails. */
  async start(): Promise<void> {
    await this.prepare();
    this.scheduleTick(0);
  }

  /** Startup plus a single tick; waits for any dispatched workers, then stops. */
  async runOnce(): Promise<void> {
    await this.prepare();
    await this.tick();
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.stopped = true;
    await Promise.allSettled([...this.running.values()].map((entry) => entry.done));
    await this.stop();
  }

  private async prepare(): Promise<void> {
    const workflow = this.deps.refreshWorkflow();
    const tracker = this.trackerFor(workflow.config);
    const problem = this.preflight(workflow);
    if (problem) throw new Error(problem);
    await this.startupCleanup(workflow.config, tracker);
  }

  /**
   * Polls, retry firings and worker exits change scheduling state one at a time. Workers keep running in
   * parallel, but no decision is made while another one is waiting on the tracker with older data.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** One poll-and-dispatch cycle; exposed for `--once` and tests. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    return this.serial(() => this.pollOnce());
  }

  private async pollOnce(): Promise<void> {
    let interval = 30_000;
    try {
      const workflow = this.deps.refreshWorkflow();
      const config = workflow.config;
      interval = config.polling.intervalMs;
      let tracker: TrackerAdapter;
      let blocked: string | null = null;
      try {
        tracker = this.trackerFor(config);
      } catch (error) {
        if (!this.tracker) throw error;
        tracker = this.tracker;
        blocked = (error as Error).message;
      }
      await this.reconcile(config, tracker);
      blocked ??= this.preflight(workflow);
      if (blocked) {
        this.log.error("dispatch skipped: preflight failed", { error: blocked });
        return;
      }
      let candidates: Issue[];
      let waiting: Issue[];
      try {
        const states = [...new Set([...config.tracker.activeStates, ...config.tracker.terminalStates,
          config.tracker.blockedState, ...(config.tracker.handoffState ? [config.tracker.handoffState] : []),
          ...(config.review ? [config.review.passState] : []), ...(config.mergeConflicts?.states ?? []),
          ...this.ledger.records().map((c) => c.lastState)])];
        const fetched = await tracker.fetchIssuesByStates(states);
        // Exact old item IDs can migrate v1 records; never infer identity from an identifier.
        const legacyIds = this.ledger.legacyItemIds().filter((id) => !fetched.some((i) => i.id === id));
        if (legacyIds.length) fetched.push(...await tracker.fetchIssuesByIds(legacyIds));
        if (!this.deps.dryRun) {
          for (const issue of fetched) await this.observeIssue(issue, config, tracker);
        }
        candidates = fetched.filter((issue) => isActiveState(config, issue.state));
        waiting = fetched.filter((issue) => !isActiveState(config, issue.state));
      } catch (error) {
        this.checkLedgerFailure(error);
        this.log.error("candidate fetch failed", { error: (error as Error).message });
        return;
      }
      let dispatched = 0;
      candidates.push(...await this.returnConflicted(waiting, config, tracker));
      const urgent = (issue: Issue) => Boolean(this.ledger.get(issue.id)?.returnedFor);
      for (const issue of sortForDispatch(candidates, urgent)) {
        if (this.availableSlots(config) - (this.deps.dryRun ? dispatched : 0) <= 0) break;
        if (!this.shouldDispatch(issue, config)) continue;
        if (this.deps.dryRun) {
          const cycle = this.ledger.get(issue.id);
          const limit = cycle ? runLimitReached(cycle) : this.same(issue.state, config.tracker.startState) ? null : "No recoverable authorization for this running card";
          if (limit) {
            this.log.info("dry run: would halt", { issue_id: issue.id, issue_identifier: issue.identifier, reason: limit });
            continue;
          }
          dispatched++;
          this.log.info("dry run: would dispatch", { issue_id: issue.id, issue_identifier: issue.identifier, state: issue.state, priority: issue.priority, title: issue.title });
        } else {
          const admitted = await this.admit(issue, config, tracker);
          if (admitted && this.hasSlot(config, admitted)) {
            dispatched++;
            this.dispatch(admitted, null, workflow, tracker);
          }
        }
      }
      this.log.info("tick", { candidates: candidates.length, dispatched, running: this.running.size, retrying: this.retries.size });
    } catch (error) {
      this.checkLedgerFailure(error);
      this.log.error("tick failed", { error: (error as Error).message });
    } finally {
      this.ticking = false;
      this.scheduleTick(interval);
    }
  }

  /** Stops polling, cancels retries, and waits for running workers to wind down. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    for (const retry of this.retries.values()) clearTimeout(retry.timer);
    this.retries.clear();
    const pending = [...this.running.values()].map((entry) => {
      entry.termination ??= { cleanup: false, reason: "service stopping" };
      entry.abort.abort("service stopping");
      return entry.done;
    });
    await Promise.allSettled(pending);
    await this.queue;
  }

  snapshot() {
    const now = this.now();
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const active = [...this.running.values()];
    return {
      generated_at: new Date(now).toISOString(),
      counts: { running: active.length, retrying: this.retries.size },
      running: active.map((e) => ({
        issue_id: e.issue.id,
        issue_identifier: e.issue.identifier,
        issue_url: e.issue.url,
        state: e.issue.state,
        session_id: e.threadId ? `${e.threadId}-${e.turnCount}` : null,
        turn_count: e.turnCount,
        last_event: e.lastEvent,
        last_message: e.lastMessage,
        started_at: iso(e.startedAt),
        last_event_at: iso(e.lastEventAt),
        tokens: { input_tokens: e.tokens.input, output_tokens: e.tokens.output, total_tokens: e.tokens.total },
        run: { sessions: e.cycle?.sessions ?? 0, ai_credits: credits(e.cycle?.aiCredits ?? 0) },
      })),
      retrying: [...this.retries.values()].map((r) => ({
        issue_id: r.issueId, issue_identifier: r.identifier, issue_url: r.url, attempt: r.attempt, due_at: iso(r.dueAt), error: r.error,
      })),
      ledger_error: this.ledgerFailure,
      halted: (this.ledgerFailure ? [] : this.ledger.records()).flatMap((cycle) => {
        return cycle.halted ? [{ issue_id: cycle.itemId, issue_identifier: cycle.identifier, reason: cycle.halted.reason, at: cycle.halted.at }] : [];
      }),
      totals: {
        input_tokens: this.totals.input,
        output_tokens: this.totals.output,
        total_tokens: this.totals.total,
        seconds_running: this.totals.secondsEnded + active.reduce((sum, e) => sum + (now - e.startedAt) / 1000, 0),
      },
      rate_limits: this.rateLimits,
    };
  }

  // ---- validation ----

  private trackerFor(config: ServiceConfig): TrackerAdapter {
    if (this.tracker && this.trackerConfig === config) return this.tracker;
    const tracker = this.deps.createTracker(config);
    this.tracker = tracker;
    this.trackerConfig = config;
    return tracker;
  }

  private preflight(workflow: EffectiveWorkflow): string | null {
    const reloadError = this.deps.workflowError();
    if (reloadError) return `workflow reload failed: ${reloadError}`;
    const cli = workflow.config.copilot.cliPath;
    if (cli && !existsSync(cli)) return `copilot.cli_path ${cli} does not exist`;
    const review = workflow.config.review;
    if (review && !existsSync(review.promptFile)) return `review.prompt_file ${review.promptFile} does not exist`;
    return null;
  }

  // ---- dispatch ----

  private availableSlots(config: ServiceConfig): number {
    return Math.max(config.agent.maxConcurrentAgents - this.running.size, 0);
  }

  private stateHasSlot(config: ServiceConfig, state: string): boolean {
    const key = normalizeState(state);
    const limit = config.agent.maxConcurrentAgentsByState[key] ?? config.agent.maxConcurrentAgents;
    const inState = [...this.running.values()].filter((e) => normalizeState(e.issue.state) === key).length;
    return inState < limit;
  }

  private hasSlot(config: ServiceConfig, issue: Issue): boolean {
    return this.availableSlots(config) > 0 && this.stateHasSlot(config, issue.state);
  }

  private shouldDispatch(issue: Issue, config: ServiceConfig): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (terminalIssue(config, issue) || !isActiveState(config, issue.state) || !isRoutable(config, issue)) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    const cycle = this.ledger.get(issue.id);
    if (cycle && (cycle.halted || cycle.terminal || cycle.pending || cycle.waitingState || cycle.invocation?.startupUncertain ||
      !this.same(cycle.lastState, issue.state) || this.workerFor(cycle) || cycle.invocation && cycle.invocation.phase !== "finished")) return false;
    return this.stateHasSlot(config, this.same(issue.state, config.tracker.startState) ? config.tracker.workingState : issue.state);
  }

  private same(a: string, b: string): boolean { return normalizeState(a) === normalizeState(b); }

  private workerFor(cycle: RunCycle): RunningEntry | undefined {
    return [...this.running.values()].find((e) => e.cycle.key === cycle.key);
  }

  private waiting(config: ServiceConfig, state: string): boolean {
    return [config.tracker.blockedState, config.review?.passState, config.tracker.handoffState, ...(config.mergeConflicts?.states ?? [])]
      .some((s) => s && this.same(s, state) && !isActiveState(config, s));
  }

  /** Observations never grant allowance except first Todo or a persisted waiting -> Todo edge. */
  private async observeIssue(issue: Issue, config: ServiceConfig, tracker: TrackerAdapter, cleanupTerminal = true): Promise<void> {
    let cycle: RunCycle | undefined;
    try { cycle = this.ledger.adopt(issue, config.agent.maxSessions); }
    catch (error) {
      this.checkLedgerFailure(error);
      if (this.ledgerFailure) throw error;
      if (!this.unidentified.has(issue.id) && !terminalIssue(config, issue) && isActiveState(config, issue.state)) {
        this.unidentified.add(issue.id);
        await tracker.commentOnIssue?.(issue, localize(config.language,
          `**symphony-copilot: control identity cannot be recovered.** ${(error as Error).message}. Restore the ledger/native issue mapping before moving the card to "${config.tracker.startState}".`,
          `**symphony-copilot：无法恢复控制标识。** ${(error as Error).message}。请恢复账本与原始 issue 的映射，再将卡片移至 "${config.tracker.startState}"。`));
        await tracker.blockIssue?.(issue);
      }
      return;
    }
    if (!cycle) {
      if (terminalIssue(config, issue)) {
        if (cleanupTerminal) await this.safeRemove(issue);
        return;
      }
      if (!isActiveState(config, issue.state) || !isRoutable(config, issue)) return;
      if (this.same(issue.state, config.tracker.startState)) {
        this.ledger.authorize(issue, config.agent.maxSessions, new Date(this.now()));
        return;
      }
      // Persist an inactive origin first: a crash before pause must not authorize an orphan active card.
      cycle = this.ledger.authorize({ ...issue, state: config.tracker.blockedState }, config.agent.maxSessions, new Date(this.now()));
      this.markHalted(issue, cycle, localize(config.language, "No recoverable authorization for this running card; human takeover is required.",
        "无法恢复此运行中卡片的授权，需要人工接管。"));
      await this.reportHalt(issue, cycle);
      return;
    }
    const worker = this.workerFor(cycle);
    if (worker) return; // Reconciliation owns live workers, including a publication currently awaiting I/O.
    // A persisted starting phase without its owning worker is unknown, even in an older ledger
    // or after a crash between pause and cleanup. A restart/board move supplies no cleanup proof.
    if (cycle.invocation?.phase === "starting" && !cycle.invocation.startupUncertain) {
      cycle.invocation.startupUncertain = true;
      this.ledger.checkpoint(cycle);
    }
    if (terminalIssue(config, issue)) {
      const wasTerminal = cycle.terminal;
      cycle.terminal = true;
      if (cycle.pending) this.ledger.complete(cycle, true);
      if (cycle.invocation && !cycle.invocation.startupUncertain) cycle.invocation.phase = "finished";
      this.ledger.observe(cycle, issue);
      this.saveLedger();
      if (!wasTerminal && cleanupTerminal) await this.safeRemove(issue);
      return;
    }
    if (cycle.terminal) return;
    // Also cover a crash between persisting an orphan's inactive origin and its pause record.
    if (!cycle.waitingState && this.waiting(config, cycle.lastState)) cycle.waitingState = cycle.lastState;
    if (cycle.pending) {
      if (!isRoutable(config, issue)) return; // Accepted work is not permission to publish after human takeover.
      if (cycle.halted) this.ledger.complete(cycle, true);
      else {
        const completed = await this.resumeHandoff(issue, cycle, tracker, config);
        if (!completed) return;
        // Publication may have moved the card; never apply the pre-publication snapshot afterward.
        return;
      }
    }
    const invocation = cycle.invocation;
    if (invocation && (invocation.startupUncertain || invocation.phase !== "finished") && !cycle.halted) {
      this.markHalted(issue, cycle, invocation.startupUncertain ? `startup_uncertain: ${startupRecovery(config.language)}` : localize(config.language, "interrupted_session", "会话已中断 (interrupted_session)"));
      await this.reportHalt(issue, cycle);
      return;
    }
    if (this.same(issue.state, config.tracker.startState) && cycle.waitingState && this.waiting(config, cycle.waitingState)) {
      if (invocation?.startupUncertain || invocation?.phase === "starting") return;
      // Preserve the observed waiting edge while fenced: the same Todo snapshot may authorize
      // after a live runner's positive cleanup acknowledgement, never merely after restart.
      if (invocation) invocation.phase = "finished";
      this.ledger.checkpoint(cycle);
      this.ledger.authorize(issue, config.agent.maxSessions, new Date(this.now()));
      return;
    }
    if (cycle.halted) {
      if (this.waiting(config, issue.state)) cycle.waitingState = issue.state;
      if (isActiveState(config, issue.state) && this.same(issue.state, cycle.halted.state)) await this.reportHalt(issue, cycle, null, false);
      else this.ledger.observe(cycle, issue);
      this.saveLedger();
      return;
    }
    if (cycle.waitingState && isActiveState(config, issue.state)) {
      if (cycle.returnedFor && config.mergeConflicts && this.same(issue.state, config.mergeConflicts.returnState)) {
        cycle.waitingState = null; // A lost successful conflict-return response; keep allowance and streak.
      } else {
        this.markHalted(issue, cycle, localize(config.language, "Unexpected transition from a waiting column; return to the start column to authorize work.",
          "卡片从等待列发生了非预期转换，请返回开始列以授权工作。"));
        await this.reportHalt(issue, cycle);
        return;
      }
    } else if (this.same(issue.state, config.tracker.startState) && !this.same(cycle.lastState, config.tracker.startState)) {
      this.markHalted(issue, cycle, localize(config.language, "Running -> Todo is not a new authorization; first wait in the blocked column.",
        "从运行状态直接返回开始列不构成新授权，请先在阻塞列等待。"));
      await this.reportHalt(issue, cycle);
      return;
    }
    if (this.waiting(config, issue.state)) {
      if (!this.same(cycle.lastState, issue.state)) cycle.returnedFor = null;
      cycle.waitingState = issue.state;
    }
    this.ledger.observe(cycle, issue);
    this.saveLedger();
  }

  /** A saved Todo authorization is moved to working before any workspace or SDK startup. */
  private async admit(issue: Issue, config: ServiceConfig, tracker: TrackerAdapter): Promise<Issue | null> {
    if (this.stopped || this.unidentified.has(issue.id)) return null;
    const cycle = this.ledger.get(issue.id);
    if (terminalIssue(config, issue) || !cycle || cycle.halted || cycle.terminal || cycle.pending || cycle.waitingState || cycle.invocation?.startupUncertain ||
      !this.same(cycle.lastState, issue.state) || this.workerFor(cycle)) return null;
    const reason = runLimitReached(cycle, config.language);
    if (!reason) {
      if (!this.same(issue.state, config.tracker.startState)) return issue;
      if (!tracker.moveIssue) throw new Error("tracker cannot take over the start column");
      try {
        const current = (await tracker.fetchIssuesByIds([issue.id]))[0];
        if (!current || issueControlKey(current) !== cycle.key || terminalIssue(config, current) || !this.same(current.state, config.tracker.startState) || !isRoutable(config, current)) return null;
        if (this.stopped) return null;
        await tracker.moveIssue(current, config.tracker.workingState);
        const moved = { ...current, state: config.tracker.workingState };
        this.ledger.observe(cycle, moved);
        return moved;
      } catch (error) {
        this.checkLedgerFailure(error);
        this.log.warn("start takeover incomplete; will reconcile", { issue_id: issue.id, error: (error as Error).message });
        return null;
      }
    }
    this.markHalted(issue, cycle, reason);
    await this.reportHalt(issue, cycle);
    return null;
  }

  private markHalted(issue: Issue, cycle: RunCycle, reason: string): void {
    this.ledger.pause(cycle, reason, issue.state, new Date(this.now()));
    this.log.warn("issue halted", {
      issue_id: issue.id, issue_identifier: issue.identifier, reason, sessions: cycle.sessions, ai_credits: credits(cycle.aiCredits),
    });
  }

  /** Tells people on the issue why work stopped, and moves the card out of the active states if the tracker can. */
  private async reportHalt(issue: Issue, cycle: RunCycle, usage: string | null = null, notify = true, language: Language = this.trackerConfig!.language): Promise<void> {
    const tracker = this.tracker;
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    let moved: string | null = null;
    try {
      const current = (await tracker?.fetchIssuesByIds([cycle.itemId]))?.[0];
      if (current && issueControlKey(current) === cycle.key) {
        if (terminalIssue(this.trackerConfig!, current)) {
          await this.observeIssue(current, this.trackerConfig!, tracker!);
          return;
        }
        if (this.same(current.state, issue.state) && isActiveState(this.trackerConfig!, current.state)) moved = (await tracker?.blockIssue?.(current)) ?? null;
        else if (this.waiting(this.trackerConfig!, current.state)) moved = current.state;
      }
    } catch (error) {
      log.warn("could not move halted issue", { error: (error as Error).message });
    }
    if (moved && cycle.halted) {
      cycle.halted.state = moved;
      cycle.waitingState = moved;
      cycle.lastState = moved;
    }
    this.saveLedger();
    if (!notify) return;
    const l = (en: string, zh: string) => localize(language, en, zh);
    const recovery = cycle.invocation?.startupUncertain
      ? `${startupRecovery(language)}${l(". A restart or board move alone cannot release this pause.", "。仅重启或移动卡片无法解除此暂停。")}`
      : l(`Resolve the cause, then move the card from a waiting column to "${this.trackerConfig!.tracker.startState}" to authorize a new run.`,
        `请解决原因，再将卡片从等待列移至 "${this.trackerConfig!.tracker.startState}" 以授权新一轮运行。`);
    const next = `${moved ? l(`The card was moved to "${moved}". `, `卡片已移至 "${moved}"。`) : ""}${recovery}`;
    const body = `**${l("symphony-copilot stopped working on this issue.", "symphony-copilot 已停止处理此 issue。")}** ${cycle.halted?.reason ?? ""}\n\n`
      + l(`This run used ${cycle.sessions} session(s). ${next}`, `本次运行已使用 ${cycle.sessions} 次会话。${next}`)
      + (usage ? `\n\n${usage}` : "");
    try {
      await tracker?.commentOnIssue?.(issue, body);
    } catch (error) {
      log.warn("could not comment on halted issue", { error: (error as Error).message });
    }
  }

  /** Moves waiting cards whose pull request no longer merges back to the implementer; returns them in their new state. */
  private async returnConflicted(waiting: Issue[], config: ServiceConfig, tracker: TrackerAdapter): Promise<Issue[]> {
    const settings = config.mergeConflicts;
    const eligible = waiting.filter((issue) => {
      const c = this.ledger.get(issue.id);
      return settings?.states.some((s) => this.same(s, issue.state)) && !terminalIssue(config, issue) && isRoutable(config, issue) && !this.claimed.has(issue.id) &&
        c && !this.workerFor(c) && !c.halted && !c.terminal && !c.pending && !c.invocation?.startupUncertain && !!c.waitingState && !runLimitReached(c);
    });
    if (!settings || eligible.length === 0 || !tracker.findMergeConflicts || !tracker.moveIssue) return [];
    let conflicts: MergeConflict[];
    try {
      conflicts = await tracker.findMergeConflicts(eligible);
    } catch (error) {
      this.log.warn("merge conflict check failed", { error: (error as Error).message });
      return [];
    }
    const returned: Issue[] = [];
    for (const { issue, pullRequest: pr } of conflicts) {
      const cycle = this.ledger.get(issue.id)!;
      const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
      const fields = { pull_request: pr.url, from: issue.state, to: settings.returnState };
      if (this.deps.dryRun) {
        log.info("dry run: would return for merge conflict", fields);
        continue;
      }
      try {
        const current = (await tracker.fetchIssuesByIds([issue.id]))[0];
        if (!current || issueControlKey(current) !== cycle.key || terminalIssue(config, current) || !this.same(current.state, issue.state) || this.stopped) continue;
        // Durable intent before the external write. A lost reply must not create a fresh run.
        cycle.returnedFor = `merge conflict in PR #${pr.number}`;
        this.ledger.checkpoint(cycle);
        await tracker.moveIssue(issue, settings.returnState);
      } catch (error) {
        this.checkLedgerFailure(error);
        log.warn("could not return issue with merge conflict", { ...fields, error: (error as Error).message });
        continue;
      }
      cycle.waitingState = null;
      cycle.lastState = settings.returnState;
      this.saveLedger();
      log.info("returned for merge conflict", fields);
      const label = config.tracker.requiredLabels[0];
      const body = localize(config.language, `**symphony-copilot: [PR #${pr.number}](${pr.url}) has merge conflicts with \`${pr.baseBranch}\`.** `
        + `The card was moved from "${issue.state}" to "${settings.returnState}" ahead of other work. The agent will merge \`${pr.baseBranch}\` into the branch, resolve the conflicts, rerun the checks and submit it for review again.`
        + (label ? ` To resolve conflicts yourself instead, remove the "${label}" label while the card waits for you.` : ""),
        `**symphony-copilot：[PR #${pr.number}](${pr.url}) 与 \`${pr.baseBranch}\` 存在合并冲突。** `
        + `卡片已从 "${issue.state}" 移至 "${settings.returnState}"，将优先处理。agent 会将 \`${pr.baseBranch}\` 合并到工作分支、解决冲突、重新运行检查并再次提交审查。`
        + (label ? `如需自行解决冲突，请在卡片等待您处理时移除 "${label}" 标签。` : ""));
      try {
        await tracker.commentOnIssue?.(issue, body);
      } catch (error) {
        log.warn("could not comment on returned issue", { error: (error as Error).message });
      }
      returned.push({ ...issue, state: settings.returnState });
    }
    return returned;
  }

  private saveLedger(): void {
    try {
      this.ledger.save();
    } catch (error) {
      this.checkLedgerFailure(error);
      throw error;
    }
  }

  private checkLedgerFailure(error: unknown): void {
    // Getters also fail after a critical write. Do not confuse identity/migration errors with I/O poison.
    try { this.ledger.records(); } catch (failure) {
      this.ledgerFailure = (failure as Error).message;
      this.stopped = true;
      if (this.tickTimer) clearTimeout(this.tickTimer);
      for (const retry of this.retries.values()) clearTimeout(retry.timer);
      this.retries.clear();
      for (const entry of this.running.values()) this.terminate(entry, false, "run ledger unavailable");
      this.log.error("scheduling stopped: run ledger unavailable", { error: String(error), path: this.ledger.path });
    }
  }

  private controlFor(entry: RunningEntry): AgentControl {
    const c = entry.cycle, id = entry.invocationId, authorization = entry.authorizationId;
    const bound = () => {
      if (this.ledger.get(c.key) !== c || c.authorizationId !== authorization || c.invocation?.id !== id) throw new Error("invocation no longer owns this authorization");
    };
    const assertActive = () => {
      bound();
      if (entry.exited || entry.startupUncertain || entry.abort.signal.aborted || c.halted || c.terminal || c.invocation?.phase === "finished") throw new Error("invocation is no longer active");
    };
    const checkpoint = () => {
      bound();
      if (c.pending?.issueMessage) entry.issueMessage = c.pending.issueMessage;
      try { this.ledger.checkpoint(c); } catch (error) { this.checkLedgerFailure(error); throw error; }
    };
    return {
      id, initialReview: !c.reworkReady, assertActive,
      accepted: () => !!c.allocations[id]?.resultId,
      onSessionCreated: async (sessionId) => {
        // Deliberately synchronous ledger work, not queued behind worker exit or tracker I/O.
        // Confirmation may arrive after timeout/shutdown; account once before denying further work.
        try {
          bound();
          entry.ordinal = this.ledger.confirm(c, id, sessionId);
          entry.threadId = sessionId;
          // Confirmation is accounting, not cleanup proof. Only startup_settled releases the fence.
          assertActive();
          return entry.ordinal;
        } catch (error) { this.checkLedgerFailure(error); throw error; }
      },
      accept: async (result, workspacePath) => {
        try {
          assertActive();
          if (!c.pending) {
            const current = (await entry.tracker.fetchIssuesByIds([c.itemId]))[0];
            assertActive();
            if (!current || issueControlKey(current) !== c.key || terminalIssue(entry.config, current) || !isActiveState(entry.config, current.state) ||
              this.same(current.state, entry.config.tracker.startState) || !isRoutable(entry.config, current) || roleFor(entry.config, current.state) !== entry.role) {
              throw new Error("card no longer belongs to this invocation's role");
            }
            this.ledger.observe(c, current);
            entry.issue = current;
          }
          return this.ledger.accept(c, id, result, workspacePath, entry.config);
        } catch (error) { this.checkLedgerFailure(error); throw error; }
      },
      checkpoint,
      finish: (stale = false) => {
        assertActive();
        if (c.pending?.issueMessage) entry.issueMessage = c.pending.issueMessage;
        if (!stale && c.pending?.waitingState) c.returnedFor = null;
        try { this.ledger.complete(c, stale); }
        catch (error) { this.checkLedgerFailure(error); throw error; }
      },
      onIssueMessage: (message) => { assertActive(); entry.issueMessage = message; },
    };
  }

  /** Only the host resumes publication after a worker exits. No semantic/model retry here. */
  private async resumeHandoff(issue: Issue, cycle: RunCycle, tracker: TrackerAdapter, config: ServiceConfig, entry?: RunningEntry): Promise<boolean> {
    const pending = cycle.pending;
    if (!pending || !tracker.publishHandoff) return !pending;
    const authorization = cycle.authorizationId;
    const assertActive = () => {
      if (this.stopped || cycle.authorizationId !== authorization || cycle.pending !== pending || cycle.halted || cycle.terminal || entry?.termination) {
        throw new Error("handoff no longer owns this authorization");
      }
    };
    try {
      assertActive();
      // Covers polls, restart, retry timers and immediate worker-exit recovery. Never trust
      // the dispatch snapshot (or a failed refresh); the adapter rechecks again before writes.
      const current = (await tracker.fetchIssuesByIds([cycle.itemId])).find((i) => i.id === cycle.itemId);
      assertActive();
      if (!current || issueControlKey(current) !== cycle.key || terminalIssue(config, current) || !isRoutable(config, current)) return false;
      const result = await tracker.publishHandoff(current, pending, () => {
        assertActive();
        this.ledger.checkpoint(cycle);
        if (entry && pending.issueMessage) entry.issueMessage = pending.issueMessage;
      }, assertActive);
      assertActive();
      if (entry && pending.issueMessage) entry.issueMessage = pending.issueMessage;
      if (!result.stale && pending.waitingState) cycle.returnedFor = null;
      this.ledger.complete(cycle, result.stale);
      return true;
    } catch (error) {
      this.checkLedgerFailure(error);
      this.log.warn("handoff publication incomplete; host will retry", { issue_id: issue.id, error: (error as Error).message });
      return false;
    }
  }

  private dispatch(issue: Issue, attempt: number | null, workflow: EffectiveWorkflow, tracker: TrackerAdapter): void {
    if (this.stopped) return;
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const abort = new AbortController();
    const role = roleFor(workflow.config, issue.state);
    const cycle = this.ledger.get(issue.id)!;
    const invocation = this.ledger.begin(cycle, role);
    const entry: RunningEntry = {
      issue, role, abort, attempt, startedAt: this.now(), threadId: null, turnCount: 0, lastEvent: null, lastEventAt: null, lastMessage: null,
      tokens: { input: 0, output: 0, total: 0 }, lastReported: { input: 0, output: 0, total: 0 },
      cycle, authorizationId: cycle.authorizationId, invocationId: invocation.id, limit: cycle.limit, ordinal: null,
      issueMessage: null, config: workflow.config, tracker, startupPhase: "workspace_prepare", startupUncertain: false, exited: false,
      summary: null,
      termination: null, stalled: false,
      done: Promise.resolve(),
    };
    const retry = this.retries.get(issue.id);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(issue.id);
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    log.info("dispatching", { attempt, state: issue.state, role });
    const reviewRound = (entry.cycle?.reviewRounds ?? 0) + 1;
    entry.done = Promise.resolve()
      .then(() => this.deps.runWorker({ issue, attempt, role, reviewRound, control: this.controlFor(entry), workflow, tracker, signal: abort.signal, log, onUpdate: (u) => this.onUpdate(entry, u) }))
      .then(() => this.serial(() => this.onWorkerExit(entry, null)), (error: Error) => this.serial(() => this.onWorkerExit(entry, error)))
      .catch((error: Error) => { this.checkLedgerFailure(error); log.error("worker exit handling failed", { error: error.message }); });
  }

  private onUpdate(entry: RunningEntry, update: AgentUpdate): void {
    // Usage retains the original allocation even after Todo reused the cycle object.
    try { this.recordUsage(entry, update); } catch (error) { this.checkLedgerFailure(error); }
    const cycle = entry.cycle;
    if (cycle.authorizationId === entry.authorizationId && cycle.invocation?.id === entry.invocationId) {
      try {
        if (update.event === "startup_uncertain") {
          entry.startupUncertain = true;
          cycle.invocation.startupUncertain = true;
          this.ledger.checkpoint(cycle);
        } else if (update.event === "startup_settled" && cycle.invocation.startupUncertain) {
          cycle.invocation.startupUncertain = false;
          if (entry.exited) cycle.invocation.phase = "finished";
          this.ledger.checkpoint(cycle);
        }
      } catch (error) { this.checkLedgerFailure(error); }
    }
    if (entry.exited) return;
    entry.lastEvent = update.event;
    entry.lastEventAt = update.timestamp.getTime();
    if (update.message !== undefined) entry.lastMessage = update.message;
    if (update.sessionId) entry.threadId = update.sessionId;
    if (update.turn && update.turn > entry.turnCount) entry.turnCount = update.turn;
    if (update.rateLimits !== undefined) this.rateLimits = update.rateLimits;
    if (update.summary) entry.summary = update.summary;
    if (update.tokens) {
      // Absolute per-session totals: only the growth since the last report counts (spec §13.5).
      for (const key of ["input", "output", "total"] as const) {
        const delta = update.tokens[key] - entry.lastReported[key];
        if (delta > 0) {
          entry.tokens[key] += delta;
          this.totals[key] += delta;
        }
        entry.lastReported[key] = update.tokens[key];
      }
    }
    if (update.event === "startup_phase") entry.startupPhase = update.message ?? entry.startupPhase;
    if (update.event === "session_started") entry.startupPhase = "agent_run";
    if (["session_started", "turn_started", "turn_completed"].includes(update.event)) {
      this.log.info(update.event, {
        issue_id: entry.issue.id, issue_identifier: entry.issue.identifier,
        session_id: entry.threadId ? `${entry.threadId}-${entry.turnCount}` : null, total_tokens: entry.tokens.total,
      });
    }
  }

  private recordUsage(entry: RunningEntry, update: AgentUpdate): void {
    const amount = update.aiCredits ?? update.summary?.aiCredits;
    if (amount !== undefined && entry.cycle.allocations[entry.invocationId]?.sessionId) this.ledger.recordUsage(entry.cycle, entry.invocationId, amount);
  }

  private async onWorkerExit(entry: RunningEntry, error: Error | null): Promise<void> {
    const id = entry.issue.id;
    if (this.running.get(id) !== entry) return;
    this.running.delete(id);
    this.claimed.delete(id);
    entry.exited = true;
    this.totals.secondsEnded += (this.now() - entry.startedAt) / 1000;
    const log = this.log.child({ issue_id: id, issue_identifier: entry.issue.identifier });
    const run = { run_sessions: entry.cycle?.sessions ?? 0, run_ai_credits: credits(entry.cycle?.aiCredits ?? 0) };
    const headline = this.sessionHeadline(entry, error);
    this.sessionReport(entry, headline);
    if (this.ledgerFailure) return;
    const cycle = entry.cycle;
    if (cycle.authorizationId !== entry.authorizationId || cycle.invocation?.id !== entry.invocationId) return;
    const accepted = !!cycle.allocations[entry.invocationId]?.resultId;
    if (accepted) {
      if (cycle.pending && !entry.termination && !this.stopped) await this.resumeHandoff(entry.issue, cycle, entry.tracker, entry.config, entry);
      await this.reportSession(entry);
      if (entry.termination?.cleanup) await this.safeRemove(entry.issue);
      if (!cycle.pending && !cycle.halted && !cycle.terminal && !entry.termination && !this.stopped) this.scheduleRetry(entry.issue, 1, null, CONTINUATION_DELAY_MS);
      return;
    }
    if (!cycle.invocation.startupUncertain) {
      cycle.invocation.phase = "finished";
      this.ledger.checkpoint(cycle);
    }
    if (entry.termination) {
      log.info("worker stopped by reconciliation", { reason: entry.termination.reason, cleanup: entry.termination.cleanup, ...run });
      await this.reportSession(entry);
      if (entry.termination.cleanup) await this.safeRemove(entry.issue);
      return;
    }
    if (this.stopped) {
      log.info("worker finished during shutdown", { error: error?.message ?? null, ...run });
      await this.reportSession(entry);
      return;
    }
    if (!cycle.invocation.sessionId || entry.startupUncertain) {
      const reason = `${entry.startupUncertain ? "startup_uncertain" : "startup_failed"} (${entry.startupPhase}): ${error?.message ?? localize(entry.config.language, "worker ended before SDK session creation", "工作进程在 SDK 会话创建前结束")}`;
      this.markHalted(entry.issue, cycle, reason + (cycle.invocation.startupUncertain ? `. ${startupRecovery(entry.config.language)}.` : ""));
      await this.reportHalt(entry.issue, cycle, this.footer(entry), true, entry.config.language);
      return;
    }
    if (!error && !entry.stalled) {
      log.info("worker completed; continuation check scheduled", run);
      this.scheduleRetry(entry.issue, 1, null, CONTINUATION_DELAY_MS);
      await this.reportSession(entry);
      return;
    }
    const attempt = (entry.attempt ?? 0) + 1;
    const reason = entry.stalled ? "stalled" : error!.message;
    log.warn("worker failed; retrying", { attempt, error: reason, ...run });
    this.scheduleRetry(entry.issue, attempt, `worker exited: ${reason}`);
    const body = localize(entry.config.language, `**symphony-copilot: session failed.** Stage: ${entry.startupPhase}; outcome: ${reason}. `
      + `The task may retry using the remaining allowance (${cycle.sessions}/${cycle.limit}); stop the service to troubleshoot if human action is needed.`,
      `**symphony-copilot：会话失败。** 阶段：${entry.startupPhase}；结果：${reason}。`
      + `任务可能使用剩余额度重试（已使用 ${cycle.sessions}/${cycle.limit}）；如需人工排查，请停止服务。`);
    try { await entry.tracker.commentOnIssue?.(entry.issue, body + (this.footer(entry) ? `\n\n${this.footer(entry)}` : "")); }
    catch (failure) { log.warn("could not report session failure", { error: (failure as Error).message }); }
  }

  private sessionHeadline(entry: RunningEntry, error: Error | null): string {
    if (entry.termination?.state) return `card now "${entry.termination.state}"`;
    if (entry.termination) return `stopped: ${entry.termination.reason}`;
    if (error || entry.stalled) return `failed: ${entry.stalled ? "stalled" : truncate(error!.message, 200)}`;
    const state = entry.summary?.finalState ?? entry.issue.state;
    const config = this.trackerConfig;
    return config && isActiveState(config, state) ? `card still "${state}"` : `card now "${state}"`;
  }

  /** Detailed accounting remains in the log, never a separate issue usage report. */
  private sessionReport(entry: RunningEntry, headline: string): void {
    const s = entry.summary;
    const config = this.trackerConfig;
    if (!s || !config) return;
    const elapsed = this.now() - entry.startedAt;
    this.log.info("session summary", {
      issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, session_id: s.sessionId, outcome: headline,
      models: s.models.map((m) => `${m.model}:${m.requests}`).join(","), turns: s.turns, ai_credits: credits(s.aiCredits),
      run_sessions: entry.cycle?.sessions ?? 0, run_ai_credits: credits(entry.cycle?.aiCredits ?? 0),
      input_tokens: s.inputTokens, output_tokens: s.outputTokens, premium_requests: s.premiumRequests, seconds: Math.round(elapsed / 1000),
      code: s.code, total_ai_credits: entry.cycle.totalAiCredits,
    });
  }

  private footer(entry: RunningEntry): string | null {
    return entry.config.agent.usageComments && entry.summary ? formatUsageFooter(entry.summary, entry.ordinal, entry.limit, entry.config.language) : null;
  }

  private async reportSession(entry: RunningEntry): Promise<void> {
    const footer = this.footer(entry);
    if (entry.config.agent.usageComments && !footer) {
      this.log.info("usage footer skipped: final usage or actual model unavailable", { issue_id: entry.issue.id, invocation_id: entry.invocationId });
    }
    if (!footer || !entry.issueMessage || !entry.tracker.updateUsageFooter) return;
    try {
      const current = (await entry.tracker.fetchIssuesByIds([entry.cycle.itemId])).find((i) => i.id === entry.cycle.itemId);
      if (!current || issueControlKey(current) !== entry.cycle.key || terminalIssue(entry.config, current) || !isRoutable(entry.config, current)) return;
      await entry.tracker.updateUsageFooter(current, entry.issueMessage, entry.invocationId, footer);
    } catch (error) {
      this.log.warn("could not update usage footer", { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, error: (error as Error).message });
    }
  }

  // ---- retries ----

  private scheduleRetry(issue: Issue, attempt: number, error: string | null, delayMs?: number): void {
    if (this.stopped) return;
    const existing = this.retries.get(issue.id);
    if (existing) clearTimeout(existing.timer);
    const maxBackoff = this.trackerConfig?.agent.maxRetryBackoffMs ?? 300_000;
    const delay = delayMs ?? retryDelayMs(attempt, maxBackoff);
    const timer = setTimeout(() => {
      void this.serial(() => this.onRetryTimer(issue.id))
        .catch((error: Error) => { this.checkLedgerFailure(error); this.log.error("retry handling failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: error.message }); });
    }, delay);
    this.retries.set(issue.id, { issueId: issue.id, identifier: issue.identifier, url: issue.url, attempt, dueAt: this.now() + delay, timer, error });
    this.claimed.add(issue.id);
  }

  private async onRetryTimer(id: string): Promise<void> {
    const retry = this.retries.get(id);
    if (!retry || this.stopped) return;
    this.retries.delete(id);
    const log = this.log.child({ issue_id: id, issue_identifier: retry.identifier });
    const workflow = this.deps.refreshWorkflow();
    const config = workflow.config;
    const stub = { id, identifier: retry.identifier, url: retry.url } as Issue;
    let tracker: TrackerAdapter;
    let issues: Issue[];
    try {
      tracker = this.trackerFor(config);
      issues = await tracker.fetchIssuesByIds([id]);
    } catch (error) {
      log.warn("retry refresh failed", { error: (error as Error).message });
      this.scheduleRetry(stub, retry.attempt + 1, "retry refresh failed");
      return;
    }
    const issue = issues.find((i) => i.id === id);
    if (!issue) {
      this.claimed.delete(id);
      log.info("claim released: issue no longer visible");
      return;
    }
    await this.observeIssue(issue, config, tracker);
    if (terminalIssue(config, issue)) {
      this.claimed.delete(id);
      log.info("claim released: issue is terminal", { state: issue.state });
      return;
    }
    if (!isActiveState(config, issue.state) || !isRoutable(config, issue)) {
      this.claimed.delete(id);
      log.info("claim released: issue not active or not routable", { state: issue.state });
      return;
    }
    const admitted = await this.admit(issue, config, tracker);
    if (!admitted) {
      this.claimed.delete(id);
      log.info("claim released: run limits reached");
      return;
    }
    const problem = this.preflight(workflow);
    if (problem || !this.hasSlot(config, admitted)) {
      this.scheduleRetry(issue, retry.attempt + 1, problem ?? "no available orchestrator slots");
      return;
    }
    this.dispatch(admitted, retry.attempt, workflow, tracker);
  }

  // ---- reconciliation ----

  private async reconcile(config: ServiceConfig, tracker: TrackerAdapter): Promise<void> {
    const now = this.now();
    if (config.copilot.stallTimeoutMs > 0) {
      for (const entry of this.running.values()) {
        const since = entry.lastEventAt ?? entry.startedAt;
        if (!entry.termination && !entry.stalled && now - since > config.copilot.stallTimeoutMs) {
          entry.stalled = true;
          this.log.warn("worker stalled; stopping", { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, idle_ms: now - since });
          entry.abort.abort("stalled");
        }
      }
    }
    const checked = [...this.running.values()].filter((e) => !e.termination && !e.stalled);
    if (checked.length === 0) return;
    const revisions = new Map(checked.map((e) => [e, `${e.cycle.lastState}:${e.cycle.invocation?.phase}:${e.cycle.allocations[e.invocationId]?.resultId}`]));
    let refreshed: Issue[];
    try {
      refreshed = await tracker.fetchIssuesByIds(checked.map((e) => e.issue.id));
    } catch (error) {
      this.log.warn("state refresh failed; keeping workers", { error: (error as Error).message });
      return;
    }
    const seen = new Set<string>();
    for (const issue of refreshed) {
      seen.add(issue.id);
      const entry = this.running.get(issue.id);
      // Only act on the worker this read was made for, never on one started since.
      if (!entry || !checked.includes(entry)) continue;
      const cycle = entry.cycle;
      // A tool can accept/finish while this poll awaits I/O. Its older snapshot cannot undo that handoff.
      if (!terminalIssue(config, issue) && revisions.get(entry) !== `${cycle.lastState}:${cycle.invocation?.phase}:${cycle.allocations[entry.invocationId]?.resultId}`) continue;
      if (terminalIssue(config, issue)) {
        cycle.terminal = true;
        if (cycle.pending) this.ledger.complete(cycle, true);
        this.ledger.observe(cycle, issue);
        this.saveLedger();
        entry.issue = issue; // Cleanup needs the native closure snapshot, not the dispatch snapshot.
        this.terminate(entry, true, `issue moved to ${issue.state}`, issue.state);
      }
      else if (isActiveState(config, issue.state) && isRoutable(config, issue)) {
        if (cycle.pending && [cycle.pending.sourceState, cycle.pending.targetState].some((s) => this.same(s, issue.state))) continue;
        if (this.same(issue.state, config.tracker.startState)) {
          this.markHalted(issue, cycle, localize(config.language, "Running -> Todo is not a new authorization", "从运行状态直接返回开始列不构成新授权"));
          this.terminate(entry, false, "unexpected start-column move", issue.state);
          continue;
        }
        this.ledger.observe(cycle, issue);
        // Moving between implementation and review hands the card to a fresh session in the other role.
        if (roleFor(config, issue.state) !== entry.role) this.terminate(entry, false, `issue moved to ${issue.state}`, issue.state);
        else entry.issue = issue;
      } else {
        if (cycle.pending && this.same(cycle.pending.targetState, issue.state) && isRoutable(config, issue)) continue;
        if (this.waiting(config, issue.state)) cycle.waitingState = issue.state;
        this.ledger.observe(cycle, issue);
        this.saveLedger();
        this.terminate(entry, false, `issue is ${issue.state}${isRoutable(config, issue) ? "" : " and not routable"}`, issue.state);
      }
    }
    for (const entry of checked) {
      if (this.running.get(entry.issue.id) === entry && !seen.has(entry.issue.id)) this.terminate(entry, false, "issue no longer visible");
    }
  }

  private terminate(entry: RunningEntry, cleanup: boolean, reason: string, state?: string): void {
    if (entry.termination) return;
    entry.termination = { cleanup, reason, state };
    this.log.info("stopping worker", { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, reason, cleanup });
    entry.abort.abort(reason);
  }

  private async startupCleanup(config: ServiceConfig, tracker: TrackerAdapter): Promise<void> {
    let terminal: Issue[];
    try {
      terminal = await tracker.fetchIssuesByStates(config.tracker.terminalStates);
    } catch (error) {
      this.log.warn("startup cleanup skipped: terminal fetch failed", { error: (error as Error).message });
      return;
    }
    if (this.deps.dryRun) {
      this.log.info("dry run: skipping startup workspace cleanup", { terminal_issues: terminal.length });
      return;
    }
    for (const issue of terminal) {
      if (!terminalIssue(config, issue)) continue;
      await this.observeIssue(issue, config, tracker, false);
      await this.safeRemove(issue);
    }
  }

  private async safeRemove(issue: Issue): Promise<void> {
    try {
      if (!this.tracker || !this.trackerConfig) throw new Error("no tracker configured");
      await this.deps.removeWorkspace(this.trackerConfig, issue, this.tracker);
    } catch (error) {
      this.log.warn("workspace cleanup failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: (error as Error).message });
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.stopped) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delayMs);
  }
}
