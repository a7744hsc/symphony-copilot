import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isLanguage, type Language } from "./language.ts";
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
  /** Successfully created implementer and reviewer sessions per issue authorization. */
  maxSessions: number;
  /** Best-effort usage footer on the session's issue result; never a separate usage comment. */
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
  language: Language;
  workflowPath: string;
  workflowDir: string;
  tracker: {
    kind: string;
    provider: Record<string, unknown>;
    requiredLabels: string[];
    activeStates: string[];
    terminalStates: string[];
    /** Trimmed provider mappings, preserving column spelling; compare with normalizeState. */
    startState: string;
    workingState: string;
    blockedState: string;
    handoffState: string | null;
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

/** Shared migration diagnostics for startup, reload and the offline key checker. */
export const REMOVED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  "copilot.max_ai_credits": "copilot.max_ai_credits was removed: remove this key; costs are recorded only. Use agent.max_sessions (default 20) for the shared session limit, not a credit limit.",
  "copilot.max_ai_credits_per_issue": "copilot.max_ai_credits_per_issue was removed: remove this key; costs are recorded only. Use agent.max_sessions (default 20) for the shared session limit, not a credit limit.",
  "review.max_rounds": "review.max_rounds was removed: remove this key and use agent.max_sessions (default 20), shared by implementer and reviewer sessions; review_round remains a sequence number only.",
};

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
  "Check the current state of the workspace first, then finish the remaining work without repeating completed steps. Recover any unread feedback, test counterexamples to the goal's invariants, and fix the failure class rather than only the reported example.",
  "When done, submit a complete handoff for the issue: changes, verification evidence, prior blockers addressed, relevant human PR feedback, constraints and remaining risks. Keep solving in-scope failures. If a required external dependency, authorization, human decision or confirmed inability prevents progress, call tracker_comment with blocking=true and the reason, attempted steps/results and concrete human action needed, then tracker_set_status to the configured blocked state and stop.",
].join("\n");

const DEFAULT_USER_INPUT_REPLY =
  "This is an automated unattended reply, not human approval; nobody can answer questions here. Follow the autonomous planning protocol using issue and repository evidence. Make reasonable in-scope decisions and record material assumptions on the issue; keep solving failures within current permissions. Do not invent requirements or broaden authorization. If a required external dependency, authorization, human decision or confirmed inability prevents progress, record what you tried, what is missing and the concrete human action needed. As implementer, call tracker_comment with blocking=true and that complete reason, then tracker_set_status to the configured blocked state. As reviewer, call tracker_submit_review with verdict=unable_to_verify, progress=not_assessed and next_action=human_required; supply summary, progress_reason and next_step, and reviewed_head (null only if unavailable). Do not merely comment and remain active.";

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
  const language = raw.language === undefined ? "en" : raw.language;
  if (!isLanguage(language)) problems.push('language must be "en" or "zh-CN"');
  const workflowDir = dirname(resolve(workflowPath));
  const tracker = section(raw, "tracker", problems);
  const polling = section(raw, "polling", problems);
  const workspace = section(raw, "workspace", problems);
  const hooks = section(raw, "hooks", problems);
  const agent = section(raw, "agent", problems);
  const copilot = section(raw, "copilot", problems);
  const review = raw.review === undefined || raw.review === null ? null : section(raw, "review", problems);
  const conflicts = raw.merge_conflicts === undefined || raw.merge_conflicts === null ? null : section(raw, "merge_conflicts", problems);

  for (const [path, message] of Object.entries(REMOVED_CONFIG_KEYS)) {
    const [name, key] = path.split(".");
    const source = name === "copilot" ? copilot : review;
    // Presence, even null/undefined, is an error. Do not read retired keys through the schema drift Proxy.
    if (source && Object.hasOwn(source, key!)) problems.push(message);
  }

  const kind = text(tracker.kind, "tracker.kind", problems);
  if (!kind) problems.push("tracker.kind is required");
  const rawProvider = tracker.provider ?? {};
  const provider = typeof rawProvider === "object" && !Array.isArray(rawProvider) ? rawProvider as Record<string, unknown> : {};
  if (provider !== rawProvider) problems.push("tracker.provider must be a map");
  const requiredState = (key: string): string => {
    const value = text(provider[key], `tracker.provider.${key}`, problems)?.trim();
    if (!value) problems.push(`tracker.provider.${key} is required; explicitly map the lifecycle column`);
    return value ?? "";
  };
  const startState = requiredState("start_state");
  const workingState = requiredState("working_state");
  const blockedState = requiredState("blocked_state");
  const handoffState = text(provider.handoff_state, "tracker.provider.handoff_state", problems)?.trim() || null;
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
    language: isLanguage(language) ? language : "en",
    workflowPath: resolve(workflowPath),
    workflowDir,
    tracker: {
      kind: kind ?? "",
      provider,
      requiredLabels: stringList(tracker.required_labels, [], "tracker.required_labels", problems).map((l) => l.trim().toLowerCase()),
      activeStates,
      terminalStates,
      startState,
      workingState,
      blockedState,
      handoffState,
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
      maxSessions: integer(agent.max_sessions, 20, "agent.max_sessions", problems, 1),
      usageComments: bool(agent.usage_comments, true, "agent.usage_comments", problems),
      maxRetryBackoffMs: integer(agent.max_retry_backoff_ms, 300_000, "agent.max_retry_backoff_ms", problems, 1_000),
      maxConcurrentAgentsByState: byState,
      continuationPrompt: text(agent.continuation_prompt, "agent.continuation_prompt", problems) ?? DEFAULT_CONTINUATION,
    },
    copilot: {
      cliPath: cliPathValue ? expandPath(cliPathValue, workflowDir, env) : null,
      model: text(copilot.model, "copilot.model", problems),
      reasoningEffort: text(copilot.reasoning_effort, "copilot.reasoning_effort", problems),
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
  validateLifecycle(config, problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Safety rules belong in runtime config loading too, not just `symphony check`. */
function validateLifecycle(config: ServiceConfig, problems: string[]): void {
  const { provider, activeStates, terminalStates, startState, workingState, blockedState, handoffState, requiredLabels } = config.tracker;
  const same = (a: string, b: string) => normalizeState(a) === normalizeState(b);
  const has = (states: string[], state: string) => states.some((s) => same(s, state));
  const reviewStates = config.review?.states ?? [];
  const implementer = (state: string) => has(activeStates, state) && !has(terminalStates, state) && !has(reviewStates, state);
  for (const state of activeStates) {
    if (has(terminalStates, state)) problems.push(`tracker.active_states "${state}" must not also be in tracker.terminal_states`);
  }
  if (startState && workingState && same(startState, workingState)) {
    problems.push("tracker.provider.start_state and tracker.provider.working_state must be different columns");
  }
  for (const [key, state] of [["start_state", startState], ["working_state", workingState]]) {
    if (state && !implementer(state)) problems.push(`tracker.provider.${key} "${state}" must be an active state worked by the implementer, not a review or terminal state`);
  }
  const noStartTarget = (key: string, state: string | null) => {
    if (state && startState && same(state, startState)) {
      problems.push(`${key} "${state}" must not target tracker.provider.start_state: only people authorize existing cards there`);
    }
  };
  for (const state of stringList(provider.agent_states, [], "tracker.provider.agent_states", problems)) {
    noStartTarget("tracker.provider.agent_states", state);
  }
  noStartTarget("tracker.provider.handoff_state", handoffState);
  if (blockedState) {
    if (has(activeStates, blockedState)) problems.push(`tracker.provider.blocked_state "${blockedState}" must not be an active state: halted cards are moved there to take them away from agents`);
    if (has(terminalStates, blockedState)) problems.push(`tracker.provider.blocked_state "${blockedState}" must be a waiting state, not in tracker.terminal_states`);
    if (has(config.mergeConflicts?.states ?? [], blockedState)) {
      problems.push(`tracker.provider.blocked_state "${blockedState}" must not be in merge_conflicts.states: conflict recovery must not restart halted cards`);
    }
  }
  if (handoffState) {
    if (implementer(handoffState)) problems.push(`tracker.provider.handoff_state "${handoffState}" must not be an implementer state: the agent would start again right after submitting`);
    if (has(terminalStates, handoffState) || same(handoffState, blockedState)) {
      problems.push(`tracker.provider.handoff_state "${handoffState}" must be a review or human waiting state, not a blocked or terminal state`);
    }
  }
  if (config.review) {
    const { passState, failState } = config.review;
    noStartTarget("review.pass_state", passState);
    noStartTarget("review.fail_state", failState);
    if (has(activeStates, passState)) problems.push(`review.pass_state "${passState}" must not be an active state: approved work would be picked up again`);
    if (has(terminalStates, passState) || same(passState, blockedState)) problems.push(`review.pass_state "${passState}" must be a human waiting state, not a blocked or terminal state`);
    if (failState && !implementer(failState)) problems.push(`review.fail_state "${failState}" must be an active state worked by the implementer`);
  }
  noStartTarget("merge_conflicts.return_state", config.mergeConflicts?.returnState ?? null);

  const followups = provider.followups;
  if (followups && typeof followups === "object" && !Array.isArray(followups)) {
    const f = followups as Record<string, unknown>;
    for (const label of stringList(f.labels, [], "tracker.provider.followups.labels", problems)) {
      if (requiredLabels.includes(label.trim().toLowerCase())) {
        problems.push(`tracker.provider.followups.labels includes "${label}" from tracker.required_labels: follow-ups would be worked on without a person deciding`);
      }
    }
    if (typeof f.state === "string" && has(activeStates, f.state) && requiredLabels.length === 0) {
      problems.push("tracker.provider.followups.state in an active column requires nonempty tracker.required_labels: new follow-ups must not dispatch automatically");
    }
  }
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
  "Continue reviewing {{ issue.identifier }} (turn {{ turn }} of {{ max_turns }}). Finish the remaining risk-based coverage, including affected unchanged lifecycle code and independent counterexamples; do not stop at the first defect or repeat completed checks. Recover missing context and mark unverified areas explicitly; do not approve material unread code or feedback. Remove your disposable tests before calling tracker_submit_review with all confirmed findings and a complete issue handoff, including relevant human PR feedback and constraints. Supply reviewed_head, progress and evidence in progress_reason using the initial-versus-formal-rework context already supplied; commit counts alone do not prove progress. For request_changes supply blocking_issues, next_action and a concrete next_step (a changed approach for no_progress); for approve leave blockers empty and next_action/next_step null. If required verification is impossible, submit verdict=unable_to_verify, progress=not_assessed and next_action=human_required, with missing conditions, attempted checks and the human action in next_step; reviewed_head may be null if unavailable. Do not just comment and stop or invent a quality defect.";

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
