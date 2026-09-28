import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LedgerError, RunLedger } from "../src/ledger.ts";
import { Orchestrator, retryDelayMs, sortForDispatch, type WorkerParams } from "../src/orchestrator.ts";
import type { TrackerAdapter } from "../src/tracker/index.ts";
import { normalizeState, type Issue } from "../src/types.ts";
import { captureLog, flush, makeConfig, makeIssue, makeWorkflow } from "./helpers.ts";

class FakeTracker implements TrackerAdapter {
  readonly kind = "fake";
  readonly issues = new Map<string, Issue>();
  readonly comments: string[] = [];
  blockedState: string | null = "Blocked";
  refreshFails = false;
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
    return ids.map((id) => this.issues.get(id)).filter((i): i is Issue => i !== undefined);
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
}

interface WorkerCall {
  params: WorkerParams;
  resolve(): void;
  reject(error: Error): void;
  aborted: boolean;
}

function setup(t: TestContext, raw: Record<string, any> = {}, dryRun = false, ledger?: RunLedger) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const config = makeConfig({ polling: { interval_ms: 3_600_000 }, ...raw });
  const workflow = makeWorkflow(config);
  const tracker = new FakeTracker();
  const calls: WorkerCall[] = [];
  const removed: string[] = [];
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
    },
    runWorker: (params) => new Promise<void>((resolve, reject) => {
      const call: WorkerCall = { params, resolve, reject, aborted: false };
      params.signal.addEventListener("abort", () => {
        call.aborted = true;
        reject(new Error(`aborted: ${params.signal.reason}`));
      });
      calls.push(call);
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
  return { orchestrator, tracker, calls, removed, lines, tick, advance, ids };
}

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
  s.tracker.add(issue("A", { state: "In Progress" }), issue("B", { state: "In Progress" }), issue("C"));
  await s.tick();
  assert.deepEqual(s.ids().sort(), ["A", "C"]);
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
  await finishSession(s, 1);
  await s.advance(1_000);
  assert.equal(s.calls.length, 2, "no third session");
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  assert.match(s.tracker.comments[0] ?? "", /all 2 sessions.*moved to "Blocked"/s);
  assert.ok(s.lines.some((l) => l.includes("issue halted")));
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);

  await s.tick();
  assert.ok(s.lines.some((l) => l.includes("run closed") && l.includes("state=\"not active\"")));
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 3, "moving the card back starts a new run");
  assert.equal(s.orchestrator.snapshot().running[0]!.run.sessions, 0);
});

test("the AI credit budget stops a worker mid-session and is never exceeded by a new session", async (t) => {
  const s = setup(t, { copilot: { max_ai_credits_per_issue: 10 } });
  s.tracker.add(issue("A"));
  await s.tick();
  const update = s.calls[0]!.params.onUpdate;
  update({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 4 });
  assert.equal(s.calls[0]!.aborted, false);
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 10.5 });
  assert.equal(s.calls[0]!.aborted, true);
  await flush();
  assert.equal(s.tracker.issues.get("A")!.state, "Blocked");
  assert.match(s.tracker.comments[0] ?? "", /budget: 10\.5 of 10/);
  assert.equal(s.orchestrator.snapshot().retrying.length, 0);
  await s.advance(600_000);
  assert.equal(s.calls.length, 1);
});

test("without a blocked state, a halted issue waits until a person moves it", async (t) => {
  const s = setup(t, { agent: { max_sessions: 1 } });
  s.tracker.blockedState = null;
  s.tracker.add(issue("A"));
  await s.tick();
  await finishSession(s, 0);
  await s.advance(1_000);
  await s.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.tracker.issues.get("A")!.state, "Todo");
  assert.match(s.tracker.comments[0] ?? "", /Move the card to a different column/);
  assert.equal(s.orchestrator.snapshot().halted[0]!.issue_identifier, "GH-A");

  s.tracker.set("A", { state: "In Progress" });
  await s.tick();
  assert.equal(s.calls.length, 2);
  assert.equal(s.orchestrator.snapshot().halted.length, 0);
});

test("a handoff ends the run, so rework starts with fresh limits", async (t) => {
  const s = setup(t, { agent: { max_sessions: 1 } });
  s.tracker.add(issue("A"));
  await s.tick();
  s.tracker.set("A", { state: "Human Review" });
  await finishSession(s, 0, 3);
  await s.advance(1_000);
  await s.tick();
  assert.ok(s.lines.some((l) => l.includes("run closed") && l.includes("sessions=1") && l.includes("ai_credits=3")));
  s.tracker.set("A", { state: "Todo" });
  await s.tick();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.tracker.comments, []);
});

test("run limits survive a restart through the ledger file", async (t) => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.json");
  const first = setup(t, { copilot: { max_ai_credits_per_issue: 10 } }, false, new RunLedger(path));
  first.tracker.add(issue("A"));
  await first.tick();
  first.calls[0]!.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "s1" });
  first.calls[0]!.params.onUpdate({ event: "assistant.usage", timestamp: new Date(), aiCredits: 6 });
  await first.orchestrator.stop();
  t.mock.timers.reset();

  const reloaded = new RunLedger(path);
  assert.equal(reloaded.get("A")!.sessions, 1);
  assert.equal(reloaded.get("A")!.aiCredits, 6);
  const second = setup(t, { copilot: { max_ai_credits_per_issue: 10 } }, false, reloaded);
  second.tracker.add(issue("A"));
  await second.tick();
  second.calls[0]!.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "s2" });
  second.calls[0]!.params.onUpdate({ event: "assistant.usage", timestamp: new Date(), aiCredits: 4 });
  assert.equal(second.calls[0]!.aborted, true, "6 + 4 reaches the budget of 10");
});

test("a corrupt ledger fails startup instead of resetting limits; dry runs never write", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  writeFileSync(join(dir, "bad.json"), "{ nope");
  assert.throws(() => new RunLedger(join(dir, "bad.json")), LedgerError);
  const readOnly = new RunLedger(join(dir, "ro.json"), { readOnly: true });
  readOnly.open("A", "GH-A", new Date());
  readOnly.save();
  assert.equal(new RunLedger(join(dir, "ro.json")).get("A"), undefined);
});

const summary = {
  sessionId: "sess", turns: 1, models: [{ model: "claude-opus-5.5", requests: 21, aiCredits: 54.38 }], aiCredits: 54.38,
  premiumRequests: 1, inputTokens: 785_701, outputTokens: 9_876, code: { linesAdded: 4, linesRemoved: 4, files: 2 }, finalState: "Human Review",
};

test("every session posts a usage summary on the issue and in the log", async (t) => {
  const s = setup(t, { copilot: { max_ai_credits_per_issue: 300 } });
  s.tracker.add(issue("A"));
  await s.tick();
  const call = s.calls[0]!;
  call.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  await s.advance(392_000);
  call.params.onUpdate({ event: "session_usage", timestamp: new Date(), aiCredits: 54.38, summary });
  call.resolve();
  await flush();
  const comment = s.tracker.comments[0] ?? "";
  assert.match(comment, /session 1 of 5 · card now "Human Review"/);
  assert.match(comment, /Model: claude-opus-5\.5 \(21 calls\)/);
  assert.match(comment, /Turns: 1 of 20 · Time: 6m 32s · Code: \+4 −4 in 2 files/);
  assert.match(comment, /AI credits: 54\.38 this session · 54\.38 of 300 this run/);
  assert.match(comment, /Tokens: 785\.7k in · 9\.9k out · Premium requests: 1/);
  assert.ok(s.lines.some((l) => l.includes("session summary") && l.includes("models=claude-opus-5.5:21")));
});

test("usage comments can be turned off; a budget halt folds the usage into its notice", async (t) => {
  const quiet = setup(t, { agent: { usage_comments: false } });
  quiet.tracker.add(issue("A"));
  await quiet.tick();
  quiet.calls[0]!.params.onUpdate({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  quiet.calls[0]!.params.onUpdate({ event: "session_usage", timestamp: new Date(), summary });
  quiet.calls[0]!.resolve();
  await flush();
  assert.deepEqual(quiet.tracker.comments, []);
  assert.ok(quiet.lines.some((l) => l.includes("session summary")), "the log still gets the summary");
  t.mock.timers.reset();

  const s = setup(t, { copilot: { max_ai_credits_per_issue: 50 } });
  s.tracker.add(issue("B"));
  await s.tick();
  const update = s.calls[0]!.params.onUpdate;
  update({ event: "session_started", timestamp: new Date(), sessionId: "sess" });
  update({ event: "assistant.usage", timestamp: new Date(), aiCredits: 51 });
  update({ event: "session_usage", timestamp: new Date(), aiCredits: 54.38, summary: { ...summary, finalState: "In Progress" } });
  await flush();
  assert.equal(s.tracker.comments.length, 1);
  assert.match(s.tracker.comments[0]!, /stopped working.*session 1 of 5 · stopped: run limit reached/s);
});
