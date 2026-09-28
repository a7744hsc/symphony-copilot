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
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

export const DEFAULT_SHELL_ALLOW = [
  "swift", "xcodebuild", "xcrun simctl", "xcrun xcresulttool", "xcrun swift", "git", "python3 tools/",
  "ls", "cat", "head", "tail", "grep", "rg", "find", "sed", "awk", "wc", "sort", "uniq", "diff", "cmp",
  "echo", "printf", "pwd", "cd", "mkdir", "cp", "mv", "rm", "touch", "test", "[", "true", "false",
  "which", "file", "du", "date", "basename", "dirname", "tee", "tr", "cut", "jq", "plutil", "sips", "sleep",
];

export const DEFAULT_SHELL_DENY = [
  "git push", "git remote", "git config", "git credential", "git submodule", "git -c", "git -C",
  "gh", "curl", "wget", "ssh", "scp", "sudo", "open", "osascript", "security", "launchctl", "defaults",
];

export const DEFAULT_READ_ALLOW = ["/Applications/Xcode.app", "/Library/Developer/CommandLineTools"];

const DEFAULT_CONTINUATION = [
  "继续处理 {{ issue.identifier }}（第 {{ turn }}/{{ max_turns }} 轮）。卡片当前状态仍是「{{ issue.state }}」。",
  "先检查工作区现状，接着完成剩余工作，不要重复已完成的步骤；完成后按工作流提交审核，遇到无法解决的阻塞就把卡片设为受阻并留言说明。",
].join("\n");

const DEFAULT_USER_INPUT_REPLY =
  "当前是无人值守运行，没有人能回答问题。请自行做出合理决定，并在 Issue 评论里写明假设；如果确实无法继续，用 tracker 工具把卡片设为受阻并说明原因。";

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
      maxRetryBackoffMs: integer(agent.max_retry_backoff_ms, 300_000, "agent.max_retry_backoff_ms", problems, 1_000),
      maxConcurrentAgentsByState: byState,
      continuationPrompt: text(agent.continuation_prompt, "agent.continuation_prompt", problems) ?? DEFAULT_CONTINUATION,
    },
    copilot: {
      cliPath: cliPathValue ? expandPath(cliPathValue, workflowDir, env) : null,
      model: text(copilot.model, "copilot.model", problems),
      reasoningEffort: text(copilot.reasoning_effort, "copilot.reasoning_effort", problems),
      maxAiCredits: optionalInteger(copilot.max_ai_credits, "copilot.max_ai_credits", problems, 1),
      startupTimeoutMs: integer(copilot.startup_timeout_ms, 60_000, "copilot.startup_timeout_ms", problems, 1),
      turnTimeoutMs: integer(copilot.turn_timeout_ms, 3_600_000, "copilot.turn_timeout_ms", problems, 1),
      stallTimeoutMs: integer(copilot.stall_timeout_ms, 300_000, "copilot.stall_timeout_ms", problems, -Infinity),
      shellAllow: stringList(copilot.shell_allow, DEFAULT_SHELL_ALLOW, "copilot.shell_allow", problems),
      shellDeny: stringList(copilot.shell_deny, DEFAULT_SHELL_DENY, "copilot.shell_deny", problems),
      readAllow: stringList(copilot.read_allow, DEFAULT_READ_ALLOW, "copilot.read_allow", problems).map((p) => expandPath(p, workflowDir, env)),
      urlAllow: stringList(copilot.url_allow, [], "copilot.url_allow", problems),
      userInputReply: text(copilot.user_input_reply, "copilot.user_input_reply", problems) ?? DEFAULT_USER_INPUT_REPLY,
    },
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
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
