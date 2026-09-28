import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Orchestrator, retryDelayMs, sortForDispatch, type WorkerParams } from "../src/orchestrator.ts";
import type { TrackerAdapter } from "../src/tracker/index.ts";
import { normalizeState, type Issue } from "../src/types.ts";
import { captureLog, flush, makeConfig, makeIssue, makeWorkflow } from "./helpers.ts";

class FakeTracker implements TrackerAdapter {
  readonly kind = "fake";
  readonly issues = new Map<string, Issue>();
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
}

interface WorkerCall {
  params: WorkerParams;
  resolve(): void;
  reject(error: Error): void;
  aborted: boolean;
}

function setup(t: TestContext, raw: Record<string, any> = {}, dryRun = false) {
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
