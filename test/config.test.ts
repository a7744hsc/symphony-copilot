import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConfig, ConfigError, DEFAULT_SHELL_ALLOW, DEFAULT_SHELL_DENY, expandPath, isActiveState, isRoutable, isTerminalState, resolveEnvRef } from "../src/config.ts";
import { makeConfig, makeIssue } from "./helpers.ts";

const minimal = { tracker: { kind: "github_project", active_states: ["Todo"], terminal_states: ["Done"] } };

test("defaults apply when optional values are missing", () => {
  const c = buildConfig(minimal, "/repo/WORKFLOW.md", {});
  assert.equal(c.polling.intervalMs, 30_000);
  assert.equal(c.workspace.root, join(tmpdir(), "symphony_workspaces"));
  assert.equal(c.hooks.timeoutMs, 60_000);
  assert.equal(c.agent.maxConcurrentAgents, 10);
  assert.equal(c.agent.maxTurns, 20);
  assert.equal(c.agent.maxSessions, 5);
  assert.equal(c.copilot.maxAiCreditsPerIssue, null);
  assert.equal(c.agent.maxRetryBackoffMs, 300_000);
  assert.equal(c.copilot.turnTimeoutMs, 3_600_000);
  assert.equal(c.copilot.stallTimeoutMs, 300_000);
  assert.equal(c.copilot.cliPath, null);
  assert.deepEqual(c.copilot.shellAllow, DEFAULT_SHELL_ALLOW);
  assert.deepEqual(c.copilot.readAllow, []);
  assert.deepEqual(c.tracker.provider, {});
});

test("shell_allow and shell_deny add to the built-in lists", () => {
  const c = buildConfig({ ...minimal, copilot: { shell_allow: ["npm test"], shell_deny: ["rm"] } }, "/repo/WORKFLOW.md", {});
  assert.deepEqual(c.copilot.shellAllow, [...DEFAULT_SHELL_ALLOW, "npm test"]);
  assert.deepEqual(c.copilot.shellDeny, [...DEFAULT_SHELL_DENY, "rm"]);
});

test("workspace.root supports $VAR, ~ and paths relative to the workflow file", () => {
  assert.equal(buildConfig({ ...minimal, workspace: { root: "$WS" } }, "/repo/WORKFLOW.md", { WS: "/data/ws" }).workspace.root, "/data/ws");
  assert.equal(buildConfig({ ...minimal, workspace: { root: "~/ws" } }, "/repo/WORKFLOW.md", {}).workspace.root, join(homedir(), "ws"));
  assert.equal(buildConfig({ ...minimal, workspace: { root: "ws" } }, "/repo/WORKFLOW.md", {}).workspace.root, "/repo/ws");
  assert.equal(buildConfig({ ...minimal, workspace: { root: "$UNSET" } }, "/repo/WORKFLOW.md", {}).workspace.root, join(tmpdir(), "symphony_workspaces"));
});

test("$VAR resolution treats empty values as missing and leaves other strings alone", () => {
  assert.equal(resolveEnvRef("$TOKEN", { TOKEN: "abc" }), "abc");
  assert.equal(resolveEnvRef("$TOKEN", { TOKEN: "" }), null);
  assert.equal(resolveEnvRef("literal", {}), "literal");
  assert.equal(expandPath("$HOME_DIR/x", "/base", { HOME_DIR: "/h" }), "/h/x");
});

test("tracker provider keys are preserved for the adapter", () => {
  const c = buildConfig({ tracker: { ...minimal.tracker, provider: { owner: "me", custom: { a: 1 } } } }, "/r/WORKFLOW.md", {});
  assert.deepEqual(c.tracker.provider, { owner: "me", custom: { a: 1 } });
});

test("per-state concurrency normalizes keys and ignores invalid entries", () => {
  const c = buildConfig({ ...minimal, agent: { max_concurrent_agents_by_state: { " In Progress ": 2, Todo: 0, Rework: "x", Review: 1.5 } } }, "/r/WORKFLOW.md", {});
  assert.deepEqual(c.agent.maxConcurrentAgentsByState, { "in progress": 2 });
});

test("invalid values fail validation with every problem listed", () => {
  assert.throws(
    () => buildConfig({ tracker: {}, hooks: { timeout_ms: -1 }, agent: { max_turns: 0 } }, "/r/WORKFLOW.md", {}),
    (e: ConfigError) => e.problems.includes("tracker.kind is required")
      && e.problems.includes("tracker.active_states is required")
      && e.problems.some((p) => p.startsWith("hooks.timeout_ms"))
      && e.problems.some((p) => p.startsWith("agent.max_turns")),
  );
});

test("state comparisons ignore case and surrounding whitespace", () => {
  const c = makeConfig({ tracker: { active_states: ["待开始", "In Progress"], terminal_states: ["Done"] } });
  assert.ok(isActiveState(c, " in progress "));
  assert.ok(isActiveState(c, "待开始"));
  assert.ok(!isActiveState(c, "Done"));
  assert.ok(isTerminalState(c, "DONE"));
});

test("routing needs dispatchable plus every required label; a blank label matches nothing", () => {
  const c = makeConfig({ tracker: { required_labels: [" Agent "] } });
  assert.ok(isRoutable(c, makeIssue({ labels: ["agent", "bug"] })));
  assert.ok(!isRoutable(c, makeIssue({ labels: ["bug"] })));
  assert.ok(!isRoutable(c, makeIssue({ dispatchable: false })));
  assert.ok(!isRoutable(makeConfig({ tracker: { required_labels: [" "] } }), makeIssue()));
});
