import type { ServiceConfig } from "./config.ts";
import { normalizeState } from "./types.ts";

export interface ReviewResult {
  kind: "review";
  verdict: "approve" | "request_changes" | "unable_to_verify";
  reviewedHead: string | null;
  progress: "initial" | "made_progress" | "no_progress" | "not_assessed";
  progressReason: string;
  nextAction: "continue" | "human_required" | null;
  nextStep: string | null;
  summary: string;
  blockingIssues: string[];
}
export interface ImplementationResult { kind: "implement"; title: string; summary: string; head: string }
export interface BlockedResult { kind: "blocked"; summary: string }
export type AgentResult = ReviewResult | ImplementationResult | BlockedResult;
export interface IssueMessageRef { id: string; url: string | null }
export interface PendingHandoff {
  id: string;
  invocationId: string;
  sourceState: string;
  targetState: string;
  workspacePath: string;
  result: AgentResult;
  issueMessage: IssueMessageRef | null;
  pr: { id: string; number: number; url: string } | null;
  prPublished: boolean;
  pushed: boolean;
  statusApplied: boolean;
  stale: boolean;
  haltReason: string | null;
  nextNoProgress: number;
  reworkId: string | null;
  /** Snapshot of the decision: completion must not depend on a later config reload. */
  waitingState: string | null;
}
export interface IterationContext { sessions: number; limit: number; noProgress: number; hasRework: boolean }
export interface IterationDecision { targetState: string; haltReason: string | null; nextNoProgress: number }

const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function requireField(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid agent result: ${message}`);
}

/** Validate the structured protocol only; prose and commit contents are never interpreted here. */
export function validateReviewResult(raw: unknown, initialReview: boolean): ReviewResult {
  requireField(raw && typeof raw === "object" && !Array.isArray(raw), "review must be an object");
  const r = raw as ReviewResult;
  requireField(r.kind === "review", "kind must be review");
  requireField(["approve", "request_changes", "unable_to_verify"].includes(r.verdict), "invalid verdict");
  requireField(["initial", "made_progress", "no_progress", "not_assessed"].includes(r.progress), "invalid progress");
  requireField(text(r.summary) && text(r.progressReason), "summary and progressReason are required");
  requireField(Array.isArray(r.blockingIssues) && r.blockingIssues.every(text), "blockingIssues must contain nonempty strings");
  requireField(r.reviewedHead === null || text(r.reviewedHead), "reviewedHead must be a nonempty string or null");
  if (r.verdict === "approve") {
    requireField(r.blockingIssues.length === 0, "approve cannot include blockingIssues");
    requireField(r.nextAction === null && r.nextStep === null, "approve cannot request nextAction or nextStep");
  } else {
    requireField(r.nextAction === "continue" || r.nextAction === "human_required", "nextAction is required");
    requireField(text(r.nextStep), "nextStep is required, including a changed approach for the first no-progress rework");
  }
  if (r.verdict === "unable_to_verify") {
    requireField(r.progress === "not_assessed" && r.nextAction === "human_required", "unable_to_verify requires not_assessed and human_required");
  } else {
    requireField(text(r.reviewedHead), "reviewedHead is required for a quality verdict");
    requireField(initialReview ? r.progress === "initial" : ["made_progress", "no_progress"].includes(r.progress),
      initialReview ? "initial review cannot assess rework progress" : "rework progress cannot be initial or not_assessed");
    requireField(r.verdict !== "approve" || r.progress !== "no_progress", "approve contradicts no_progress");
    requireField(r.verdict !== "request_changes" || r.blockingIssues.length > 0, "request_changes requires blockingIssues");
  }
  return r;
}

export function validateAgentResult(raw: unknown, initialReview: boolean): AgentResult {
  requireField(raw && typeof raw === "object" && !Array.isArray(raw), "result must be an object");
  const r = raw as AgentResult;
  if (r.kind === "review") return validateReviewResult(r, initialReview);
  requireField(r.kind === "implement" || r.kind === "blocked", "invalid kind");
  requireField(text(r.summary), "summary is required");
  if (r.kind === "implement") requireField(text(r.title) && text(r.head), "title and head are required");
  return r;
}

/** Stable halt codes: human_required, no_progress, session_limit, session_limit_unreviewed. */
export function decideResult(result: AgentResult, config: ServiceConfig, context: IterationContext): IterationDecision {
  const { sessions, limit, noProgress, hasRework } = context;
  requireField([sessions, limit, noProgress].every((n) => Number.isSafeInteger(n) && n >= 0) && limit > 0 && typeof hasRework === "boolean", "invalid iteration counters");
  validateAgentResult(result, !hasRework);
  let nextNoProgress = noProgress;
  const decision = (targetState: string, haltReason: string | null = null): IterationDecision => ({ targetState, haltReason, nextNoProgress });
  const halt = (reason: string) => decision(config.tracker.blockedState, reason);
  if (result.kind === "blocked") return halt("human_required");
  if (result.kind === "implement") {
    const target = config.tracker.handoffState;
    requireField(text(target), "configured handoffState is required");
    const needsReview = config.review?.states.some((s) => normalizeState(s) === normalizeState(target));
    return needsReview && sessions >= limit ? halt("session_limit_unreviewed") : decision(target);
  }
  requireField(config.review, "review result requires review configuration");
  if (result.verdict === "approve") {
    nextNoProgress = 0;
    return decision(config.review.passState);
  }
  if (result.progress === "made_progress") nextNoProgress = 0;
  if (result.progress === "no_progress") nextNoProgress++;
  if (result.nextAction === "human_required") return halt("human_required");
  if (nextNoProgress >= 2) return halt("no_progress");
  if (sessions >= limit) return halt("session_limit");
  return decision(config.review.failState);
}