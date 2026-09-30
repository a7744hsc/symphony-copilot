import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LedgerError, RunLedger } from "../src/ledger.ts";
import type { AgentResult, PendingHandoff } from "../src/iteration.ts";
import { formatUsageFooter, Orchestrator, retryDelayMs, sortForDispatch, type WorkerParams } from "../src/orchestrator.ts";
import type { TrackerAdapter } from "../src/tracker/index.ts";
import { normalizeState, type Issue } from "../src/types.ts";
import { captureLog, flush, makeConfig, makeIssue, makeWorkflow } from "./helpers.ts";

class FakeTracker implements TrackerAdapter {
  readonly kind = "fake";
  readonly issues = new Map<string, Issue>();
  readonly comments: string[] = [];
  readonly footers: string[] = [];
  publicationFails = false;
  footerFails = false;
  moveFails: "before" | "after" | null = null;
  blockedState: string | null = "Blocked";
  refreshFails = false;
  /** Issue id -> number of its open pull request that conflicts with main. */
  readonly conflicts = new Map<string, number>();
  readonly conflictChecks: string[][] = [];
  /** When set, the next id fetch returns the states as they were when it was called, after this resolves. */
  gate: Promise<void> | null = null;
  add(...issues: Issue[]) {
    for (const issue of issues) this.issues.set(issue.id, issue);
  }
  set(id: string, patch: Partial<Issue>) {
    this.issues.set(id, { ...this.issues.get(id)!, ...patch });
  }
  async fetchIssuesByStates(states: string[]) {
    const wanted = new Set(states.map(normalizeState));
    return [...this.issues.values()].filter((i) => wanted.has(normalizeState(i.state)));
  }
  async fetchIssuesByIds(ids: string[]) {
    if (this.refreshFails) throw new Error("tracker down");
    const snapshot = ids.map((id) => this.issues.get(id)).filter((i): i is Issue => i !== undefined);
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    return snapshot;
  }
  agentTools() {
    return [];
  }
  secretEnvironmentNames() {
    return [];
  }
  async commentOnIssue(issue: Issue, body: string) {
    this.comments.push(`${issue.id}: ${body}`);
  }
  async blockIssue(issue: Issue) {
    if (this.blockedState) this.set(issue.id, { state: this.blockedState });
    return this.blockedState;
  }
  async findMergeConflicts(issues: Issue[]) {
    this.conflictChecks.push(issues.map((i) => i.id));
    return issues.flatMap((issue) => {
      const number = this.conflicts.get(issue.id);
      return number === undefined ? [] : [{ issue, pullRequest: { number, url: `https://example.test/pull/${number}`, baseBranch: "main" } }];
    });
  }
  async moveIssue(issue: Issue, state: string) {
    if (this.moveFails === "before") throw new Error("move failed");
    this.set(issue.id, { state });
    if (this.moveFails === "after") throw new Error("move response lost");
  }
  async publishHandoff(issue: Issue, p: PendingHandoff, checkpoint: () => void, assertActive: () => void) {
    assertActive();
    if (this.publicationFails) throw new Error("publication unavailable");
    if (![p.sourceState, p.targetState].includes(this.issues.get(issue.id)!.state)) return { stale: true };
    p.issueMessage ??= { id: `message-${p.id}`, url: null };
    checkpoint();
    this.set(issue.id, { state: p.targetState });
    p.statusApplied = true;
    checkpoint();
    return { stale: false };
  }
  async updateUsageFooter(_issue: Issue, _message: { id: string }, invocationId: string, footer: string) {
    if (this.footerFails) throw new Error("footer unavailable");
    this.footers.push(`${invocationId}: ${footer}`);
  }
}

interface WorkerCall {
  params: WorkerParams;
  resolve(): void;
  reject(error: Error): void;
  aborted: boolean;
}

function setup(t: TestContext, raw: Record<string, any> = {}, dryRun = false, ledger = new RunLedger(), startSessions = true) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const config = makeConfig({ polling: { interval_ms: 3_600_000 }, ...raw });
  const workflow = makeWorkflow(config);
  const tracker = new FakeTracker();
  const calls: WorkerCall[] = [];
  const removed: string[] = [];
  const removedIssues: Issue[] = [];
  const { log, lines } = captureLog();
  const orchestrator = new Orchestrator({
    log,
    dryRun,
    ledger,
    refreshWorkflow: () => workflow,
    workflowError: () => null,
    createTracker: () => tracker,
    removeWorkspace: async (_config, issue) => {
      removed.push(issue.identifier);
      removedIssues.push(issue);
    },
    runWorker: (params) => new Promise<void>((resolve, reject) => {
      const call: WorkerCall = { params, resolve, reject, aborted: false };
      params.signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(new Error(`aborted: ${params.signal.reason}`));
      });
      calls.push(call);
      if (startSessions) void params.control.onSessionCreated(`sess-${calls.length - 1}`).catch(reject);
    }),
  });
  const tick = async () => {
    await orchestrator.tick();
    await flush();
  };
  const advance = async (ms: number) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  const ids = () => calls.map((c) => c.params.issue.id);
  return { orchestrator, tracker, calls, removed, removedIssues, lines, tick, advance, ids, ledger, config };
}

function authorize(ledger: RunLedger, card: Issue, limit = 20) {
  return ledger.authorize(card, limit);
}

async function submit(s: ReturnType<typeof setup>, index: number, result: AgentResult) {
  const call = s.calls[index]!;
  const control = call.params.control;
  const pending = await control.accept(result, "/tmp/checkout");
  const outcome = await s.tracker.publishHandoff(call.params.issue, pending, control.checkpoint, control.assertActive);
  control.finish(outcome.stale);
  call.resolve();
  await flush();
}

const implementation: AgentResult = { kind: "implement", title: "Implementation", summary: "Complete evidence", head: "abc" };

const issue = (id: string, overrides: Partial<Issue> = {}) => makeIssue({ id, identifier: `GH-${id}`, ...overrides });

test("dispatch order is priority, then oldest, then identifier", () => {
  const sorted = sortForDispatch([
    issue("A", { priority: null, createdAt: new Date("2026-01-01") }),
    issue("B", { priority: 2, createdAt: new Date("2026-03-01") }),
    issue("C", { priority: 1, createdAt: new Date("2026-05-01") }),
    issue("D", { priority: 1, createdAt: new Date("2026-04-01") }),
    issue("E", { priority: 9, createdAt: new Date("2025-01-01") }),
    issue("F", { priority: 1, createdAt: new Date("2026-04-01") }),
  ]);
  assert.deepEqual(sorted.map((i) => i.id), ["D", "F", "C", "B", "E", "A"]);
  assert.deepEqual(sortForDispatch(sorted, (i) => i.id === "A").map((i) => i.id), ["A", "D", "F", "C", "B", "E"], "urgent issues jump the queue");
});

test("retry backoff doubles from 10 s and respects the cap", () => {
  assert.deepEqual([1, 2, 3, 6].map((a) => retryDelayMs(a, 300_000)), [10_000, 20_000, 40_000, 300_000]);
});

test("only eligible issues are dispatched, within the global limit", async (t) => {
  const s = setup(t, { agent: { max_concurrent_agents: 2 }, tracker: { required_labels: ["agent"] } });
  s.tracker.add(
    issue("A", { priority: 3 }),
    issue("B", { priority: 1 }),
    issue("C", { priority: 1, dispatchable: false }),
    issue("D", { priority: 1, labels: [] }),
    issue("E", { priority: 1, state: "Done" }),
    issue("F", { priority: 2 }),
  );
  await s.tick();
  assert.deepEqual(s.ids(), ["B", "F"]);
  await s.tick();
  assert.equal(s.calls.length, 2, "running and claimed issues are not dispatched twice");
});

test("per-state limits cap dispatch for that state", async (t) => {
  const s = setup(t, { agent: { max_concurrent_agents: 5, max_concurrent_agents_by_state: { "in progress": 1 } } });
  authorize(s.ledger, issue("A", { state: "In Progress" }));
  authorize(s.ledger, issue("B", { state: "In Progress" }));
  s.tracker.add(issue("A", { state: "In Progress" }), issue("B", { state: "In Progress" }), issue("C"));
  await s.tick();
  assert.deepEqual(s.ids().sort(), ["A"], "Todo takeover uses the working-column concurrency limit too");
});

test("a normal exit schedules a continuation check after 1 s with attempt 1", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  s.calls[0]!.resolve();
  await flush();
  const retry = s.orchestrator.snapshot().retrying[0]!;
  assert.equal(retry.attempt, 1);
  assert.equal(retry.error, null);
  await s.advance(999);
  assert.equal(s.calls.length, 1);
  await s.advance(1);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1]!.params.attempt, 1);

  s.tracker.set("A", { state: "Human Review" });
  s.calls[1]!.resolve();
  await flush();
  await s.advance(1_000);
  assert.equal(s.calls.length, 2, "non-active issue is released, not re-dispatched");
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);
});

test("failures retry with exponential backoff capped by max_retry_backoff_ms", async (t) => {
  const s = setup(t, { agent: { max_retry_backoff_ms: 15_000 } });
  s.tracker.add(issue("A"));
  await s.tick();
  s.calls[0]!.reject(new Error("boom"));
  await flush();
  let retry = s.orchestrator.snapshot().retrying[0]!;
  assert.equal(retry.attempt, 1);
  assert.match(retry.error ?? "", /worker exited: boom/);
  assert.match(s.tracker.comments[0]!, /may retry using the remaining allowance.*stop the service to troubleshoot/);
  assert.doesNotMatch(s.tracker.comments[0]!, /move to|returning to/);
  await s.advance(10_000);
  assert.equal(s.calls[1]?.params.attempt, 1);
  s.calls[1]!.reject(new Error("boom again"));
  await flush();
  retry = s.orchestrator.snapshot().retrying[0]!;
  assert.equal(retry.attempt, 2);
  assert.equal(Date.parse(retry.due_at!) - Date.now(), 15_000);
});

test("terminal issues stop and clean up; non-active or missing ones stop without cleanup", async (t) => {
  const s = setup(t, { agent: { max_concurrent_agents: 3 } });
  s.tracker.add(issue("A"), issue("B"), issue("C"));
  await s.tick();
  s.tracker.set("A", { state: "Done" });
  s.tracker.set("B", { state: "Human Review" });
  s.tracker.issues.delete("C");
  await s.tick();
  assert.ok(s.calls.every((c) => c.aborted));
  assert.deepEqual(s.removed, ["GH-A"]);
  const snap = s.orchestrator.snapshot();
  assert.equal(snap.running.length, 0);
  assert.equal(snap.retrying.length, 0, "stopped issues are released, not retried");
});

for (const pending of [false, true]) {
  test(`native closure in an active board column stops a ${pending ? "pending-handoff" : "running"} worker and preserves cleanup identity`, async (t) => {
    const s = setup(t);
    s.tracker.add(issue("A"));
    await s.tick();
    if (pending) await s.calls[0]!.params.control.accept(implementation, "/tmp/checkout");
    s.tracker.set("A", { contentState: "CLOSED", dispatchable: false });
    const closed = s.tracker.issues.get("A")!;
    const publish = t.mock.method(s.tracker, "publishHandoff", async () => { throw new Error("closed issues must never publish"); });
    await s.tick();
    assert.equal(s.calls[0]!.aborted, true);
    assert.equal(s.ledger.get("A")!.terminal, true);
    assert.equal(s.ledger.get("A")!.pending, null);
    assert.equal(s.tracker.issues.get("A")!.state, "In Progress");
    assert.deepEqual(s.removedIssues, [closed]);
    assert.equal(publish.mock.callCount(), 0);
    await s.tick();
    s.tracker.set("A", { state: "Todo", contentState: "OPEN", dispatchable: true });
    await s.tick();
    assert.equal(s.calls.length, 1, "the persisted terminal tombstone is not reopened");
  });
}

for (const phase of ["waiting", "pending", "no cycle"] as const) {
  test(`native closure precedes ${phase} observation, without publication or new authorization`, async (t) => {
    const s = setup(t);
    const card = issue("A", { state: phase === "waiting" ? "Human Review" : phase === "pending" ? "In Progress" : "Todo" });
    if (phase !== "no cycle") {
      const c = s.ledger.authorize(card, 20);
      if (phase === "pending") {
        const inv = s.ledger.begin(c, "implement");
        s.ledger.confirm(c, inv.id, "persisted-session");
        s.ledger.accept(c, inv.id, implementation, "/tmp/checkout", s.config);
      } else {
        c.waitingState = card.state;
        s.ledger.checkpoint(c);
      }
    }
    const closed = { ...card, contentState: "CLOSED" as const, dispatchable: false };
    s.tracker.add(closed);
    const publish = t.mock.method(s.tracker, "publishHandoff", async () => { throw new Error("closed issues must never publish"); });
    await s.tick();
    assert.equal(s.calls.length, 0);
    assert.equal(publish.mock.callCount(), 0);
    assert.deepEqual(s.removedIssues, [closed]);
    assert.equal(s.ledger.get("A")?.terminal, phase === "no cycle" ? undefined : true);
    assert.equal(s.ledger.get("A")?.pending, phase === "no cycle" ? undefined : null);
    assert.deepEqual(s.tracker.comments, []);
  });
}

test("retry refresh observes native closure before another invocation", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  await finishSession(s, 0);
  s.tracker.set("A", { contentState: "CLOSED", dispatchable: false });
  await s.advance(1000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger.get("A")!.terminal, true);
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);
  assert.deepEqual(s.removedIssues, [s.tracker.issues.get("A")!]);
});

test("halt reporting detects native closure instead of blocking or publishing to an active closed card", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.set("A", { contentState: "CLOSED", dispatchable: false });
  s.calls[0]!.reject(new Error("startup failed"));
  await flush();
  assert.equal(s.ledger.get("A")!.terminal, true);
  assert.equal(s.tracker.issues.get("A")!.state, "In Progress");
  assert.deepEqual(s.tracker.comments, []);
  assert.deepEqual(s.removedIssues, [s.tracker.issues.get("A")!]);
});

test("active issues keep running and get a fresh snapshot", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.set("A", { state: "In Progress", title: "Renamed" });
  await s.tick();
  assert.equal(s.calls[0]!.aborted, false);
  assert.equal(s.orchestrator.snapshot().running[0]!.state, "In Progress");
});

test("a failed state refresh keeps workers running", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.refreshFails = true;
  s.tracker.set("A", { state: "Done" });
  await s.tick();
  assert.equal(s.calls[0]!.aborted, false);
});

test("stalled workers are killed and retried; activity resets the clock", async (t) => {
  const s = setup(t, { copilot: { stall_timeout_ms: 60_000 } });
  s.tracker.add(issue("A"), issue("B"));
  await s.tick();
  await s.advance(50_000);
  s.calls[1]!.params.onUpdate({ event: "assistant.message", timestamp: new Date() });
  await s.advance(20_000);
  await s.tick();
  assert.equal(s.calls[0]!.aborted, true);
  assert.equal(s.calls[1]!.aborted, false);
  const retry = s.orchestrator.snapshot().retrying.find((r) => r.issue_id === "A")!;
  assert.match(retry.error ?? "", /stalled/);
});

test("a retry with no free slot is requeued with an explicit reason", async (t) => {
  const s = setup(t, { agent: { max_concurrent_agents: 1 } });
  s.tracker.add(issue("A", { priority: 1 }), issue("B", { priority: 2 }));
  await s.tick();
  s.calls[0]!.reject(new Error("boom"));
  await flush();
  await s.tick();
  assert.deepEqual(s.ids(), ["A", "B"]);
  await s.advance(10_000);
  const retry = s.orchestrator.snapshot().retrying.find((r) => r.issue_id === "A")!;
  assert.equal(retry.attempt, 2);
  assert.equal(retry.error, "no available orchestrator slots");
});

test("token totals only count growth of absolute session totals", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const update = s.calls[0]!.params.onUpdate;
  update({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  update({ event: "assistant.usage", timestamp: new Date(), turn: 1, tokens: { input: 10, output: 5, total: 15 } });
  update({ event: "assistant.usage", timestamp: new Date(), turn: 1, tokens: { input: 30, output: 10, total: 40 } });
  update({ event: "turn_completed", timestamp: new Date(), turn: 1, tokens: { input: 30, output: 10, total: 40 } });
  const snap = s.orchestrator.snapshot();
  assert.equal(snap.totals.total_tokens, 40);
  assert.equal(snap.running[0]!.tokens.total_tokens, 40);
  assert.equal(snap.running[0]!.session_id, "sess-1");
  assert.ok(s.lines.some((l) => l.includes("msg=turn_completed") && l.includes("session_id=sess-1") && l.includes("issue_identifier=GH-A")));
});

test("dry run logs candidates without starting workers", async (t) => {
  const s = setup(t, {}, true);
  s.tracker.add(issue("A"), issue("B", { state: "Done" }));
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.ok(s.lines.some((l) => l.includes("would dispatch") && l.includes("GH-A")));
  assert.ok(!s.lines.some((l) => l.includes("would dispatch") && l.includes("GH-B")));
});

test("stop aborts running workers and cancels retries", async (t) => {
  const s = setup(t, { agent: { max_concurrent_agents: 2 } });
  s.tracker.add(issue("A"), issue("B"));
  await s.tick();
  s.calls[1]!.reject(new Error("boom"));
  await flush();
  await s.orchestrator.stop();
  assert.equal(s.calls[0]!.aborted, true);
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);
  assert.deepEqual(s.removed, []);
});

/** One started session that ends normally, optionally reporting AI credits. */
async function finishSession(s: ReturnType<typeof setup>, index: number, aiCredits?: number) {
  const call = s.calls[index]!;
  call.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: `sess-${index}` });
  if (aiCredits !== undefined) call.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits });
  call.resolve();
  await flush();
}

test("a run that keeps ending without a handoff is halted after max_sessions", async (t) => {
  const s = setup(t, { agent: { max_sessions: 2 } });
  s.tracker.add(issue("A"));
  await s.tick();
  await finishSession(s, 0);
  await s.advance(1_000);
  assert.equal(s.calls.length, 2, "the continuation starts a second session");
  await finishSession(s, 1, 11);
  await s.advance(1_000);
  assert.equal(s.calls.length, 2, "no third session");
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  assert.match(s.tracker.comments[0] ?? "", /all 2 sessions.*moved to "Blocked"/s);
  assert.match(s.tracker.comments[0]!, /used 2 session\(s\)/);
  assert.doesNotMatch(s.tracker.comments[0]!, /AI credits|11/);
  assert.ok(s.lines.some((l) => l.includes("issue halted")));
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);

  await s.tick();
  assert.equal(s.ledger.get("A")!.sessions, 2, "waiting retains control history");
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 3, "moving the card back starts a new run");
  assert.equal(s.orchestrator.snapshot().running[0]!.run.sessions, 1);
});

test("credits are accounting only, absolute updates do not double count", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const update = s.calls[0]!.params.onUpdate;
  update({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 4 });
  assert.equal(s.calls[0]!.aborted, false);
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 10.5 });
  update({ event: "session_usage", timestamp: new Date(), aiCredits: 10.5 });
  assert.equal(s.calls[0]!.aborted, false);
  assert.equal(s.ledger.get("A")!.aiCredits, 10.5);
  assert.equal(s.ledger.get("A")!.sessions, 1, "session_started telemetry never counts twice");
  assert.deepEqual(s.tracker.comments, []);
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);
  await s.advance(600_000);
  assert.equal(s.calls.length, 1);
});

test("a failed blocked-state mutation cannot grant allowance by moving into another active column", async (t) => {
  const s = setup(t, { agent: { max_sessions: 1 } });
  s.tracker.blockedState = null;
  s.tracker.add(issue("A"));
  await s.tick();
  await finishSession(s, 0);
  await s.advance(1_000);
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.tracker.issues.get("A")!.state, "In Progress");
  assert.match(s.tracker.comments[0] ?? "", /waiting column to "Todo"/);
  assert.equal(s.orchestrator.snapshot().halted[0]!.issue_identifier, "GH-A");

  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.orchestrator.snapshot().halted.length, 1);
});

test("a handoff retains the run; only waiting -> Todo grants fresh limits", async (t) => {
  const s = setup(t, { agent: { max_sessions: 1 } });
  s.tracker.add(issue("A"));
  await s.tick();
  s.calls[0]!.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits: 3 });
  await submit(s, 0, implementation);
  await s.advance(1_000);
  await s.tick();
  assert.equal(s.ledger.get("A")!.sessions, 1);
  assert.equal(s.ledger.get("A")!.aiCredits, 3);
  const authorization = s.ledger.get("A")!.authorizationId;
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 2);
  assert.notEqual(s.ledger.get("A")!.authorizationId, authorization);
  assert.equal(s.ledger.get("A")!.totalAiCredits, 3);
  assert.deepEqual(s.tracker.comments, []);
});

test("run limits survive a restart through the ledger file", async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.json");
  const first = setup(t, { agent: { max_sessions: 2 } }, false, new RunLedger(path));
  first.tracker.add(issue("A"));
  await first.tick();
  first.calls[0]!.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "s1" });
  first.calls[0]!.params.onUpdate({ event: "assistant.usage", timestamp: new Date(), aiCredits: 6 });
  await first.orchestrator.stop();
  t.mock.timers.reset();

  const reloaded = new RunLedger(path);
  assert.equal(reloaded.get("A")!.sessions, 1);
  assert.equal(reloaded.get("A")!.aiCredits, 6);
  const second = setup(t, { agent: { max_sessions: 9 } }, false, reloaded, false);
  second.tracker.add(issue("A", { state: "In Progress" }));
  await second.tick();
  await second.calls[0]!.params.control.onSessionCreated("restarted-session");
  second.calls[0]!.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "s2" });
  second.calls[0]!.params.onUpdate({ event: "assistant.usage", timestamp: new Date(), aiCredits: 4 });
  assert.equal(second.calls[0]!.aborted, false, "costs never terminate a session");
  second.calls[0]!.resolve();
  await flush();
  await second.advance(1_000);
  assert.equal(second.calls.length, 1, "persisted limit 2, not reloaded config 9, governs this authorization");
  assert.equal(reloaded.get("A")!.aiCredits, 10);
});

test("a corrupt ledger fails startup instead of resetting limits; dry runs never write", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  writeFileSync(join(dir, "bad.json"), "{ nope");
  assert.throws(() => new RunLedger(join(dir, "bad.json")), LedgerError);
  const readOnly = new RunLedger(join(dir, "ro.json"), { readOnly: true });
  readOnly.authorize(issue("A"), 20);
  readOnly.save();
  assert.equal(new RunLedger(join(dir, "ro.json")).get("A"), undefined);
});

const summary = {
  usageComplete: true,
  sessionId: "sess", turns: 1, models: [{ model: "claude-opus-5.5", requests: 21, aiCredits: 54.38 }], aiCredits: 54.38,
  premiumRequests: 1, inputTokens: 785_701, outputTokens: 9_876, code: { linesAdded: 4, linesRemoved: 4, files: 2 }, finalState: "Human Review",
};

test("final metrics edit only the owned issue result footer, with detailed metrics in logs", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  call.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  await s.advance(392_000);
  call.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits: 54.38, summary });
  await submit(s, 0, implementation);
  assert.deepEqual(s.tracker.comments, []);
  assert.equal(s.tracker.footers.length, 1);
  assert.match(s.tracker.footers[0]!, /用量（本轮）：54\.38 · 轮次 1\/20 · 模型：claude-opus-5\.5$/);
  assert.ok(s.lines.some((l) => l.includes("session summary") && l.includes("models=claude-opus-5.5:21")));
});

test("a worker stopped by reconciliation logs the new state without a standalone usage comment", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  call.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  call.params.onUpdate({ event: "session_usage", timestamp: new Date(), summary: { ...summary, finalState: "Todo" } });
  s.tracker.set("A", { state: "Human Review" });
  await s.tick();
  assert.equal(call.aborted, true);
  assert.deepEqual(s.tracker.comments, []);
  assert.ok(s.lines.some((l) => l.includes("session summary") && l.includes("Human Review")));
});

test("usage_comments=false suppresses only footers, never meaningful failure reports", async (t) => {
  const quiet = setup(t, { agent: { usage_comments: false } });
  quiet.tracker.add(issue("A"));
  await quiet.tick();
  quiet.calls[0]!.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  quiet.calls[0]!.params.onUpdate({ event: "session_usage", timestamp: new Date(), summary });
  await submit(quiet, 0, implementation);
  assert.deepEqual(quiet.tracker.comments, []);
  assert.deepEqual(quiet.tracker.footers, []);
  assert.ok(quiet.lines.some((l) => l.includes("session summary")), "the log still gets the summary");
  t.mock.timers.reset();

  const s = setup(t, { agent: { usage_comments: false } });
  s.tracker.add(issue("B"));
  await s.tick();
  const update = s.calls[0]!.params.onUpdate;
  update({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 51 });
  update({ event: "session_usage", timestamp: new Date(), aiCredits: 54.38, summary: { ...summary, finalState: "In Progress" } });
  s.calls[0]!.reject(new Error("first send failed"));
  await flush();
  assert.equal(s.tracker.comments.length, 1);
  assert.match(s.tracker.comments[0]!, /session failed.*first send failed.*remaining allowance/s);
  assert.doesNotMatch(s.tracker.comments[0]!, /用量/);
});

test("a retry firing while a poll is in flight never exceeds the concurrency limit", async (t) => {
  const s = setup(t, { agent: { max_concurrent_agents: 1 } });
  s.tracker.add(issue("B", { priority: 1 }), issue("A", { priority: 2 }));
  await s.tick();
  assert.deepEqual(s.ids(), ["B"]);
  s.calls[0]!.reject(new Error("boom"));
  await flush();
  t.mock.timers.tick(10_000);
  const poll = s.orchestrator.tick();
  await poll;
  await flush();
  const running = s.orchestrator.snapshot().running.length;
  assert.ok(running <= 1, `running=${running}, dispatched ${s.ids().join(",")}`);
});

test("a session limit never overwrites an externally reached terminal state", async (t) => {
  const s = setup(t, { agent: { max_sessions: 1 } });
  s.tracker.blockedState = null;
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.set("A", { state: "Done" });
  const update = s.calls[0]!.params.onUpdate;
  update({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 11 });
  await s.tick();
  assert.equal(s.calls.length, 1, "the halted card must not be dispatched again");
  assert.equal(s.tracker.issues.get("A")!.state, "Done");
  assert.deepEqual(s.removed, ["GH-A"]);
});

test("a slow poll never applies a stale card state to a worker that started after it", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.set("A", { state: "Human Review" });
  let release!: () => void;
  s.tracker.gate = new Promise<void>((resolve) => { release = resolve; });
  const poll = s.orchestrator.tick();
  await flush();
  s.tracker.set("A", { state: "Todo" });
  s.calls[0]!.resolve();
  await flush();
  await s.advance(1_000);
  release();
  await poll;
  await flush();
  await s.tick();
  assert.ok(s.calls.slice(1).every((c) => !c.aborted), `workers started after the stale read were killed: ${s.calls.map((c) => c.aborted).join(",")}`);
  assert.equal(s.orchestrator.snapshot().running.length, 1);
});

function reviewSetup(t: TestContext, promptExists = true) {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  if (promptExists) writeFileSync(join(dir, "REVIEW.md"), "Review {{ issue.identifier }}");
  return setup(t, {
    tracker: { active_states: ["Todo", "In Progress", "AI Review", "Rework"], provider: { handoff_state: "AI Review" } },
    review: { states: ["AI Review"], prompt_file: join(dir, "REVIEW.md"), model: "gpt-6-sol", pass_state: "Human Review", fail_state: "Rework" },
  });
}

test("review states go to the reviewer with the round number, and each verdict advances the round", async (t) => {
  const s = reviewSetup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  assert.equal(s.calls[0]!.params.role, "implement");
  await submit(s, 0, implementation);
  await s.advance(1_000);
  assert.equal(s.calls[1]!.params.role, "review");
  assert.equal(s.calls[1]!.params.reviewRound, 1);

  assert.equal(s.calls[1]!.params.control.initialReview, true);
  await submit(s, 1, {
    kind: "review", verdict: "request_changes", reviewedHead: "abc", progress: "initial", progressReason: "first review",
    nextAction: "continue", nextStep: "repair counterexample", summary: "Checks found a blocker", blockingIssues: ["failing case"],
  });
  await s.advance(1_000);
  assert.equal(s.calls[2]!.params.role, "implement");

  await submit(s, 2, implementation);
  await s.advance(1_000);
  assert.equal(s.calls[3]!.params.role, "review");
  assert.equal(s.calls[3]!.params.reviewRound, 2);
  assert.equal(s.orchestrator.snapshot().running[0]!.run.sessions, 4, "the implement-review loop is one authorization");
  assert.equal(s.calls[3]!.params.control.initialReview, false);
});

test("a card that moves to the other role mid-session is handed to a fresh session", async (t) => {
  const s = reviewSetup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.set("A", { state: "AI Review" });
  await s.tick();
  assert.equal(s.calls[0]!.aborted, true, "the implementer's session must not go on to review its own work");
  await s.tick();
  assert.equal(s.calls[1]!.params.role, "review");
});

test("a missing review prompt blocks dispatch", async (t) => {
  const s = reviewSetup(t, false);
  s.tracker.add(issue("A"));
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.ok(s.lines.some((l) => l.includes("preflight failed") && l.includes("review.prompt_file")));
});

const conflictConfig = {
  agent: { max_concurrent_agents: 1 },
  tracker: { active_states: ["Todo", "In Progress", "Rework"], required_labels: ["agent"] },
  merge_conflicts: { states: ["Human Review"], return_state: "Rework" },
};

test("a waiting card whose pull request conflicts goes back to rework ahead of all other work", async (t) => {
  const ledger = new RunLedger();
  const s = setup(t, conflictConfig, false, ledger);
  for (const id of ["B", "C", "D"]) {
    const c = authorize(ledger, issue(id, { state: "Human Review" }));
    c.waitingState = "Human Review";
    c.sessions = 3;
    c.noProgress = 1;
    ledger.checkpoint(c);
  }
  s.tracker.add(
    issue("A", { priority: 1, createdAt: new Date("2025-01-01") }),
    issue("B", { priority: 4, state: "Human Review" }),
    issue("C", { state: "Human Review" }),
    issue("D", { state: "Human Review", labels: [] }),
  );
  s.tracker.conflicts.set("B", 22).set("D", 23);
  await s.tick();
  assert.deepEqual(s.tracker.conflictChecks, [["B", "C"]], "only routable waiting cards are checked");
  assert.deepEqual(s.ids(), ["B"], "the returned card runs before a P1 card");
  assert.equal(s.tracker.issues.get("B")!.state, "Rework");
  assert.equal(s.tracker.issues.get("D")!.state, "Human Review", "without the agent label a person handles it");
  assert.equal(ledger.get("B")?.returnedFor, "merge conflict in PR #22");
  assert.match(s.tracker.comments.join("\n"), /B: \*\*symphony-copilot: \[PR #22\]\(https:\/\/example\.test\/pull\/22\) has merge conflicts with `main`\.\*\* The card was moved from "Human Review" to "Rework"/);

  s.tracker.conflicts.delete("B");
  s.tracker.set("B", { state: "Human Review" });
  s.calls[0]!.resolve();
  await flush();
  await s.advance(1_000);
  await s.tick();
  assert.equal(ledger.get("B")!.sessions, 4, "automatic return never resets allowance");
  assert.equal(ledger.get("B")!.noProgress, 1);
  assert.deepEqual(s.ids(), ["B", "A"]);
});

test("a dry run only reports a merge conflict", async (t) => {
  const s = setup(t, conflictConfig, true);
  const c = authorize(s.ledger, issue("B", { state: "Human Review" }));
  c.waitingState = "Human Review";
  s.ledger.checkpoint(c);
  s.tracker.add(issue("B", { state: "Human Review" }));
  s.tracker.conflicts.set("B", 22);
  await s.tick();
  assert.equal(s.tracker.issues.get("B")!.state, "Human Review");
  assert.equal(s.tracker.comments.length, 0);
  assert.ok(s.lines.some((l) => l.includes("dry run: would return for merge conflict")));
});

test("without merge_conflicts, waiting cards are not checked", async (t) => {
  const s = setup(t, { tracker: { active_states: ["Todo", "In Progress", "Rework"] } });
  s.tracker.add(issue("B", { state: "Human Review" }));
  s.tracker.conflicts.set("B", 22);
  await s.tick();
  assert.deepEqual(s.tracker.conflictChecks, []);
  assert.equal(s.calls.length, 0);
});

test("why a card was returned survives a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.json");
  const ledger = new RunLedger(path);
  ledger.authorize(issue("B"), 20).returnedFor = "merge conflict in PR #22";
  ledger.save();
  assert.equal(new RunLedger(path).get("B")?.returnedFor, "merge conflict in PR #22");
});

test("Todo persists a single authorization before working takeover; failed and lost replies do not reset it", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  s.tracker.moveFails = "before";
  await s.tick();
  const cycle = s.ledger.get("A")!;
  const authorization = cycle.authorizationId;
  assert.equal(cycle.sessions, 0);
  assert.equal(cycle.lastState, "Todo");
  assert.equal(s.calls.length, 0);
  await s.tick();
  assert.equal(cycle.authorizationId, authorization);
  s.tracker.moveFails = "after";
  await s.tick();
  assert.equal(s.tracker.issues.get("A")!.state, "In Progress");
  assert.equal(s.calls.length, 0, "unknown status result must be observed before startup");
  s.tracker.moveFails = null;
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0]!.params.issue.state, "In Progress");
  assert.equal(cycle.authorizationId, authorization);
  assert.equal(cycle.sessions, 0, "dispatch is not an SDK session");
  await s.calls[0]!.params.control.onSessionCreated("created");
  await s.calls[0]!.params.control.onSessionCreated("created");
  assert.equal(cycle.sessions, 1, "confirmation is idempotent");
});

test("an initially active orphan is blocked; neither missing native identity nor Rework grants budget", async (t) => {
  const s = setup(t, { tracker: { active_states: ["Todo", "In Progress", "Rework"] } });
  s.tracker.add(issue("A", { state: "In Progress" }), issue("B", { nativeRef: null }));
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  assert.equal(s.ledger.get("A")!.sessions, 0);
  assert.match(s.tracker.comments.join("\n"), /No recoverable authorization/);
  const authorization = s.ledger.get("A")!.authorizationId;
  s.tracker.set("A", { state: "Rework" });
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.ledger.get("A")!.authorizationId, authorization);
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.notEqual(s.ledger.get("A")!.authorizationId, authorization);
});

test("pre-session failure pauses once with stage and recovery, no charge or automatic retries", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  s.calls[0]!.params.onUpdate({ event: "startup_phase", timestamp: new Date(), message: "before_run" });
  s.calls[0]!.reject(new Error("dependency hook failed"));
  await flush();
  await s.advance(600_000);
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger.get("A")!.sessions, 0);
  assert.equal(s.ledger.get("A")!.invocation!.phase, "finished");
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  assert.equal(s.tracker.comments.length, 1);
  assert.match(s.tracker.comments[0]!, /startup_failed \(before_run\).*dependency hook failed.*"Todo"/s);
  assert.doesNotMatch(s.tracker.comments[0]!, /用量/);
});

test("stopping the service before SDK creation is not a business failure", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  await s.orchestrator.stop();
  assert.equal(s.ledger.get("A")!.sessions, 0);
  assert.equal(s.ledger.get("A")!.halted, null);
  assert.equal(s.ledger.get("A")!.invocation!.phase, "finished");
  assert.equal(s.tracker.issues.get("A")!.state, "In Progress");
  assert.deepEqual(s.tracker.comments, []);
});

test("graceful shutdown cannot finish unresolved startup until the owning runner acknowledges cleanup", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  call.params.onUpdate({ event: "startup_uncertain", timestamp: new Date() });
  await s.orchestrator.stop();
  const inv = s.ledger.get("A")!.invocation!;
  assert.equal(inv.phase, "starting");
  assert.equal(inv.startupUncertain, true);
  await assert.rejects(call.params.control.onSessionCreated("late-during-shutdown"), /no longer active/);
  assert.equal(inv.phase, "running");
  assert.equal(s.ledger.get("A")!.sessions, 1);
  call.params.onUpdate({ event: "startup_settled", timestamp: new Date() });
  assert.equal(inv.phase, "finished");
  assert.equal(inv.startupUncertain, false);
  assert.deepEqual(s.tracker.comments, []);
});

test("unknown startup needs a live cleanup acknowledgement; an already observed waiting -> Todo then authorizes", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  call.params.onUpdate({ event: "startup_uncertain", timestamp: new Date(), message: "session_create" });
  call.reject(new Error("create timeout"));
  await flush();
  const cycle = s.ledger.get("A")!;
  assert.equal(cycle.invocation!.phase, "starting");
  const authorization = cycle.authorizationId;
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(cycle.authorizationId, authorization);
  assert.equal(s.calls.length, 1, "no same-issue overlap with unresolved SDK creation");
  await assert.rejects(call.params.control.onSessionCreated("late-session"), /no longer active/);
  assert.equal(cycle.sessions, 1);
  assert.ok(cycle.halted);
  assert.equal(cycle.invocation!.phase, "running");
  assert.equal(cycle.invocation!.startupUncertain, true);
  await assert.rejects(call.params.control.onSessionCreated("late-session"), /no longer active/);
  assert.equal(cycle.sessions, 1, "late confirmation is idempotent");
  assert.equal(s.calls.length, 1);
  await s.tick();
  assert.equal(s.calls.length, 1, "confirmation alone is not runtime cleanup proof");
  assert.match(s.tracker.comments[0]!, /startup remains uncertain; verify\/clean up interrupted runtime before reauthorizing; cannot establish automatically/);
  assert.doesNotMatch(s.tracker.comments[0]!, /restart the host before reauthorizing/);
  call.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits: 17 });
  assert.equal(cycle.aiCredits, 17);
  assert.equal(cycle.totalAiCredits, 17);
  assert.throws(call.params.control.assertActive, /no longer active/);
  call.params.onUpdate({ event: "startup_settled", timestamp: new Date() });
  assert.equal(cycle.invocation!.startupUncertain, false);
  assert.equal(cycle.invocation!.phase, "finished");
  assert.ok(cycle.halted, "cleanup acknowledges safety, not new authorization");
  await s.tick();
  assert.equal(s.calls.length, 2, "no second board move is needed after the earlier waiting -> Todo edge");
  assert.notEqual(cycle.authorizationId, authorization);
  assert.equal(cycle.sessions, 0);
  assert.equal(cycle.totalAiCredits, 17);
  const next = cycle.invocation!;
  s.calls[1]!.params.onUpdate({ event: "startup_uncertain", timestamp: new Date() });
  call.params.onUpdate({ event: "startup_settled", timestamp: new Date() });
  assert.equal(next.startupUncertain, true, "a stale acknowledgement cannot clear a newer invocation's fence");
});

for (const persisted of ["orphan starting", "halted starting", "confirmed uncertain"] as const) {
test(`restart with ${persisted} stays fenced even after Blocked -> Todo and another restart`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  const initial = new RunLedger(path);
  const c = initial.authorize(issue("A", { state: "In Progress" }), 20);
  const inv = initial.begin(c, "implement");
  if (persisted !== "orphan starting") {
    if (persisted === "confirmed uncertain") {
      inv.startupUncertain = true;
      initial.confirm(c, inv.id, "late-session");
      inv.phase = "finished"; // Older hosts could mark finished before proving cleanup.
    }
    initial.pause(c, "startup_uncertain", "Blocked");
  }
  const s = setup(t, {}, false, new RunLedger(path));
  s.tracker.add(issue("A", { state: persisted === "orphan starting" ? "In Progress" : "Blocked" }));
  await s.tick();
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.ledger.get("A")!.sessions, persisted === "confirmed uncertain" ? 1 : 0);
  assert.match(s.ledger.get("A")!.halted!.reason, /startup_uncertain/);
  assert.equal(s.ledger.get("A")!.invocation!.startupUncertain, true);
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.ledger.get("A")!.authorizationId, c.authorizationId);
  await s.orchestrator.stop();
  t.mock.timers.reset();
  const again = setup(t, {}, false, new RunLedger(path));
  again.tracker.add(issue("A", { state: "Todo" }));
  await again.tick();
  assert.equal(again.calls.length, 0, "no retained runner means no automatic cleanup proof/replacement");
  assert.equal(again.ledger.get("A")!.authorizationId, c.authorizationId);
  assert.equal(again.ledger.get("A")!.invocation!.startupUncertain, true);
});
}

test("live cleanup acknowledgement before exit still pauses; late rejection after exit permits later Todo", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"), issue("B"));
  await s.tick();
  for (const call of s.calls) call.params.onUpdate({ event: "startup_uncertain", timestamp: new Date(), message: "runtime_start" });
  s.calls[0]!.params.onUpdate({ event: "startup_settled", timestamp: new Date() });
  for (const call of s.calls) call.reject(new Error("start timed out"));
  await flush();
  assert.equal(s.ledger.get("A")!.invocation!.phase, "finished");
  assert.equal(s.ledger.get("A")!.sessions, 0);
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  assert.equal(s.ledger.get("B")!.invocation!.phase, "starting");
  s.calls[1]!.params.onUpdate({ event: "startup_settled", timestamp: new Date() });
  assert.equal(s.ledger.get("B")!.invocation!.phase, "finished");
  assert.equal(s.ledger.get("B")!.sessions, 0);
  s.tracker.set("A", { state: "Todo" });
  s.tracker.set("B", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 4);
});

test("waiting authorization survives restart and project item re-add using native issue identity", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-readd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  const initial = new RunLedger(path);
  const original = issue("old");
  const cycle = initial.authorize(original, 2);
  const inv = initial.begin(cycle, "implement");
  initial.confirm(cycle, inv.id, "past-session");
  initial.recordUsage(cycle, inv.id, 4);
  inv.phase = "finished";
  initial.pause(cycle, "human_required", "Blocked");
  const s = setup(t, { agent: { max_sessions: 7 } }, false, new RunLedger(path));
  s.tracker.add({ ...original, id: "new", state: "Blocked" });
  await s.tick();
  assert.equal(s.ledger.get("old"), undefined);
  assert.equal(s.ledger.get("new")!.sessions, 1);
  assert.equal(s.ledger.get("new")!.limit, 2);
  s.tracker.set("new", { state: "Todo" });
  await s.tick();
  assert.equal(s.ledger.records().length, 1);
  assert.equal(s.ledger.get("new")!.limit, 7, "only new authorization takes the new configured limit");
  assert.equal(s.ledger.get("new")!.sessions, 1);
  assert.equal(s.ledger.get("new")!.totalAiCredits, 4);
  const authorization = s.ledger.get("new")!.authorizationId;
  await s.tick();
  assert.equal(s.ledger.get("new")!.authorizationId, authorization);
});

test("accepted result publication failure retries only host work, including after worker exit errors", async (t) => {
  const s = reviewSetup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  await call.params.control.accept(implementation, "/tmp/checkout");
  s.tracker.publicationFails = true;
  call.reject(new Error("post-accept tracker failure"));
  await flush();
  await s.tick();
  await s.advance(10_000);
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger.get("A")!.sessions, 1);
  assert.ok(s.ledger.get("A")!.pending);
  assert.deepEqual(s.tracker.comments, []);
  s.tracker.publicationFails = false;
  await s.tick();
  assert.equal(s.calls.length, 1, "a pre-publication source snapshot cannot dispatch the implementer again");
  assert.equal(s.ledger.get("A")!.pending, null);
  assert.equal(call.params.control.accepted(), true, "accepted identity survives clearing pending");
  await s.tick();
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1]!.params.role, "review");
});

test("publication resumes across restart without a second semantic execution", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  const saved = new RunLedger(path);
  const config = makeConfig();
  const cycle = saved.authorize(issue("A", { state: "In Progress" }), 20);
  const inv = saved.begin(cycle, "implement");
  saved.confirm(cycle, inv.id, "accepted-session");
  saved.accept(cycle, inv.id, implementation, "/tmp/checkout", config);
  const s = setup(t, {}, false, new RunLedger(path));
  s.tracker.add(issue("A", { state: "In Progress" }));
  await s.tick();
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(s.tracker.issues.get("A")!.state, "Human Review");
  assert.equal(s.ledger.get("A")!.pending, null);
  assert.equal(s.ledger.get("A")!.sessions, 1);
});

test("a handoff finishing during a slow poll cannot be undone by the older source snapshot", async (t) => {
  const s = reviewSetup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  let release!: () => void;
  s.tracker.gate = new Promise<void>((resolve) => { release = resolve; });
  const poll = s.orchestrator.tick();
  await flush();
  await submit(s, 0, implementation);
  release();
  await poll;
  await flush();
  await s.advance(1_000);
  assert.equal(s.ledger.get("A")!.lastState, "AI Review");
  assert.equal(s.calls[1]!.params.role, "review");
});

test("lost conflict-return response preserves intent and counters; halted/exhausted/unknown cards never auto-return", async (t) => {
  const s = setup(t, conflictConfig);
  for (const id of ["A", "B", "C"]) {
    const c = s.ledger.authorize(issue(id, { state: "Human Review" }), 20);
    c.waitingState = "Human Review";
    c.sessions = id === "C" ? 20 : 6;
    c.noProgress = 1;
    if (id === "B") c.halted = { reason: "no_progress", state: "Human Review", at: new Date().toISOString() };
    s.ledger.checkpoint(c);
  }
  for (const id of ["A", "B", "C", "D"]) {
    s.tracker.add(issue(id, { state: "Human Review" }));
    s.tracker.conflicts.set(id, 22);
  }
  const authorization = s.ledger.get("A")!.authorizationId;
  s.tracker.moveFails = "after";
  await s.tick();
  assert.deepEqual(s.tracker.conflictChecks, [["A"]]);
  assert.equal(s.ledger.get("A")!.waitingState, "Human Review");
  assert.equal(s.calls.length, 0);
  s.tracker.moveFails = null;
  await s.tick();
  assert.deepEqual(s.ids(), ["A"]);
  assert.equal(s.ledger.get("A")!.authorizationId, authorization);
  assert.equal(s.ledger.get("A")!.sessions, 7);
  assert.equal(s.ledger.get("A")!.noProgress, 1);
  assert.equal(s.ledger.get("A")!.waitingState, null);
});

test("20 successfully created sessions are the shared cap, and no 21st invocation starts", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  for (let index = 0; index < 20; index++) {
    assert.equal(s.calls.length, index + 1);
    await finishSession(s, index);
    await s.advance(1_000);
  }
  assert.equal(s.calls.length, 20);
  assert.equal(s.ledger.get("A")!.sessions, 20);
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  await s.tick();
  assert.equal(s.calls.length, 20);
});

test("session 20 approval remains successful; implementation 20 needing review halts unreviewed", async (t) => {
  const s = reviewSetup(t);
  const cycle = s.ledger.authorize(issue("A", { state: "AI Review" }), 20);
  cycle.sessions = 19;
  s.ledger.checkpoint(cycle);
  s.tracker.add(issue("A", { state: "AI Review" }));
  await s.tick();
  await submit(s, 0, {
    kind: "review", verdict: "approve", reviewedHead: "abc", progress: "initial", progressReason: "verified", summary: "All verified",
    nextAction: null, nextStep: null, blockingIssues: [],
  });
  await s.advance(1_000);
  await s.tick();
  assert.equal(cycle.sessions, 20);
  assert.equal(cycle.halted, null);
  assert.equal(s.tracker.issues.get("A")!.state, "Human Review");
  const other = s.ledger.authorize(issue("B", { state: "In Progress" }), 20);
  other.sessions = 19;
  s.ledger.checkpoint(other);
  s.tracker.add(issue("B", { state: "In Progress" }));
  await s.tick();
  await submit(s, 1, implementation);
  assert.equal(other.halted?.reason, "session_limit_unreviewed");
  assert.equal(s.tracker.issues.get("B")!.state, "Blocked");
  await s.tick();
  assert.equal(s.calls.length, 2);
});

test("initial review and repeated publication do not count stagnation; two distinct no-progress reworks stop", async (t) => {
  const s = reviewSetup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const verdict = (progress: "initial" | "made_progress" | "no_progress"): AgentResult => ({
    kind: "review", verdict: "request_changes", reviewedHead: "abc", progress, progressReason: "counterexample still fails",
    nextAction: "continue", nextStep: "try the alternate invariant", summary: "Reproduced with evidence", blockingIssues: ["counterexample"],
  });
  for (const [round, progress] of ["initial", "no_progress", "made_progress", "no_progress", "no_progress"].entries()) {
    await submit(s, round * 2, implementation);
    await s.advance(1_000);
    const call = s.calls[round * 2 + 1]!;
    assert.equal(call.params.control.initialReview, round === 0);
    const result = verdict(progress as "initial" | "made_progress" | "no_progress");
    const p = await call.params.control.accept(result, "/tmp/checkout");
    assert.equal(await call.params.control.accept(result, "/tmp/checkout"), p);
    const published = await s.tracker.publishHandoff(call.params.issue, p, call.params.control.checkpoint, call.params.control.assertActive);
    call.params.control.finish(published.stale);
    call.resolve();
    await flush();
    assert.equal(s.ledger.get("A")!.noProgress, [0, 1, 0, 1, 2][round]);
    if (round < 4) await s.advance(1_000);
  }
  assert.equal(s.calls.length, 10, "review is not capped at three rounds");
  assert.equal(s.ledger.get("A")!.halted?.reason, "no_progress");
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
});

test("critical ledger write failure poisons scheduling, including all other cards", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-poison-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store", "ledger.json");
  const ledger = new RunLedger(path);
  const s = setup(t, {}, false, ledger, false);
  s.tracker.add(issue("A"));
  await s.tick();
  rmSync(join(dir, "store"), { recursive: true });
  writeFileSync(join(dir, "store"), "not a directory");
  await assert.rejects(s.calls[0]!.params.control.onSessionCreated("created-but-save-failed"), /instance unusable/);
  await flush();
  assert.equal(s.calls[0]!.aborted, true);
  assert.match(s.orchestrator.snapshot().ledger_error!, /instance unusable/);
  s.tracker.add(issue("B"));
  await s.tick();
  await s.advance(600_000);
  assert.equal(s.calls.length, 1);
});

test("footer requires reliable usage and actual models, preserves zero, deduplicates multiple actual models", () => {
  assert.equal(formatUsageFooter({ ...summary, usageComplete: false }, 1, 20), null);
  assert.equal(formatUsageFooter({ ...summary, models: [] }, 1, 20), null);
  assert.equal(formatUsageFooter({ ...summary, models: [{ model: "auto", requests: 1, aiCredits: 1 }] }, 1, 20), null);
  const models = ["model-a", "model-b", "model-a"].map((model) => ({ model, requests: 1, aiCredits: 0 }));
  assert.equal(formatUsageFooter({ ...summary, aiCredits: 0, models }, 20, 20), "用量（本轮）：0.00 · 轮次 20/20 · 模型：model-a, model-b");
});

test("footer write failure never adds a replacement usage comment or reruns a completed session", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.footerFails = true;
  s.calls[0]!.params.onUpdate({ event: "session_usage", timestamp: new Date(), summary });
  await submit(s, 0, implementation);
  await s.advance(1_000);
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.tracker.comments, []);
  assert.ok(s.lines.some((line) => line.includes("could not update usage footer")));
});

test("late usage after Todo reauthorization updates only the original allocation; old tools lose authority", async (t) => {
  const s = setup(t);
  s.tracker.add(issue("A"));
  await s.tick();
  const old = s.calls[0]!;
  old.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits: 5 });
  await submit(s, 0, implementation);
  await s.advance(1_000);
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  const c = s.ledger.get("A")!;
  assert.equal(s.calls.length, 2);
  assert.equal(c.sessions, 1);
  old.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits: 8 });
  assert.equal(c.aiCredits, 0);
  assert.equal(c.totalAiCredits, 8);
  assert.equal(c.sessions, 1);
  assert.throws(old.params.control.assertActive, /no longer owns/);
  await assert.rejects(old.params.control.accept(implementation, "/tmp/checkout"), /no longer owns/);
  assert.equal(c.pending, null);
  assert.equal(old.params.control.accepted(), true);
});

test("late SDK success before the timeout worker exits still pauses instead of retrying", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  call.params.onUpdate({ event: "startup_uncertain", timestamp: new Date(), message: "session_create" });
  await assert.rejects(call.params.control.onSessionCreated("late-but-before-exit"), /no longer active/);
  call.reject(new Error("create timed out"));
  await flush();
  assert.equal(s.ledger.get("A")!.sessions, 1);
  assert.match(s.ledger.get("A")!.halted!.reason, /startup_uncertain/);
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  await s.advance(600_000);
  assert.equal(s.calls.length, 1);
});

test("an orphan control record interrupted before pause cannot start from its inactive origin", async (t) => {
  const ledger = new RunLedger();
  ledger.authorize(issue("A", { state: "Blocked" }), 20);
  const s = setup(t, {}, false, ledger);
  s.tracker.add(issue("A", { state: "In Progress" }));
  await s.tick();
  assert.equal(s.calls.length, 0);
  assert.ok(ledger.get("A")!.halted);
  assert.equal(ledger.get("A")!.sessions, 0);
});

test("session confirmation does not wait behind a slow serialized poll", async (t) => {
  const s = setup(t, {}, false, new RunLedger(), false);
  s.tracker.add(issue("A"));
  await s.tick();
  let release!: () => void;
  s.tracker.gate = new Promise<void>((resolve) => { release = resolve; });
  const poll = s.orchestrator.tick();
  await flush();
  assert.equal(await s.calls[0]!.params.control.onSessionCreated("created-during-poll"), 1);
  release();
  await poll;
  assert.equal(s.calls[0]!.aborted, false);
});

test("startup terminal cleanup persists closure; later Todo does not reopen a known terminal issue", async (t) => {
  const s = setup(t);
  s.ledger.authorize(issue("A", { state: "In Progress" }), 20);
  s.tracker.add(issue("A", { state: "Done" }));
  await s.orchestrator.start();
  assert.equal(s.ledger.get("A")!.terminal, true);
  assert.deepEqual(s.removed, ["GH-A"]);
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 0);
  await s.orchestrator.stop();
});

test("restart settles a persisted conflict-return intent without resetting allowance or stagnation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-conflict-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  const saved = new RunLedger(path);
  const c = saved.authorize(issue("A", { state: "Human Review" }), 20);
  c.sessions = 8;
  c.noProgress = 1;
  c.waitingState = "Human Review";
  c.returnedFor = "merge conflict in PR #22";
  saved.checkpoint(c); // Crash after remote move, before local settlement.
  const s = setup(t, conflictConfig, false, new RunLedger(path));
  s.tracker.add(issue("A", { state: "Rework" }));
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger.get("A")!.authorizationId, c.authorizationId);
  assert.equal(s.ledger.get("A")!.sessions, 9);
  assert.equal(s.ledger.get("A")!.noProgress, 1);
  assert.equal(s.ledger.get("A")!.waitingState, null);
});

test("restart after Todo authorization and a lost working takeover reply does not grant twice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-takeover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  const saved = new RunLedger(path);
  const c = saved.authorize(issue("A"), 4);
  const s = setup(t, { agent: { max_sessions: 20 } }, false, new RunLedger(path));
  s.tracker.add(issue("A", { state: "In Progress" }));
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.ledger.get("A")!.authorizationId, c.authorizationId);
  assert.equal(s.ledger.get("A")!.limit, 4);
  assert.equal(s.ledger.get("A")!.sessions, 1);
});
