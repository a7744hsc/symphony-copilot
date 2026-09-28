import { existsSync } from "node:fs";
import { isActiveState, isRoutable, isTerminalState, type ServiceConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { AgentUpdate, TokenTotals } from "./runner.ts";
import type { TrackerAdapter } from "./tracker/index.ts";
import { normalizeState, type Issue } from "./types.ts";
import type { EffectiveWorkflow } from "./workflow.ts";

export interface WorkerParams {
  issue: Issue;
  attempt: number | null;
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
  /** Poll and log what would be dispatched, without workspaces or agents. */
  dryRun?: boolean;
}

interface RunningEntry {
  issue: Issue;
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
  termination: { cleanup: boolean; reason: string } | null;
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

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly running = new Map<string, RunningEntry>();
  private readonly claimed = new Set<string>();
  private readonly retries = new Map<string, RetryEntry>();
  private readonly completed = new Set<string>();
  private readonly totals = { input: 0, output: 0, total: 0, secondsEnded: 0 };
  private rateLimits: unknown = null;
  private tracker: TrackerAdapter | null = null;
  private trackerConfig: ServiceConfig | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
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

  /** One poll-and-dispatch cycle; exposed for `--once` and tests. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
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
      for (const issue of sortForDispatch(candidates)) {
        if (this.availableSlots(config) - (this.deps.dryRun ? dispatched : 0) <= 0) break;
        if (!this.shouldDispatch(issue, config)) continue;
        dispatched++;
        if (this.deps.dryRun) {
          this.log.info("dry run: would dispatch", { issue_id: issue.id, issue_identifier: issue.identifier, state: issue.state, priority: issue.priority, title: issue.title });
        } else {
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
      })),
      retrying: [...this.retries.values()].map((r) => ({
        issue_id: r.issueId, issue_identifier: r.identifier, issue_url: r.url, attempt: r.attempt, due_at: iso(r.dueAt), error: r.error,
      })),
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
    return this.stateHasSlot(config, issue.state);
  }

  private dispatch(issue: Issue, attempt: number | null, workflow: EffectiveWorkflow, tracker: TrackerAdapter): void {
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier });
    const abort = new AbortController();
    const entry: RunningEntry = {
      issue, abort, attempt, startedAt: this.now(), threadId: null, turnCount: 0, lastEvent: null, lastEventAt: null, lastMessage: null,
      tokens: { input: 0, output: 0, total: 0 }, lastReported: { input: 0, output: 0, total: 0 }, termination: null, stalled: false,
      done: Promise.resolve(),
    };
    const retry = this.retries.get(issue.id);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(issue.id);
    this.running.set(issue.id, entry);
    this.claimed.add(issue.id);
    log.info("dispatching", { attempt, state: issue.state });
    entry.done = Promise.resolve()
      .then(() => this.deps.runWorker({ issue, attempt, workflow, tracker, signal: abort.signal, log, onUpdate: (u) => this.onUpdate(entry, u) }))
      .then(() => this.onWorkerExit(entry, null), (error: Error) => this.onWorkerExit(entry, error));
  }

  private onUpdate(entry: RunningEntry, update: AgentUpdate): void {
    if (this.running.get(entry.issue.id) !== entry) return;
    entry.lastEvent = update.event;
    entry.lastEventAt = update.timestamp.getTime();
    if (update.message !== undefined) entry.lastMessage = update.message;
    if (update.sessionId) entry.threadId = update.sessionId;
    if (update.turn && update.turn > entry.turnCount) entry.turnCount = update.turn;
    if (update.rateLimits !== undefined) this.rateLimits = update.rateLimits;
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
    if (["session_started", "turn_started", "turn_completed"].includes(update.event)) {
      this.log.info(update.event, {
        issue_id: entry.issue.id, issue_identifier: entry.issue.identifier,
        session_id: entry.threadId ? `${entry.threadId}-${entry.turnCount}` : null, total_tokens: entry.tokens.total,
      });
    }
  }

  private async onWorkerExit(entry: RunningEntry, error: Error | null): Promise<void> {
    const id = entry.issue.id;
    if (this.running.get(id) !== entry) return;
    this.running.delete(id);
    this.totals.secondsEnded += (this.now() - entry.startedAt) / 1000;
    const log = this.log.child({ issue_id: id, issue_identifier: entry.issue.identifier });
    if (entry.termination) {
      this.claimed.delete(id);
      log.info("worker stopped by reconciliation", { reason: entry.termination.reason, cleanup: entry.termination.cleanup });
      if (entry.termination.cleanup) await this.safeRemove(entry.issue);
      return;
    }
    if (this.stopped) return;
    if (!error && !entry.stalled) {
      this.completed.add(id);
      log.info("worker completed; continuation check scheduled");
      this.scheduleRetry(entry.issue, 1, null, CONTINUATION_DELAY_MS);
      return;
    }
    const attempt = (entry.attempt ?? 0) + 1;
    const reason = entry.stalled ? "stalled" : error!.message;
    log.warn("worker failed; retrying", { attempt, error: reason });
    this.scheduleRetry(entry.issue, attempt, `worker exited: ${reason}`);
  }

  // ---- retries ----

  private scheduleRetry(issue: Issue, attempt: number, error: string | null, delayMs?: number): void {
    if (this.stopped) return;
    const existing = this.retries.get(issue.id);
    if (existing) clearTimeout(existing.timer);
    const maxBackoff = this.trackerConfig?.agent.maxRetryBackoffMs ?? 300_000;
    const delay = delayMs ?? retryDelayMs(attempt, maxBackoff);
    const timer = setTimeout(() => void this.onRetryTimer(issue.id), delay);
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
    const ids = [...this.running.values()].filter((e) => !e.termination && !e.stalled).map((e) => e.issue.id);
    if (ids.length === 0) return;
    let refreshed: Issue[];
    try {
      refreshed = await tracker.fetchIssuesByIds(ids);
    } catch (error) {
      this.log.warn("state refresh failed; keeping workers", { error: (error as Error).message });
      return;
    }
    const seen = new Set<string>();
    for (const issue of refreshed) {
      seen.add(issue.id);
      const entry = this.running.get(issue.id);
      if (!entry) continue;
      if (isTerminalState(config, issue.state)) this.terminate(entry, true, `issue moved to ${issue.state}`);
      else if (isActiveState(config, issue.state) && isRoutable(config, issue)) entry.issue = issue;
      else this.terminate(entry, false, `issue is ${issue.state}${isRoutable(config, issue) ? "" : " and not routable"}`);
    }
    for (const id of ids) {
      const entry = this.running.get(id);
      if (entry && !seen.has(id)) this.terminate(entry, false, "issue no longer visible");
    }
  }

  private terminate(entry: RunningEntry, cleanup: boolean, reason: string): void {
    if (entry.termination) return;
    entry.termination = { cleanup, reason };
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
