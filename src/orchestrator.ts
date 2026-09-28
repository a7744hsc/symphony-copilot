import { existsSync } from "node:fs";
import { isActiveState, isRoutable, isTerminalState, roleFor, type Role, type ServiceConfig } from "./config.ts";
import { RunLedger, type RunCycle } from "./ledger.ts";
import { truncate, type Logger } from "./log.ts";
import type { AgentUpdate, SessionSummary, TokenTotals } from "./runner.ts";
import type { TrackerAdapter } from "./tracker/index.ts";
import { normalizeState, type Issue } from "./types.ts";
import type { EffectiveWorkflow } from "./workflow.ts";

export interface WorkerParams {
  issue: Issue;
  attempt: number | null;
  /** Decided by the card's state at dispatch; the worker ends when the card moves to the other role. */
  role: Role;
  /** 1-based review round for the reviewer. */
  reviewRound: number;
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
  cycle: RunCycle | null;
  lastReportedCredits: number;
  summary: SessionSummary | null;
  /** Set when the orchestrator stops the worker because the run hit a limit. */
  halt: string | null;
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

export function sortForDispatch(issues: Issue[]): Issue[] {
  const bucket = (p: number | null) => (p !== null && p >= 1 && p <= 4 ? p : 5);
  return [...issues].sort((a, b) =>
    bucket(a.priority) - bucket(b.priority)
    || (a.createdAt?.getTime() ?? Infinity) - (b.createdAt?.getTime() ?? Infinity)
    || a.identifier.localeCompare(b.identifier));
}

export function retryDelayMs(attempt: number, maxBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxBackoffMs);
}

const credits = (value: number) => Number(value.toFixed(2));

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Markdown usage report for one session, posted on the issue. */
export function formatUsageReport(s: SessionSummary, cycle: RunCycle | null, config: ServiceConfig, headline: string, elapsedMs: number, role: Role = "implement"): string {
  const models = s.models.length > 0 ? s.models.map((m) => `${m.model} (${m.requests} calls)`).join(", ") : "unknown";
  const budget = config.copilot.maxAiCreditsPerIssue;
  const run = cycle ? ` · ${credits(cycle.aiCredits)}${budget !== null ? ` of ${budget}` : ""} this run` : "";
  const code = s.code ? ` · Code: +${s.code.linesAdded} −${s.code.linesRemoved} in ${s.code.files} files` : "";
  const premium = s.premiumRequests !== null ? ` · Premium requests: ${s.premiumRequests}` : "";
  return [
    `**symphony-copilot · ${role === "review" ? "review" : "implementation"} · session ${cycle?.sessions ?? "?"} of ${config.agent.maxSessions} · ${headline}**`,
    "",
    `- Model: ${models}`,
    `- Turns: ${s.turns} of ${config.agent.maxTurns} · Time: ${formatDuration(elapsedMs)}${code}`,
    `- AI credits: ${credits(s.aiCredits)} this session${run}`,
    `- Tokens: ${compact(s.inputTokens)} in · ${compact(s.outputTokens)} out${premium}`,
  ].join("\n");
}

/** Why this run may not start another session, or null. */
export function runLimitReached(cycle: RunCycle, config: ServiceConfig): string | null {
  if (cycle.sessions >= config.agent.maxSessions) {
    return `It used all ${config.agent.maxSessions} sessions allowed per run (agent.max_sessions) without handing the issue off.`;
  }
  const budget = config.copilot.maxAiCreditsPerIssue;
  if (budget !== null && cycle.aiCredits >= budget) {
    return `It reached this run's AI credit budget: ${credits(cycle.aiCredits)} of ${budget} (copilot.max_ai_credits_per_issue).`;
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
  private readonly completed = new Set<string>();
  private readonly totals = { input: 0, output: 0, total: 0, secondsEnded: 0 };
  private readonly ledger: RunLedger;
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
      try {
        candidates = await tracker.fetchIssuesByStates(config.tracker.activeStates);
      } catch (error) {
        this.log.error("candidate fetch failed", { error: (error as Error).message });
        return;
      }
      let dispatched = 0;
      if (!this.deps.dryRun) this.closeFinishedRuns(candidates);
      for (const issue of sortForDispatch(candidates)) {
        if (this.availableSlots(config) - (this.deps.dryRun ? dispatched : 0) <= 0) break;
        if (!this.shouldDispatch(issue, config)) continue;
        if (this.deps.dryRun) {
          const cycle = this.ledger.get(issue.id);
          const limit = cycle ? runLimitReached(cycle, config) : null;
          if (limit) {
            this.log.info("dry run: would halt", { issue_id: issue.id, issue_identifier: issue.identifier, reason: limit });
            continue;
          }
          dispatched++;
          this.log.info("dry run: would dispatch", { issue_id: issue.id, issue_identifier: issue.identifier, state: issue.state, priority: issue.priority, title: issue.title });
        } else if (await this.admit(issue, config)) {
          dispatched++;
          this.dispatch(issue, null, workflow, tracker);
        }
      }
      this.log.info("tick", { candidates: candidates.length, dispatched, running: this.running.size, retrying: this.retries.size });
    } catch (error) {
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
      halted: this.ledger.issueIds().flatMap((id) => {
        const cycle = this.ledger.get(id)!;
        return cycle.halted ? [{ issue_id: id, issue_identifier: cycle.identifier, reason: cycle.halted.reason, at: cycle.halted.at }] : [];
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
    if (!isActiveState(config, issue.state) || !isRoutable(config, issue)) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.ledger.get(issue.id)?.halted) return false;
    return this.stateHasSlot(config, issue.state);
  }

  /** False when the issue's run has used up its limits; the issue is halted and reported. */
  private async admit(issue: Issue, config: ServiceConfig): Promise<boolean> {
    const cycle = this.ledger.get(issue.id);
    if (!cycle) return true;
    if (cycle.halted) return false;
    const reason = runLimitReached(cycle, config);
    if (!reason) return true;
    this.markHalted(issue, cycle, reason);
    await this.reportHalt(issue, cycle);
    return false;
  }

  private markHalted(issue: Issue, cycle: RunCycle, reason: string): void {
    cycle.halted = { reason, state: issue.state, at: new Date(this.now()).toISOString() };
    this.saveLedger();
    this.log.warn("issue halted", {
      issue_id: issue.id, issue_identifier: issue.identifier, reason, sessions: cycle.sessions, ai_credits: credits(cycle.aiCredits),
    });
  }

  /** Tells people on the issue why work stopped, and moves the card out of the active states if the tracker can. */
  private async reportHalt(issue: Issue, cycle: RunCycle, usage: string | null = null): Promise<void> {
    const tracker = this.tracker;
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    let moved: string | null = null;
    try {
      moved = (await tracker?.blockIssue?.(issue)) ?? null;
    } catch (error) {
      log.warn("could not move halted issue", { error: (error as Error).message });
    }
    if (moved && cycle.halted) {
      cycle.halted.state = moved;
    } else if (cycle.halted) {
      // The agent may have moved the card since the last poll; compare later polls against the live state.
      const fresh = await tracker?.fetchIssuesByIds([issue.id]).catch(() => []);
      if (fresh?.[0]) cycle.halted.state = fresh[0].state;
    }
    this.saveLedger();
    const next = moved
      ? `The card was moved to "${moved}". Move it back to an active column to start a new run with fresh limits.`
      : "Move the card to a different column (for example out of the active columns and back) to start a new run with fresh limits.";
    const body = `**symphony-copilot stopped working on this issue.** ${cycle.halted?.reason ?? ""}\n\n`
      + `This run used ${cycle.sessions} session(s) and ${credits(cycle.aiCredits)} AI credits. ${next}`
      + (usage ? `\n\n${usage}` : "");
    try {
      await tracker?.commentOnIssue?.(issue, body);
    } catch (error) {
      log.warn("could not comment on halted issue", { error: (error as Error).message });
    }
  }

  /** A run ends once its issue is seen outside the active states, or moved after being halted. */
  private closeFinishedRuns(candidates: Issue[]): void {
    const active = new Map(candidates.map((issue) => [issue.id, issue]));
    let changed = false;
    for (const id of this.ledger.issueIds()) {
      if (this.claimed.has(id)) continue;
      const cycle = this.ledger.get(id)!;
      const issue = active.get(id);
      const movedAfterHalt = cycle.halted !== null && issue !== undefined && normalizeState(issue.state) !== normalizeState(cycle.halted.state);
      if (issue && !movedAfterHalt) continue;
      this.ledger.close(id);
      changed = true;
      this.log.info("run closed", {
        issue_id: id, issue_identifier: cycle.identifier, state: issue?.state ?? "not active",
        sessions: cycle.sessions, ai_credits: credits(cycle.aiCredits), halted: cycle.halted?.reason ?? null,
      });
    }
    if (changed) this.saveLedger();
  }

  private saveLedger(): void {
    try {
      this.ledger.save();
    } catch (error) {
      this.log.error("run ledger save failed", { path: this.ledger.path, error: (error as Error).message });
    }
  }

  private dispatch(issue: Issue, attempt: number | null, workflow: EffectiveWorkflow, tracker: TrackerAdapter): void {
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const abort = new AbortController();
    const role = roleFor(workflow.config, issue.state);
    const entry: RunningEntry = {
      issue, role, abort, attempt, startedAt: this.now(), threadId: null, turnCount: 0, lastEvent: null, lastEventAt: null, lastMessage: null,
      tokens: { input: 0, output: 0, total: 0 }, lastReported: { input: 0, output: 0, total: 0 },
      cycle: this.ledger.open(issue.id, issue.identifier, new Date(this.now())), lastReportedCredits: 0, summary: null, halt: null,
      termination: null, stalled: false,
      done: Promise.resolve(),
    };
    this.saveLedger();
    const retry = this.retries.get(issue.id);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(issue.id);
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    log.info("dispatching", { attempt, state: issue.state, role });
    const reviewRound = (entry.cycle?.reviewRounds ?? 0) + 1;
    entry.done = Promise.resolve()
      .then(() => this.deps.runWorker({ issue, attempt, role, reviewRound, workflow, tracker, signal: abort.signal, log, onUpdate: (u) => this.onUpdate(entry, u) }))
      .then(() => this.serial(() => this.onWorkerExit(entry, null)), (error: Error) => this.serial(() => this.onWorkerExit(entry, error)))
      .catch((error: Error) => log.error("worker exit handling failed", { error: error.message }));
  }

  private onUpdate(entry: RunningEntry, update: AgentUpdate): void {
    if (this.running.get(entry.issue.id) !== entry) return;
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
    if (entry.cycle) this.recordUsage(entry, update);
    if (["session_started", "turn_started", "turn_completed"].includes(update.event)) {
      this.log.info(update.event, {
        issue_id: entry.issue.id, issue_identifier: entry.issue.identifier,
        session_id: entry.threadId ? `${entry.threadId}-${entry.turnCount}` : null, total_tokens: entry.tokens.total,
      });
    }
  }

  private recordUsage(entry: RunningEntry, update: AgentUpdate): void {
    const cycle = entry.cycle!;
    let changed = false;
    if (update.event === "session_started") {
      cycle.sessions++;
      entry.lastReportedCredits = 0;
      changed = true;
    }
    if (update.event === "review_verdict") {
      cycle.reviewRounds++;
      changed = true;
    }
    if (update.aiCredits !== undefined && update.aiCredits > entry.lastReportedCredits) {
      cycle.aiCredits += update.aiCredits - entry.lastReportedCredits;
      entry.lastReportedCredits = update.aiCredits;
      changed = true;
    }
    if (!changed) return;
    this.saveLedger();
    const budget = this.trackerConfig?.copilot.maxAiCreditsPerIssue ?? null;
    if (budget !== null && cycle.aiCredits >= budget && !entry.halt && !entry.termination) {
      entry.halt = `It reached this run's AI credit budget: ${credits(cycle.aiCredits)} of ${budget} (copilot.max_ai_credits_per_issue).`;
      this.markHalted(entry.issue, cycle, entry.halt);
      this.terminate(entry, false, "AI credit budget reached");
    }
  }

  private async onWorkerExit(entry: RunningEntry, error: Error | null): Promise<void> {
    const id = entry.issue.id;
    if (this.running.get(id) !== entry) return;
    this.running.delete(id);
    this.totals.secondsEnded += (this.now() - entry.startedAt) / 1000;
    const log = this.log.child({ issue_id: id, issue_identifier: entry.issue.identifier });
    const run = { run_sessions: entry.cycle?.sessions ?? 0, run_ai_credits: credits(entry.cycle?.aiCredits ?? 0) };
    const headline = this.sessionHeadline(entry, error);
    if (entry.termination) {
      this.claimed.delete(id);
      log.info("worker stopped by reconciliation", { reason: entry.termination.reason, cleanup: entry.termination.cleanup, ...run });
      if (entry.halt && entry.cycle) await this.reportHalt(entry.issue, entry.cycle, this.sessionReport(entry, headline));
      else await this.reportSession(entry, headline);
      if (entry.termination.cleanup) await this.safeRemove(entry.issue);
      return;
    }
    if (this.stopped) {
      log.info("worker finished during shutdown", { error: error?.message ?? null, ...run });
      await this.reportSession(entry, headline);
      return;
    }
    if (!error && !entry.stalled) {
      this.completed.add(id);
      log.info("worker completed; continuation check scheduled", run);
      this.scheduleRetry(entry.issue, 1, null, CONTINUATION_DELAY_MS);
      await this.reportSession(entry, headline);
      return;
    }
    const attempt = (entry.attempt ?? 0) + 1;
    const reason = entry.stalled ? "stalled" : error!.message;
    log.warn("worker failed; retrying", { attempt, error: reason, ...run });
    this.scheduleRetry(entry.issue, attempt, `worker exited: ${reason}`);
    await this.reportSession(entry, headline);
  }

  private sessionHeadline(entry: RunningEntry, error: Error | null): string {
    if (entry.halt) return "stopped: run limit reached";
    if (entry.termination?.state) return `card now "${entry.termination.state}"`;
    if (entry.termination) return `stopped: ${entry.termination.reason}`;
    if (error || entry.stalled) return `failed: ${entry.stalled ? "stalled" : truncate(error!.message, 200)}`;
    const state = entry.summary?.finalState ?? entry.issue.state;
    const config = this.trackerConfig;
    return config && isActiveState(config, state) ? `card still "${state}"` : `card now "${state}"`;
  }

  /** Logs the session's usage and returns the issue comment for it, or null if no session started. */
  private sessionReport(entry: RunningEntry, headline: string): string | null {
    const s = entry.summary;
    const config = this.trackerConfig;
    if (!s || !config) return null;
    const elapsed = this.now() - entry.startedAt;
    this.log.info("session summary", {
      issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, session_id: s.sessionId, outcome: headline,
      models: s.models.map((m) => `${m.model}:${m.requests}`).join(","), turns: s.turns, ai_credits: credits(s.aiCredits),
      run_sessions: entry.cycle?.sessions ?? 0, run_ai_credits: credits(entry.cycle?.aiCredits ?? 0),
      input_tokens: s.inputTokens, output_tokens: s.outputTokens, premium_requests: s.premiumRequests, seconds: Math.round(elapsed / 1000),
    });
    return formatUsageReport(s, entry.cycle, config, headline, elapsed, entry.role);
  }

  private async reportSession(entry: RunningEntry, headline: string): Promise<void> {
    const report = this.sessionReport(entry, headline);
    if (!report || !this.trackerConfig?.agent.usageComments || !this.tracker?.commentOnIssue) return;
    try {
      await this.tracker.commentOnIssue(entry.issue, report);
    } catch (error) {
      this.log.warn("could not post usage comment", { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier, error: (error as Error).message });
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
        .catch((error: Error) => this.log.error("retry handling failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: error.message }));
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
    if (isTerminalState(config, issue.state)) {
      this.claimed.delete(id);
      log.info("claim released: issue is terminal", { state: issue.state });
      await this.safeRemove(issue);
      return;
    }
    if (!isActiveState(config, issue.state) || !isRoutable(config, issue)) {
      this.claimed.delete(id);
      log.info("claim released: issue not active or not routable", { state: issue.state });
      return;
    }
    if (!(await this.admit(issue, config))) {
      this.claimed.delete(id);
      log.info("claim released: run limits reached");
      return;
    }
    const problem = this.preflight(workflow);
    if (problem || !this.hasSlot(config, issue)) {
      this.scheduleRetry(issue, retry.attempt + 1, problem ?? "no available orchestrator slots");
      return;
    }
    this.dispatch(issue, retry.attempt, workflow, tracker);
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
      if (isTerminalState(config, issue.state)) this.terminate(entry, true, `issue moved to ${issue.state}`, issue.state);
      else if (isActiveState(config, issue.state) && isRoutable(config, issue)) {
        // Moving between implementation and review hands the card to a fresh session in the other role.
        if (roleFor(config, issue.state) !== entry.role) this.terminate(entry, false, `issue moved to ${issue.state}`, issue.state);
        else entry.issue = issue;
      } else this.terminate(entry, false, `issue is ${issue.state}${isRoutable(config, issue) ? "" : " and not routable"}`, issue.state);
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
    for (const issue of terminal) await this.safeRemove(issue);
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
