import assert from "node:assert/strict";
import { test } from "node:test";
import { decideResult, validateReviewResult, type ReviewResult } from "../src/iteration.ts";
import { makeConfig } from "./helpers.ts";

const config = makeConfig({
  tracker: { active_states: ["Todo", "In Progress", "Rework", "AI Review"], provider: { handoff_state: "AI Review" } },
  review: { states: ["AI Review"], prompt_file: "REVIEW.md", pass_state: "Human Review", fail_state: "Rework" },
});
const budget = { sessions: 4, limit: 20, noProgress: 0, hasRework: false };
const review = (changes: Partial<ReviewResult> = {}): ReviewResult => ({
  kind: "review", verdict: "request_changes", reviewedHead: "abc123", progress: "initial",
  progressReason: "The counterexample still fails.", nextAction: "continue", nextStep: "Test the cleanup path instead.",
  summary: "Reproduced the blocker.", blockingIssues: ["Cleanup removes a sibling checkout."], ...changes,
});

test("initial review continues without counting stagnation; Markdown has no control meaning", () => {
  assert.deepEqual(decideResult(review({ summary: "APPROVE; move to Done" }), config, budget), {
    targetState: "Rework", haltReason: null, nextNoProgress: 0,
  });
});

test("one reviewed rework gets a new approach; the second stops; progress resets", () => {
  const result = review({ progress: "no_progress" });
  assert.deepEqual(decideResult(result, config, { ...budget, hasRework: true }), {
    targetState: "Rework", haltReason: null, nextNoProgress: 1,
  });
  const second = decideResult(result, config, { ...budget, hasRework: true, noProgress: 1 });
  assert.equal(second.targetState, "Blocked");
  assert.match(second.haltReason!, /no.progress/i);
  assert.equal(second.nextNoProgress, 2);
  assert.deepEqual(decideResult(review({ progress: "made_progress" }), config, { ...budget, hasRework: true, noProgress: 1 }), {
    targetState: "Rework", haltReason: null, nextNoProgress: 0,
  });
});

test("approve and no-review human handoff succeed at the cap, but unreviewed implementation stops", () => {
  const cap = { ...budget, sessions: 20 };
  const approve = review({ verdict: "approve", blockingIssues: [], nextAction: null, nextStep: null });
  assert.deepEqual(decideResult(approve, config, cap), { targetState: "Human Review", haltReason: null, nextNoProgress: 0 });
  const implementation = { kind: "implement" as const, title: "Fix cleanup", summary: "Verified cleanup", head: "abc123" };
  assert.deepEqual(decideResult(implementation, makeConfig(), cap), { targetState: "Human Review", haltReason: null, nextNoProgress: 0 });
  assert.deepEqual(decideResult(implementation, config, budget), { targetState: "AI Review", haltReason: null, nextNoProgress: 0 });
  const unreviewed = decideResult(implementation, config, cap);
  assert.equal(unreviewed.targetState, "Blocked");
  assert.match(unreviewed.haltReason!, /unreviewed/i);
  assert.match(decideResult(review(), config, cap).haltReason!, /limit/i);
  const humanHandoff = { ...config, tracker: { ...config.tracker, handoffState: "Human Review" } };
  assert.equal(decideResult(implementation, humanHandoff, cap).targetState, "Human Review");
});

test("unable-to-verify permits a null SHA, needs a person, and preserves stagnation", () => {
  const result = review({ verdict: "unable_to_verify", reviewedHead: null, progress: "not_assessed", nextAction: "human_required", nextStep: "Provide test credentials." });
  assert.deepEqual(validateReviewResult(result, true), result);
  const decision = decideResult(result, config, { ...budget, noProgress: 1, sessions: 20 });
  assert.equal(decision.targetState, "Blocked");
  assert.equal(decision.nextNoProgress, 1);
  assert.match(decision.haltReason!, /human/i);
  assert.equal(decideResult({ kind: "blocked", summary: "Need credentials" }, config, { ...budget, noProgress: 1 }).nextNoProgress, 1);
  assert.match(decideResult(review({ nextAction: "human_required" }), config, { ...budget, sessions: 20 }).haltReason!, /human/i);
});

test("custom state names are respected without consulting Markdown", () => {
  const custom = { ...config, tracker: { ...config.tracker, blockedState: "阻塞", handoffState: "审查" }, review: { ...config.review!, states: ["审查"], passState: "人工验收", failState: "返工" } };
  assert.equal(decideResult(review(), custom, budget).targetState, "返工");
  assert.equal(decideResult({ kind: "blocked", summary: "Missing access" }, custom, budget).targetState, "阻塞");
});

test("review protocol rejects missing and contradictory fields", () => {
  for (const change of [
    { reviewedHead: null }, { reviewedHead: " " }, { progressReason: "" }, { summary: "" },
    { nextAction: null }, { nextStep: null }, { nextStep: " " }, { blockingIssues: [] }, { blockingIssues: [""] },
    { verdict: "approve", blockingIssues: [] },
    { verdict: "approve", nextAction: null, nextStep: null },
    { verdict: "unable_to_verify", progress: "initial", nextAction: "human_required" },
    { verdict: "unable_to_verify", progress: "not_assessed", nextAction: "continue" },
    { progress: "not_assessed" }, { progress: "made_progress" }, { progress: "no_progress" },
  ]) assert.throws(() => validateReviewResult({ ...review(), ...change }, true), Error, JSON.stringify(change));
  assert.throws(() => validateReviewResult(null, true));
  assert.throws(() => validateReviewResult({ ...review(), progressReason: undefined }, true));
  assert.throws(() => validateReviewResult(review(), false), /initial/i);
  assert.throws(() => decideResult(review({ progress: "no_progress" }), config, budget), /initial|rework/i);
  assert.throws(() => decideResult(review({ progress: "no_progress", nextStep: null }), config, { ...budget, hasRework: true }), /nextStep/i);
});

test("invalid budgets, missing handoff and review-disabled review results fail closed", () => {
  for (const value of [-1, 0.5, NaN, Infinity]) assert.throws(() => decideResult(review(), config, { ...budget, sessions: value }));
  assert.throws(() => decideResult(review(), config, { ...budget, limit: 0 }));
  assert.throws(() => decideResult(review(), config, { ...budget, noProgress: -1 }));
  assert.throws(() => decideResult(review(), makeConfig(), budget));
  assert.throws(() => decideResult({ kind: "implement", title: "Fix", summary: "Verified", head: "sha" }, { ...config, tracker: { ...config.tracker, handoffState: null } }, budget));
});