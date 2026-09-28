import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeState, type Issue } from "./types.ts";

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  /** Copilot sessions allowed per issue per run (until the issue leaves the active states). */
  maxSessions: number;
  /** Post a usage summary on the issue after every session. */
  usageComments: boolean;
  maxRetryBackoffMs: number;
  /** Keys are normalized state names. */
  maxConcurrentAgentsByState: Record<string, number>;
  continuationPrompt: string;
}

export interface CopilotConfig {
  /** Copilot CLI to launch; null uses the runtime bundled with the SDK. */
  cliPath: string | null;
  model: string | null;
  reasoningEffort: string | null;
  maxAiCredits: number | null;
  /** Enforced by the orchestrator across sessions; the model is never told about it. */
  maxAiCreditsPerIssue: number | null;
  startupTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  shellAllow: string[];
  shellDeny: string[];
  readAllow: string[];
  urlAllow: string[];
  userInputReply: string;
}

export interface ServiceConfig {
  workflowPath: string;
  workflowDir: string;
  tracker: {
    kind: string;
    provider: Record<string, unknown>;
    requiredLabels: string[];
    activeStates: string[];
    terminalStates: string[];
  };
  polling: { intervalMs: number };
  workspace: { root: string };
  hooks: HooksConfig;
  agent: AgentConfig;
  copilot: CopilotConfig;
  review: ReviewConfig | null;
  mergeConflicts: MergeConflictConfig | null;
}

/** Cards waiting for people whose pull request stops merging go back to the implementer, ahead of other work. */
export interface MergeConflictConfig {
  /** Waiting (not active) states whose open pull requests are checked on every poll. */
  states: string[];
  /** Implementation state the card is moved to. */
  returnState: string;
}

/** An independent reviewer agent that works the review states in its own session and workspace. */
export interface ReviewConfig {
  states: string[];
  promptFile: string;
  model: string | null;
  reasoningEffort: string | null;
  passState: string;
  failState: string;
  maxRounds: number;
  continuationPrompt: string;
}

export type Role = "implement" | "review";

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Always allowed; `copilot.shell_allow` adds the project's own build and test commands. */
export const DEFAULT_SHELL_ALLOW = [
  "git",
  "ls", "cat", "head", "tail", "grep", "rg", "find", "sed", "awk", "wc", "sort", "uniq", "diff", "cmp",
  "echo", "printf", "pwd", "cd", "mkdir", "cp", "mv", "rm", "touch", "test", "[", "true", "false", "exit",
  "which", "file", "du", "date", "basename", "dirname", "tee", "tr", "cut", "jq", "sleep",
];

export const DEFAULT_SHELL_DENY = [
  "git push", "git remote", "git config", "git credential", "git submodule", "git -c", "git -C",
  "gh", "curl", "wget", "ssh", "scp", "sudo", "open", "osascript", "security", "launchctl", "defaults",
];

const DEFAULT_CONTINUATION = [
  "Continue working on {{ issue.identifier }} (turn {{ turn }} of {{ max_turns }}). The card is still in \"{{ issue.state }}\".",
  "Check the current state of the workspace first, then finish the remaining work without repeating completed steps.",
  "When you are done, submit for review as the workflow describes. If you hit a blocker you cannot resolve, comment with the reason and move the card to the blocked state.",
].join("\n");

const DEFAULT_USER_INPUT_REPLY =
  "This is an unattended run and nobody can answer questions. Make a reasonable decision yourself and write down your assumptions in an issue comment. If you really cannot continue, comment with the reason and move the card to the blocked state.";

const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/** `$NAME` -> env value; empty or unset resolves to null (treated as missing). */
export function resolveEnvRef(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value !== "string") return value;
  const match = ENV_REF.exec(value.trim());
  if (!match) return value;
  const resolved = env[match[1]!];
  return resolved === undefined || resolved === "" ? null : resolved;
}

export function expandPath(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  let path = value.trim().replace(/^\$([A-Za-z_][A-Za-z0-9_]*)/, (_, name: string) => env[name] ?? "");
  if (path === "~" || path.startsWith("~/")) path = join(homedir(), path.slice(1));
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

function section(raw: Record<string, unknown>, key: string, problems: string[]): Record<string, unknown> {
  const value = raw[key];
  if (value === undefined || value === null) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  problems.push(`${key} must be a map`);
  return {};
}

function integer(value: unknown, fallback: number, name: string, problems: string[], min = 0): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n === "number" && Number.isInteger(n) && n >= min) return n;
  problems.push(`${name} must be an integer >= ${min}`);
  return fallback;
}

function optionalInteger(value: unknown, name: string, problems: string[], min: number): number | null {
  return value === undefined || value === null ? null : integer(value, 0, name, problems, min);
}

function bool(value: unknown, fallback: boolean, name: string, problems: string[]): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  problems.push(`${name} must be true or false`);
  return fallback;
}

function text(value: unknown, name: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  problems.push(`${name} must be a string`);
  return null;
}

function stringList(value: unknown, fallback: string[], name: string, problems: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  problems.push(`${name} must be a list of strings`);
  return fallback;
}

export function buildConfig(raw: Record<string, unknown>, workflowPath: string, env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const problems: string[] = [];
  const workflowDir = dirname(resolve(workflowPath));
  const tracker = section(raw, "tracker", problems);
  const polling = section(raw, "polling", problems);
  const workspace = section(raw, "workspace", problems);
  const hooks = section(raw, "hooks", problems);
  const agent = section(raw, "agent", problems);
  const copilot = section(raw, "copilot", problems);
  const review = raw.review === undefined || raw.review === null ? null : section(raw, "review", problems);
  const conflicts = raw.merge_conflicts === undefined || raw.merge_conflicts === null ? null : section(raw, "merge_conflicts", problems);

  const kind = text(tracker.kind, "tracker.kind", problems);
  if (!kind) problems.push("tracker.kind is required");
  const provider = tracker.provider ?? {};
  if (typeof provider !== "object" || Array.isArray(provider)) problems.push("tracker.provider must be a map");
  const activeStates = stringList(tracker.active_states, [], "tracker.active_states", problems);
  const terminalStates = stringList(tracker.terminal_states, [], "tracker.terminal_states", problems);
  if (activeStates.length === 0) problems.push("tracker.active_states is required");
  if (terminalStates.length === 0) problems.push("tracker.terminal_states is required");

  const byState: Record<string, number> = {};
  const rawByState = agent.max_concurrent_agents_by_state;
  if (rawByState && typeof rawByState === "object" && !Array.isArray(rawByState)) {
    for (const [state, limit] of Object.entries(rawByState)) {
      if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) byState[normalizeState(state)] = limit;
    }
  }

  const rootValue = resolveEnvRef(workspace.root, env);
  const root = typeof rootValue === "string" && rootValue.trim() !== ""
    ? expandPath(rootValue, workflowDir, env)
    : join(tmpdir(), "symphony_workspaces");

  const cliPathValue = text(copilot.cli_path, "copilot.cli_path", problems);
  const reviewConfig = review ? buildReview(review, activeStates, workflowDir, env, problems) : null;

  const config: ServiceConfig = {
    workflowPath: resolve(workflowPath),
    workflowDir,
    tracker: {
      kind: kind ?? "",
      provider: typeof provider === "object" && provider !== null && !Array.isArray(provider) ? provider as Record<string, unknown> : {},
      requiredLabels: stringList(tracker.required_labels, [], "tracker.required_labels", problems).map((l) => l.trim().toLowerCase()),
      activeStates,
      terminalStates,
    },
    polling: { intervalMs: integer(polling.interval_ms, 30_000, "polling.interval_ms", problems, 1_000) },
    workspace: { root },
    hooks: {
      afterCreate: text(hooks.after_create, "hooks.after_create", problems),
      beforeRun: text(hooks.before_run, "hooks.before_run", problems),
      afterRun: text(hooks.after_run, "hooks.after_run", problems),
      beforeRemove: text(hooks.before_remove, "hooks.before_remove", problems),
      timeoutMs: integer(hooks.timeout_ms, 60_000, "hooks.timeout_ms", problems, 1),
    },
    agent: {
      maxConcurrentAgents: integer(agent.max_concurrent_agents, 10, "agent.max_concurrent_agents", problems, 1),
      maxTurns: integer(agent.max_turns, 20, "agent.max_turns", problems, 1),
      maxSessions: integer(agent.max_sessions, 5, "agent.max_sessions", problems, 1),
      usageComments: bool(agent.usage_comments, true, "agent.usage_comments", problems),
      maxRetryBackoffMs: integer(agent.max_retry_backoff_ms, 300_000, "agent.max_retry_backoff_ms", problems, 1_000),
      maxConcurrentAgentsByState: byState,
      continuationPrompt: text(agent.continuation_prompt, "agent.continuation_prompt", problems) ?? DEFAULT_CONTINUATION,
    },
    copilot: {
      cliPath: cliPathValue ? expandPath(cliPathValue, workflowDir, env) : null,
      model: text(copilot.model, "copilot.model", problems),
      reasoningEffort: text(copilot.reasoning_effort, "copilot.reasoning_effort", problems),
      maxAiCredits: optionalInteger(copilot.max_ai_credits, "copilot.max_ai_credits", problems, 1),
      maxAiCreditsPerIssue: optionalInteger(copilot.max_ai_credits_per_issue, "copilot.max_ai_credits_per_issue", problems, 1),
      startupTimeoutMs: integer(copilot.startup_timeout_ms, 60_000, "copilot.startup_timeout_ms", problems, 1),
      turnTimeoutMs: integer(copilot.turn_timeout_ms, 3_600_000, "copilot.turn_timeout_ms", problems, 1),
      stallTimeoutMs: integer(copilot.stall_timeout_ms, 300_000, "copilot.stall_timeout_ms", problems, -Infinity),
      shellAllow: [...DEFAULT_SHELL_ALLOW, ...stringList(copilot.shell_allow, [], "copilot.shell_allow", problems)],
      shellDeny: [...DEFAULT_SHELL_DENY, ...stringList(copilot.shell_deny, [], "copilot.shell_deny", problems)],
      readAllow: stringList(copilot.read_allow, [], "copilot.read_allow", problems).map((p) => expandPath(p, workflowDir, env)),
      urlAllow: stringList(copilot.url_allow, [], "copilot.url_allow", problems),
      userInputReply: text(copilot.user_input_reply, "copilot.user_input_reply", problems) ?? DEFAULT_USER_INPUT_REPLY,
    },
    review: reviewConfig,
    mergeConflicts: conflicts ? buildMergeConflicts(conflicts, activeStates, terminalStates, reviewConfig, problems) : null,
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

function buildReview(raw: Record<string, unknown>, activeStates: string[], workflowDir: string, env: NodeJS.ProcessEnv, problems: string[]): ReviewConfig {
  const states = stringList(raw.states, [], "review.states", problems);
  if (states.length === 0) problems.push("review.states is required");
  const active = new Set(activeStates.map(normalizeState));
  for (const state of states) {
    if (!active.has(normalizeState(state))) problems.push(`review state "${state}" must also be in tracker.active_states`);
  }
  const required = (key: string) => {
    const value = text(raw[key], `review.${key}`, problems);
    if (!value) problems.push(`review.${key} is required`);
    return value ?? "";
  };
  const promptFile = required("prompt_file");
  return {
    states,
    promptFile: promptFile ? expandPath(promptFile, workflowDir, env) : "",
    model: text(raw.model, "review.model", problems),
    reasoningEffort: text(raw.reasoning_effort, "review.reasoning_effort", problems),
    passState: required("pass_state"),
    failState: required("fail_state"),
    maxRounds: integer(raw.max_rounds, 3, "review.max_rounds", problems, 1),
    continuationPrompt: text(raw.continuation_prompt, "review.continuation_prompt", problems) ?? DEFAULT_REVIEW_CONTINUATION,
  };
}

function buildMergeConflicts(raw: Record<string, unknown>, activeStates: string[], terminalStates: string[], review: ReviewConfig | null, problems: string[]): MergeConflictConfig {
  const has = (list: string[], state: string) => list.some((s) => normalizeState(s) === normalizeState(state));
  const states = stringList(raw.states, [], "merge_conflicts.states", problems);
  if (states.length === 0) problems.push("merge_conflicts.states is required");
  for (const state of states) {
    if (has(activeStates, state) || has(terminalStates, state)) problems.push(`merge_conflicts state "${state}" must be a waiting state, not in tracker.active_states or tracker.terminal_states`);
  }
  const returnState = text(raw.return_state, "merge_conflicts.return_state", problems);
  if (!returnState) problems.push("merge_conflicts.return_state is required");
  else if (!has(activeStates, returnState) || has(terminalStates, returnState) || has(review?.states ?? [], returnState)) {
    problems.push(`merge_conflicts.return_state "${returnState}" must be an active state worked by the implementer`);
  }
  return { states, returnState: returnState ?? "" };
}

const DEFAULT_REVIEW_CONTINUATION =
  "Continue reviewing {{ issue.identifier }} (turn {{ turn }} of {{ max_turns }}). Do not repeat checks you already ran. When you have a verdict, call tracker_submit_review.";

/** Review states are worked by the reviewer; every other active state by the implementer. */
export function roleFor(config: ServiceConfig, state: string): Role {
  const s = normalizeState(state);
  return config.review?.states.some((r) => normalizeState(r) === s) ? "review" : "implement";
}

export function isActiveState(config: ServiceConfig, state: string): boolean {
  const s = normalizeState(state);
  return config.tracker.activeStates.some((a) => normalizeState(a) === s)
    && !config.tracker.terminalStates.some((t) => normalizeState(t) === s);
}

export function isTerminalState(config: ServiceConfig, state: string): boolean {
  const s = normalizeState(state);
  return config.tracker.terminalStates.some((t) => normalizeState(t) === s);
}

/** Adapter eligibility plus required labels; a blank required label matches nothing. */
export function isRoutable(config: ServiceConfig, issue: Issue): boolean {
  return issue.dispatchable && config.tracker.requiredLabels.every((label) => label !== "" && issue.labels.includes(label));
}
