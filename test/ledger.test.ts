import assert from "node:assert/strict";
import fs, { existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RunLedger, LedgerError, issueControlKey, type RunCycle } from "../src/ledger.ts";
import type { AgentResult, ReviewResult } from "../src/iteration.ts";
import { makeConfig, makeIssue } from "./helpers.ts";

const now = new Date("2026-09-30T00:00:00Z");
const issue = makeIssue({ nativeRef: { provider: "fake", repository: "Owner/Repo", issue_id: "I_1" } });
const config = makeConfig({
  tracker: { active_states: ["Todo", "In Progress", "Rework", "AI Review"], provider: { handoff_state: "AI Review" } },
  review: { states: ["AI Review"], prompt_file: "REVIEW.md", pass_state: "Human Review", fail_state: "Rework" },
});
const implementation: AgentResult = { kind: "implement", title: "Fix", summary: "Tests verified", head: "same-sha" };
const review = (changes: Partial<ReviewResult> = {}): ReviewResult => ({
  kind: "review", verdict: "request_changes", reviewedHead: "same-sha", progress: "initial",
  progressReason: "The counterexample fails.", nextAction: "continue", nextStep: "Change the cleanup boundary.",
  summary: "Reproduced the blocker.", blockingIssues: ["Deletes sibling workspace"], ...changes,
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "symphony-ledger-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ledger.json");
  return { dir, path, ledger: new RunLedger(path) };
}
function start(ledger: RunLedger, cycle: RunCycle, role: "implement" | "review" = "implement") {
  const invocation = ledger.begin(cycle, role);
  ledger.confirm(cycle, invocation.id, `sdk-${invocation.id}`);
  return invocation;
}
function handoff(ledger: RunLedger, cycle: RunCycle, result: AgentResult) {
  const invocation = start(ledger, cycle, result.kind === "review" ? "review" : "implement");
  const pending = ledger.accept(cycle, invocation.id, result, "/work/GH-1", config);
  pending.issueMessage = { id: `comment-${invocation.id}`, url: null };
  pending.statusApplied = true;
  ledger.checkpoint(cycle);
  ledger.complete(cycle);
  return invocation;
}
const legacy = (overrides = {}) => ({ identifier: "GH-1", startedAt: now.toISOString(), sessions: 7, aiCredits: 12.5, reviewRounds: 3, halted: null, returnedFor: null, ...overrides });

test("native repository + issue identity survives item re-add, spelling and restart", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  assert.match(cycle.authorizationId, /^[0-9a-f-]{36}$/);
  const invocation = start(ledger, cycle);
  ledger.recordUsage(cycle, invocation.id, 2.5);
  const readded = { ...issue, id: "new-item", nativeRef: { ...issue.nativeRef, repository: " owner/REPO " } };
  const restored = new RunLedger(path);
  const adopted = restored.adopt(readded, 99)!;
  assert.equal(adopted.key, issueControlKey(issue));
  assert.equal(adopted.sessions, 1);
  assert.equal(adopted.limit, 20);
  assert.equal(adopted.authorizationId, cycle.authorizationId);
  assert.equal(restored.get("new-item"), adopted);
  assert.equal(restored.get(issue.id), undefined);
  assert.deepEqual(restored.issueIds(), [cycle.key]);
  assert.deepEqual(restored.records(), [adopted]);
  assert.equal(new RunLedger(path).get(cycle.key)!.itemId, "new-item");
});

test("missing native identity and conflicting item ownership never silently authorize", () => {
  const ledger = new RunLedger();
  for (const nativeRef of [null, {}, { issue_id: "I_1" }, { repository: "owner/repo" }, { repository: "repo", issue_id: "I_1" }]) {
    assert.throws(() => ledger.authorize({ ...issue, nativeRef }, 20, now), LedgerError);
  }
  ledger.authorize(issue, 20, now);
  assert.throws(() => ledger.authorize({ ...issue, nativeRef: { repository: "other/repo", issue_id: "I_2" } }, 20, now), /item|identity/i);
});

test("begin reserves without charge, confirm is durable and idempotent, no parallel start", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const invocation = ledger.begin(cycle, "implement");
  assert.equal(cycle.sessions, 0);
  assert.equal(new RunLedger(path).get(cycle.key)!.invocation!.phase, "starting");
  assert.throws(() => ledger.begin(cycle, "review"), /invocation|active|starting/i);
  assert.throws(() => ledger.confirm(cycle, "wrong", "sdk"));
  assert.equal(ledger.confirm(cycle, invocation.id, "sdk"), 1);
  assert.equal(ledger.confirm(cycle, invocation.id, "sdk"), 1);
  assert.throws(() => ledger.confirm(cycle, invocation.id, "different"));
  assert.equal(cycle.sessions, 1);
  const restarted = new RunLedger(path);
  assert.equal(restarted.confirm(restarted.get(cycle.key)!, invocation.id, "sdk"), 1);
  assert.equal(restarted.get(cycle.key)!.sessions, 1);
});

test("startup halt does not charge, late confirmation charges once but cannot accept work", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const invocation = ledger.begin(cycle, "implement");
  ledger.pause(cycle, "session create timed out", "Blocked", now);
  assert.equal(cycle.sessions, 0);
  assert.throws(() => ledger.begin(cycle, "implement"));
  assert.throws(() => ledger.authorize(issue, 20, now), /invocation|unfinished|active/i);
  assert.equal(ledger.confirm(cycle, invocation.id, "late-sdk"), 1);
  assert.equal(ledger.confirm(cycle, invocation.id, "late-sdk"), 1);
  assert.throws(() => ledger.accept(cycle, invocation.id, implementation, "/work", config), /halt|paused/i);
  assert.equal(new RunLedger(path).get(cycle.key)!.sessions, 1);
});

test("startup uncertainty survives restart and fences even a finished invocation; missing legacy field is false", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const invocation = ledger.begin(cycle, "implement");
  assert.equal(new RunLedger(path).get(cycle.key)!.invocation!.startupUncertain, undefined);
  invocation.startupUncertain = true;
  invocation.phase = "finished";
  ledger.checkpoint(cycle);
  const restarted = new RunLedger(path), restored = restarted.get(cycle.key)!;
  assert.equal(restored.invocation!.startupUncertain, true);
  assert.throws(() => restarted.authorize(issue, 20, now), /startup remains uncertain/);
  assert.throws(() => restarted.begin(restored, "implement"), /startup remains uncertain/);
  assert.equal(restored.authorizationId, cycle.authorizationId);
  restored.invocation!.startupUncertain = false; // Host validated the owning runner's cleanup acknowledgement.
  restarted.checkpoint(restored);
  assert.equal(new RunLedger(path).get(cycle.key)!.invocation!.startupUncertain, false);
  restarted.authorize(issue, 20, now);
  assert.notEqual(restored.authorizationId, cycle.authorizationId);
});

test("all twenty successful sessions share the cap and SDK identity cannot be reused", () => {
  const ledger = new RunLedger();
  const cycle = ledger.authorize(issue, 20, now);
  for (let n = 0; n < 20; n++) {
    const invocation = start(ledger, cycle, n % 2 ? "review" : "implement");
    invocation.phase = "finished"; // The host ends a session with no semantic handoff.
    ledger.checkpoint(cycle);
  }
  assert.equal(cycle.sessions, 20);
  assert.throws(() => ledger.begin(cycle, "review"), /limit/i);
  const other = ledger.authorize({ ...issue, id: "item-2", nativeRef: { repository: "owner/repo", issue_id: "I_2" } }, 20, now);
  const invocation = ledger.begin(other, "implement");
  const used = Object.values(cycle.allocations)[0]!.sessionId!;
  assert.throws(() => ledger.confirm(other, invocation.id, used), /session/i);
  assert.equal(other.sessions, 0);
});

test("accept checkpoints one immutable semantic result; restart and completion do not repeat it", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const invocation = start(ledger, cycle, "review");
  const result = review();
  const pending = ledger.accept(cycle, invocation.id, result, "/work", config);
  assert.equal(cycle.reviewRounds, 0);
  assert.equal(ledger.accept(cycle, invocation.id, structuredClone(result), "/work", config), pending);
  result.summary = "Changed externally";
  assert.notEqual(pending.result.summary, result.summary);
  assert.throws(() => ledger.accept(cycle, invocation.id, result, "/work", config), /different|changed/i);
  pending.issueMessage = { id: "comment-1", url: "https://example.test/comment-1" };
  pending.pr = { id: "PR_1", number: 1, url: "https://example.test/pr/1" };
  pending.prPublished = true;
  pending.statusApplied = true;
  ledger.checkpoint(cycle);
  const restarted = new RunLedger(path);
  const restored = restarted.get(cycle.key)!;
  assert.equal(restored.pending!.id, pending.id);
  assert.equal(restored.pending!.issueMessage!.id, "comment-1");
  restarted.complete(restored);
  const reworkId = restored.reworkId;
  restarted.complete(restored);
  assert.equal(restored.reviewRounds, 1);
  assert.equal(restored.reworkId, reworkId);
  assert.equal(restored.reworkReady, false);
  assert.equal(restored.pending, null);
  assert.equal(restored.invocation!.phase, "finished");
  assert.throws(() => restarted.accept(restored, invocation.id, review(), "/work", config), /finished|completed/i);
  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes("Reproduced the blocker."), "settled semantic body is not a local history store");
});

test("only two distinct, formally handed-off reworks can stop for no progress, even on the same SHA", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  handoff(ledger, cycle, review());
  const firstRework = cycle.reworkId;
  const tooEarly = start(ledger, cycle, "review");
  assert.throws(() => ledger.accept(cycle, tooEarly.id, review({ progress: "no_progress" }), "/work", config), /handoff|handed|rework/i);
  tooEarly.phase = "finished";
  ledger.checkpoint(cycle);
  handoff(ledger, cycle, implementation);
  assert.equal(cycle.reworkId, firstRework);
  assert.equal(cycle.reworkReady, true);
  handoff(ledger, cycle, review({ progress: "no_progress" }));
  assert.equal(cycle.noProgress, 1);
  assert.equal(cycle.lastSettledReworkId, firstRework);
  assert.notEqual(cycle.reworkId, firstRework);
  assert.equal(cycle.lastState, "Rework");
  handoff(ledger, cycle, implementation);
  const restarted = new RunLedger(path);
  const restored = restarted.get(cycle.key)!;
  handoff(restarted, restored, review({ progress: "no_progress" }));
  assert.equal(restored.noProgress, 2);
  assert.equal(restored.reviewRounds, 3);
  assert.equal(restored.waitingState, "Blocked");
  assert.equal(restored.halted!.state, "Blocked");
  assert.equal(restored.lastState, "Blocked");
  assert.throws(() => restarted.begin(restored, "implement"));
});

test("stale reviews finish the invocation but neither settle progress nor apply the target", () => {
  const ledger = new RunLedger();
  const cycle = ledger.authorize(issue, 20, now);
  handoff(ledger, cycle, review());
  handoff(ledger, cycle, implementation);
  const reworkId = cycle.reworkId;
  const invocation = start(ledger, cycle, "review");
  ledger.accept(cycle, invocation.id, review({ progress: "no_progress" }), "/work", config);
  ledger.complete(cycle, true);
  assert.equal(cycle.reviewRounds, 1);
  assert.equal(cycle.noProgress, 0);
  assert.equal(cycle.reworkId, reworkId);
  assert.equal(cycle.lastSettledReworkId, null);
  assert.equal(cycle.lastState, "AI Review");
  assert.equal(cycle.pending, null);
  handoff(ledger, cycle, review({ progress: "made_progress" }));
  assert.equal(cycle.reviewRounds, 2);
});

test("implementation head retry persists across restart and exhausted publication does not ready rework or consume sessions", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  handoff(ledger, cycle, review());
  const reworkId = cycle.reworkId;
  const invocation = start(ledger, cycle, "implement");
  const pending = ledger.accept(cycle, invocation.id, implementation, "/work", config);
  assert.equal(pending.headMismatch, undefined, "old pending records remain valid without a retry field");
  pending.pushed = true;
  pending.headMismatch = { attempts: 1, actualHead: "older-sha", retryAt: now.getTime() + 60_000 };
  ledger.checkpoint(cycle);

  const restoredLedger = new RunLedger(path), restored = restoredLedger.get(cycle.key)!;
  const p = restored.pending!;
  assert.deepEqual(p.headMismatch, pending.headMismatch);
  assert.equal(restored.sessions, 2);
  p.headMismatch = { attempts: 3, actualHead: "different-sha", retryAt: now.getTime() + 180_000 };
  p.haltReason = "head_mismatch";
  p.targetState = p.waitingState = "Blocked";
  p.issueMessage = { id: "comment", url: null };
  p.statusApplied = true;
  restoredLedger.checkpoint(restored);
  const restarted = new RunLedger(path), halted = restarted.get(cycle.key)!;
  restarted.complete(halted);
  assert.equal(halted.halted?.reason, "head_mismatch");
  assert.equal(halted.lastState, "Blocked");
  assert.equal(halted.waitingState, "Blocked");
  assert.equal(halted.sessions, 2);
  assert.equal(halted.reviewRounds, 1);
  assert.equal(halted.noProgress, 0);
  assert.equal(halted.reworkId, reworkId);
  assert.equal(halted.lastSettledReworkId, null);
  assert.equal(halted.reworkReady, false, "failed publication is not a formally submitted rework");
  assert.throws(() => restarted.begin(halted, "implement"), /halted/);
});

test("malformed head-retry counters and halt combinations cannot reset a pending retry", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now), invocation = start(ledger, cycle);
  const pending = ledger.accept(cycle, invocation.id, implementation, "/work", config);
  pending.pushed = true;
  ledger.checkpoint(cycle);
  const valid = JSON.parse(readFileSync(path, "utf8"));
  const retry = { attempts: 1, actualHead: "older-sha", retryAt: now.getTime() + 60_000 };
  const mutations: Array<(p: any) => void> = [
    (p) => { p.headMismatch = null; },
    (p) => { p.headMismatch = { ...retry, attempts: 0 }; },
    (p) => { p.headMismatch = { ...retry, attempts: 1.5 }; },
    (p) => { p.headMismatch = { ...retry, attempts: 4 }; },
    (p) => { p.headMismatch = { ...retry, actualHead: "" }; },
    (p) => { p.headMismatch = { ...retry, retryAt: -1 }; },
    (p) => { p.headMismatch = { ...retry, retryAt: "tomorrow" }; },
    (p) => { p.headMismatch = retry; p.pushed = false; },
    (p) => { p.headMismatch = { ...retry, attempts: 3 }; },
    (p) => { p.haltReason = "head_mismatch"; p.waitingState = p.targetState = "Blocked"; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(valid);
    mutate(data.issues[cycle.key].pending);
    writeFileSync(path, JSON.stringify(data));
    assert.throws(() => new RunLedger(path), LedgerError, mutate.toString());
  }
});

test("unable-to-verify and runtime pauses preserve the existing streak and unassessed rework", () => {
  const ledger = new RunLedger();
  const cycle = ledger.authorize(issue, 20, now);
  handoff(ledger, cycle, review());
  handoff(ledger, cycle, implementation);
  handoff(ledger, cycle, review({ progress: "no_progress" }));
  handoff(ledger, cycle, implementation);
  const reworkId = cycle.reworkId;
  handoff(ledger, cycle, review({ verdict: "unable_to_verify", reviewedHead: null, progress: "not_assessed", nextAction: "human_required" }));
  assert.equal(cycle.noProgress, 1);
  assert.equal(cycle.reworkId, reworkId);
  assert.notEqual(cycle.lastSettledReworkId, reworkId);
  ledger.pause(cycle, "runtime failure", "Blocked", now);
  assert.equal(cycle.noProgress, 1);
});

test("monotonic usage survives restart and reauthorization; late old usage never charges the new cycle", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const old = start(ledger, cycle);
  ledger.recordUsage(cycle, old.id, 3);
  ledger.recordUsage(cycle, old.id, 2);
  ledger.recordUsage(cycle, old.id, 3);
  assert.equal(cycle.aiCredits, 3);
  old.phase = "finished";
  ledger.pause(cycle, "Needs human", "Blocked", now);
  const oldAuthorization = cycle.authorizationId;
  const renewed = ledger.authorize(issue, 30, now);
  assert.equal(renewed, cycle, "callbacks may still hold the original cycle reference");
  assert.notEqual(renewed.authorizationId, oldAuthorization);
  assert.equal(renewed.totalAiCredits, 3);
  assert.equal(renewed.aiCredits, 0);
  assert.equal(renewed.sessions, 0);
  assert.equal(renewed.limit, 30);
  assert.equal(renewed.halted, null);
  ledger.recordUsage(cycle, old.id, 4.5);
  const current = start(ledger, renewed);
  ledger.recordUsage(renewed, current.id, 2);
  assert.equal(renewed.totalAiCredits, 6.5);
  assert.equal(renewed.aiCredits, 2);
  assert.throws(() => ledger.recordUsage(renewed, "unknown", 100));
  for (const amount of [-1, NaN, Infinity]) assert.throws(() => ledger.recordUsage(renewed, current.id, amount));
  const restarted = new RunLedger(path);
  const restored = restarted.get(renewed.key)!;
  restarted.recordUsage(restored, old.id, 5);
  assert.equal(restored.totalAiCredits, 7);
  assert.equal(restored.aiCredits, 2);
  assert.equal(restarted.confirm(restored, old.id, `sdk-${old.id}`), 1);
  assert.equal(restored.sessions, 1);
});

test("observe updates only mapping and lastState, never grants authorization or clears halt", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  ledger.pause(cycle, "Human input", "Blocked", now);
  const authorization = cycle.authorizationId;
  ledger.observe(cycle, { ...issue, id: "readded", state: "Todo" });
  assert.equal(cycle.authorizationId, authorization);
  assert.equal(cycle.halted!.reason, "Human input");
  assert.equal(cycle.itemId, "readded");
  const persisted = readFileSync(path, "utf8");
  ledger.observe(cycle, { ...issue, id: "readded", state: "Todo" });
  assert.equal(readFileSync(path, "utf8"), persisted);
  assert.throws(() => ledger.observe(cycle, { ...issue, nativeRef: { repository: "other/repo", issue_id: "I_1" } }));
  cycle.terminal = true;
  ledger.checkpoint(cycle);
  assert.throws(() => ledger.authorize(issue, 20, now), /terminal/i);
});

test("version 1 migration is exact-item only, retains remaining unmapped allocations and usage", (t) => {
  const { path } = fixture(t);
  writeFileSync(path, JSON.stringify({ version: 1, issues: { [issue.id]: legacy(), orphan: legacy({ identifier: "GH-2", sessions: 9 }) } }));
  const ledger = new RunLedger(path);
  const cycle = ledger.adopt(issue, 20)!;
  assert.equal(cycle.sessions, 7);
  assert.equal(cycle.aiCredits, 12.5);
  assert.equal(cycle.totalAiCredits, 12.5);
  assert.equal(cycle.reviewRounds, 3);
  assert.equal(cycle.noProgress, 0);
  assert.match(cycle.authorizationId, /^[0-9a-f-]{36}$/);
  const restarted = new RunLedger(path);
  assert.deepEqual(restarted.legacyItemIds(), ["orphan"]);
  assert.throws(() => restarted.authorize({ ...issue, id: "readded-orphan", identifier: "GH-2", nativeRef: { repository: "other/repo", issue_id: "I_2" } }, 20, now), /legacy|identity|map/i);
  assert.equal(restarted.get(cycle.key)!.sessions, 7);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
});

test("ambiguous or mismatched legacy identifiers cannot be guessed across repositories", (t) => {
  const { path } = fixture(t);
  writeFileSync(path, JSON.stringify({ version: 1, issues: { old: legacy(), another: legacy() } }));
  const ledger = new RunLedger(path);
  assert.throws(() => ledger.adopt(issue, 20), /legacy|ambiguous/i);
  assert.throws(() => ledger.authorize({ ...issue, id: "old", identifier: "GH-3" }, 20, now), /legacy|identifier/i);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
});

test("exact legacy item IDs disambiguate duplicate identifiers without guessing orphan mappings", (t) => {
  const { path } = fixture(t);
  writeFileSync(path, JSON.stringify({ version: 1, issues: { [issue.id]: legacy(), another: legacy({ sessions: 3 }) } }));
  const ledger = new RunLedger(path);
  assert.equal(ledger.adopt(issue, 20)!.sessions, 7);
  const restarted = new RunLedger(path);
  assert.deepEqual(restarted.legacyItemIds(), ["another"]);
  const other = { ...issue, id: "readded", nativeRef: { repository: "other/repo", issue_id: "I_2" } };
  assert.throws(() => restarted.adopt(other, 20), /orphan legacy/);
  assert.equal(restarted.adopt({ ...other, id: "another" }, 20)!.sessions, 3);
  assert.equal(restarted.records().length, 2);
});

test("read-only mode never writes, including migration and a missing parent directory", (t) => {
  const { path, dir } = fixture(t);
  const text = JSON.stringify({ version: 1, issues: { [issue.id]: legacy() } });
  writeFileSync(path, text);
  symlinkSync(path, `${path}.tmp`);
  const ledger = new RunLedger(path, { readOnly: true });
  const cycle = ledger.adopt(issue, 20)!;
  start(ledger, cycle);
  ledger.save();
  assert.equal(readFileSync(path, "utf8"), text);
  assert.ok(lstatSync(`${path}.tmp`).isSymbolicLink());
  const missing = join(dir, "not-created", "ledger.json");
  new RunLedger(missing, { readOnly: true }).authorize(issue, 20, now);
  assert.equal(existsSync(join(dir, "not-created")), false);
});

test("a critical write failure propagates and poisons the instance, including caller checkpoints", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  mkdirSync(`${path}.tmp`);
  assert.throws(() => ledger.begin(cycle, "implement"), LedgerError);
  assert.throws(() => ledger.get(cycle.key), /failed|unusable|poison/i);
  assert.throws(() => ledger.save(), LedgerError);
  assert.throws(() => ledger.authorize(issue, 20, now), LedgerError);
  assert.equal(new RunLedger(path).get(cycle.key)!.invocation, null);
  rmSync(`${path}.tmp`, { recursive: true });
  const reopened = new RunLedger(path);
  const restored = reopened.get(cycle.key)!;
  mkdirSync(`${path}.tmp`);
  restored.lastState = "In Progress";
  assert.throws(() => reopened.checkpoint(restored), LedgerError);
  assert.throws(() => reopened.records(), LedgerError);
});

for (const [kind, link] of [["symlink", symlinkSync], ["hard link", linkSync]] as const) {
  test(`a save never follows a temporary ${kind}, preserves durable state and requires a fresh instance`, (t) => {
    const { ledger, path, dir } = fixture(t);
    const cycle = ledger.authorize(issue, 20, now);
    const durable = readFileSync(path, "utf8");
    const target = join(dir, "another-runner.log");
    writeFileSync(target, "other runner's log\n");
    link(target, `${path}.tmp`);
    assert.throws(() => ledger.begin(cycle, "implement"), /run ledger save failed.*EEXIST/);
    assert.equal(readFileSync(target, "utf8"), "other runner's log\n");
    assert.equal(readFileSync(path, "utf8"), durable);
    assert.ok(lstatSync(`${path}.tmp`), "the failed save must not remove a pre-existing alias");
    rmSync(`${path}.tmp`);
    assert.throws(() => ledger.save(), /instance unusable/);
    const restored = new RunLedger(path);
    const resumed = restored.get(cycle.key)!;
    assert.equal(resumed.authorizationId, cycle.authorizationId);
    assert.equal(resumed.invocation, null);
    restored.begin(resumed, "implement");
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.equal(new RunLedger(path).get(cycle.key)!.invocation?.phase, "starting");
  });
}

test("a save refuses stale temporary files and dangling aliases without deleting them", (t) => {
  for (const kind of ["file", "dangling symlink"]) {
    const { ledger, path, dir } = fixture(t);
    const target = join(dir, "missing-target");
    if (kind === "file") writeFileSync(`${path}.tmp`, "crash evidence");
    else symlinkSync(target, `${path}.tmp`);
    assert.throws(() => ledger.authorize(issue, 20, now), /run ledger save failed.*EEXIST/);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(target), false);
    assert.ok(lstatSync(`${path}.tmp`));
    if (kind === "file") assert.equal(readFileSync(`${path}.tmp`, "utf8"), "crash evidence");
  }
});

test("a failed rename cleans up only the temporary file owned by that save", (t) => {
  const { ledger, path } = fixture(t);
  mkdirSync(path);
  assert.throws(() => ledger.authorize(issue, 20, now), /run ledger save failed/);
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.ok(lstatSync(path).isDirectory());
  assert.throws(() => ledger.records(), /instance unusable/);
});

test("a partial temporary write closes its descriptor, removes its sidecar and preserves the durable ledger", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const durable = readFileSync(path, "utf8");
  let descriptor: number | undefined;
  const write = t.mock.method(fs, "writeFileSync", (file: Parameters<typeof writeFileSync>[0]) => {
    assert.equal(typeof file, "number", "the save must write through its exclusively owned descriptor");
    if (typeof file !== "number") assert.fail("expected a file descriptor");
    descriptor = file;
    writeSync(file, '{"version":');
    throw new Error("simulated partial write failure");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => ledger.begin(cycle, "implement"), /run ledger save failed.*simulated partial write failure/);
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
  assert.notEqual(descriptor, undefined);
  assert.throws(() => fstatSync(descriptor!), /EBADF/);
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.equal(readFileSync(path, "utf8"), durable);
  assert.throws(() => ledger.records(), /instance unusable/);
  assert.equal(new RunLedger(path).get(cycle.key)!.invocation, null);
});

test("unknown versions, invalid top-level records, counters and nested pending data fail closed", (t) => {
  const { ledger, path } = fixture(t);
  const cycle = ledger.authorize(issue, 20, now);
  const invocation = start(ledger, cycle, "review");
  ledger.accept(cycle, invocation.id, review(), "/work", config);
  const valid = JSON.parse(readFileSync(path, "utf8"));
  const mutations: Array<(data: any) => void> = [
    (d) => { d.version = 3; }, (d) => { delete d.issues; }, (d) => { d.issues = []; }, (d) => { d.legacy = []; },
    ...["sessions", "limit", "noProgress", "reviewRounds", "totalAiCredits", "aiCredits"].map((field) => (d: any) => { d.issues[cycle.key][field] = -1; }),
    (d) => { d.issues[cycle.key].sessions = 0.5; }, (d) => { d.issues[cycle.key].authorizationId = ""; },
    (d) => { d.issues[cycle.key].pending = {}; }, (d) => { d.issues[cycle.key].pending.invocationId = "wrong"; },
    (d) => { d.issues[cycle.key].pending.nextNoProgress = -1; }, (d) => { d.issues[cycle.key].pending.statusApplied = "yes"; },
    (d) => { d.issues[cycle.key].pending.nextNoProgress = 1; },
    (d) => { d.issues[cycle.key].pending.haltReason = "made_up"; },
    (d) => { d.issues[cycle.key].pending.waitingState = "Todo"; },
    (d) => { d.issues[cycle.key].pending.pr = { id: "pr", number: 0, url: "u" }; },
    (d) => { d.issues[cycle.key].pending.result.nextAction = null; },
    (d) => { d.issues[cycle.key].invocation.startupUncertain = "true"; },
    (d) => { d.issues[cycle.key].invocation.startupUncertain = null; },
    (d) => { d.issues[cycle.key].invocation.ordinal = 0; }, (d) => { delete d.issues[cycle.key].allocations; },
    (d) => { d.issues[cycle.key].allocations[invocation.id].credits = -1; },
    (d) => { d.issues[cycle.key].totalAiCredits = -0.5; },
    (d) => { d.issues[cycle.key].key = "other"; },
    (d) => { const c = d.issues[cycle.key]; c.key = "owner/repo:%49_1"; d.issues = { [c.key]: c }; },
  ];
  for (const mutate of mutations) {
    const data = structuredClone(valid);
    mutate(data);
    writeFileSync(path, JSON.stringify(data));
    assert.throws(() => new RunLedger(path), LedgerError, mutate.toString());
  }
  for (const data of ["{", "null", "{}", JSON.stringify({ version: 1, issues: { item: legacy({ sessions: -1 }) } })]) {
    writeFileSync(path, data);
    assert.throws(() => new RunLedger(path), LedgerError);
  }
});

test("key save failures at confirmation, acceptance and settlement recover only the last durable boundary", (t) => {
  for (const stage of ["confirm", "accept", "complete"] as const) {
    const { ledger, path } = fixture(t);
    const cycle = ledger.authorize(issue, 20, now);
    const invocation = ledger.begin(cycle, "review");
    if (stage !== "confirm") ledger.confirm(cycle, invocation.id, "sdk");
    if (stage === "complete") ledger.accept(cycle, invocation.id, review(), "/work", config);
    const before = readFileSync(path, "utf8");
    mkdirSync(`${path}.tmp`);
    assert.throws(() => {
      if (stage === "confirm") ledger.confirm(cycle, invocation.id, "sdk");
      if (stage === "accept") ledger.accept(cycle, invocation.id, review(), "/work", config);
      if (stage === "complete") ledger.complete(cycle);
    }, LedgerError);
    assert.throws(() => ledger.begin(cycle, "implement"), LedgerError);
    assert.equal(readFileSync(path, "utf8"), before);
    const restored = new RunLedger(path).get(cycle.key)!;
    assert.equal(restored.sessions, stage === "confirm" ? 0 : 1);
    assert.equal(restored.reviewRounds, 0);
    assert.equal(restored.pending !== null, stage === "complete");
  }
});

test("approval at session twenty is normal waiting, and continued progress exceeds three reviews", () => {
  const ledger = new RunLedger();
  const cycle = ledger.authorize(issue, 20, now);
  handoff(ledger, cycle, review());
  for (let round = 0; round < 5; round++) {
    handoff(ledger, cycle, implementation);
    handoff(ledger, cycle, review({ progress: round === 0 ? "no_progress" : "made_progress" }));
  }
  assert.equal(cycle.reviewRounds, 6);
  assert.equal(cycle.noProgress, 0);
  handoff(ledger, cycle, implementation);
  while (cycle.sessions < 19) {
    const invocation = start(ledger, cycle, "review");
    invocation.phase = "finished";
    ledger.checkpoint(cycle);
  }
  handoff(ledger, cycle, review({ verdict: "approve", progress: "made_progress", nextAction: null, nextStep: null, blockingIssues: [] }));
  assert.equal(cycle.sessions, 20);
  assert.equal(cycle.lastState, "Human Review");
  assert.equal(cycle.waitingState, "Human Review");
  assert.equal(cycle.halted, null);
  assert.equal(cycle.reworkId, null);
  assert.throws(() => ledger.begin(cycle, "review"));
});

test("no-review completion uses its configured human handoff without a quota failure", () => {
  const ledger = new RunLedger();
  const cycle = ledger.authorize(issue, 1, now);
  const invocation = start(ledger, cycle);
  const pending = ledger.accept(cycle, invocation.id, implementation, "/work", makeConfig());
  assert.equal(pending.targetState, "Human Review");
  ledger.complete(cycle);
  assert.equal(cycle.waitingState, "Human Review");
  assert.equal(cycle.halted, null);
});

test("pending-stale flag, terminal closure and an intervening pause dominate old handoffs", () => {
  for (const stop of ["stale", "terminal", "pause"]) {
    const ledger = new RunLedger();
    const cycle = ledger.authorize(issue, 20, now);
    const invocation = start(ledger, cycle, "review");
    const pending = ledger.accept(cycle, invocation.id, review(), "/work", config);
    if (stop === "stale") pending.stale = true;
    if (stop === "terminal") { cycle.terminal = true; cycle.lastState = "Done"; }
    if (stop === "pause") ledger.pause(cycle, "Human intervention required", "Blocked", now);
    ledger.checkpoint(cycle);
    ledger.complete(cycle);
    assert.equal(cycle.pending, null);
    assert.equal(cycle.reviewRounds, 0);
    assert.equal(cycle.reworkId, null);
    assert.equal(cycle.lastState, stop === "terminal" ? "Done" : "Todo");
    if (stop === "pause") assert.equal(cycle.halted!.reason, "Human intervention required");
  }
});