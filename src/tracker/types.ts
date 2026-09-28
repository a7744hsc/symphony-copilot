import type { Tool } from "@github/copilot-sdk";
import type { Logger } from "../log.ts";
import type { Issue } from "../types.ts";

export type TrackerErrorCategory =
  | "unsupported_tracker_kind"
  | "invalid_tracker_config"
  | "missing_tracker_secret"
  | "tracker_request"
  | "tracker_status"
  | "tracker_response"
  | "tracker_pagination"
  | "tracker_rate_limited";

export class TrackerError extends Error {
  readonly category: TrackerErrorCategory;
  constructor(category: TrackerErrorCategory, message: string) {
    super(`${category}: ${message}`);
    this.category = category;
  }
}

export interface AgentToolContext {
  issue: Issue;
  workspacePath: string;
  log: Logger;
  /** Present when the agent is the reviewer; it then gets review tools instead of submit/status tools. */
  review?: ReviewToolContext;
}

export interface ReviewToolContext {
  round: number;
  maxRounds: number;
  passState: string;
  failState: string;
  onVerdict(verdict: "approve" | "request_changes"): void;
}

export interface MergeConflict {
  issue: Issue;
  pullRequest: { number: number; url: string; baseBranch: string };
}

/** Spec §11: a small read kernel plus optional provider-native agent tools. */
export interface TrackerAdapter {
  readonly kind: string;
  fetchIssuesByStates(states: string[]): Promise<Issue[]>;
  fetchIssuesByIds(ids: string[]): Promise<Issue[]>;
  /** Tools bound to one issue; executed in this process with the adapter's credential. */
  agentTools(context: AgentToolContext): Tool<any>[];
  /** Environment names that must not reach the agent process. */
  secretEnvironmentNames(): string[];
  /** Posts an orchestrator note on the issue. */
  commentOnIssue?(issue: Issue, body: string): Promise<void>;
  /** Moves the issue to the configured blocked state; returns that state, or null if none is configured. */
  blockIssue?(issue: Issue): Promise<string | null>;
  /** Issues whose open pull request the host reports as conflicting with its base branch; undecided ones are left out. */
  findMergeConflicts?(issues: Issue[]): Promise<MergeConflict[]>;
  moveIssue?(issue: Issue, state: string): Promise<void>;
}
