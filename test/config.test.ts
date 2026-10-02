import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildConfig, ConfigError, DEFAULT_SHELL_ALLOW, DEFAULT_SHELL_DENY, expandPath, roleFor, isActiveState, isRoutable, isTerminalState, resolveEnvRef } from "../src/config.ts";
import { makeConfig, makeIssue } from "./helpers.ts";

const provider = { start_state: "Todo", working_state: "In Progress", blocked_state: "Blocked", handoff_state: "Human Review" };
const minimal = { tracker: { kind: "github_project", provider, active_states: ["Todo", "In Progress"], terminal_states: ["Done"] } };
const reviewed = {
  tracker: { ...minimal.tracker, provider: { ...provider, handoff_state: "AI Review" }, active_states: ["Todo", "In Progress", "AI Review", "Rework"] },
  review: { states: ["AI Review"], prompt_file: "REVIEW.md", pass_state: "Human Review", fail_state: "Rework" },
};

test("defaults apply when optional values are missing", () => {
  const c = buildConfig(minimal, "/repo/WORKFLOW.md", {});
  assert.equal(c.language, "en");
  assert.equal(c.polling.intervalMs, 30_000);
  assert.equal(c.workspace.root, join(tmpdir(), "symphony_workspaces"));
  assert.equal(c.hooks.timeoutMs, 60_000);
  assert.equal(c.agent.maxConcurrentAgents, 10);
  assert.equal(c.agent.maxTurns, 20);
  assert.equal(c.agent.maxSessions, 20);
  assert.ok(!Object.hasOwn(c.copilot, "maxAiCredits"));
  assert.ok(!Object.hasOwn(c.copilot, "maxAiCreditsPerIssue"));
  assert.equal(c.agent.maxRetryBackoffMs, 300_000);
  assert.equal(c.copilot.turnTimeoutMs, 3_600_000);
  assert.equal(c.copilot.stallTimeoutMs, 300_000);
  assert.equal(c.copilot.cliPath, null);
  assert.deepEqual(c.copilot.shellAllow, DEFAULT_SHELL_ALLOW);
  assert.deepEqual(c.copilot.readAllow, []);
  assert.deepEqual(c.tracker.provider, provider);
  assert.equal(c.tracker.startState, "Todo");
  assert.equal(c.tracker.workingState, "In Progress");
  assert.equal(c.tracker.blockedState, "Blocked");
  assert.equal(c.tracker.handoffState, "Human Review");
});

test("language accepts only the two explicit workflow choices", () => {
  for (const language of ["en", "zh-CN"]) {
    assert.equal(buildConfig({ ...minimal, language }, "/repo/WORKFLOW.md", {}).language, language);
  }
  for (const language of [null, "", "zh", "ZH-CN", "en-US", "fr", " en ", 1, false, [], {}]) {
    assert.throws(() => buildConfig({ ...minimal, language }, "/repo/WORKFLOW.md", {}), /language must be "en" or "zh-CN"/);
  }
});

test("max_sessions is the single positive-integer authorization limit", () => {
  assert.equal(buildConfig({ ...minimal, agent: { max_sessions: "25" } }, "/repo/WORKFLOW.md", {}).agent.maxSessions, 25);
  for (const value of [0, -1, 1.5, "bad", false]) {
    assert.throws(() => buildConfig({ ...minimal, agent: { max_sessions: value } }, "/repo/WORKFLOW.md", {}), /agent.max_sessions must be an integer >= 1/);
  }
});

test("removed credit and review limits give explicit runtime migration errors even when empty", () => {
  for (const [section, key] of [["copilot", "max_ai_credits"], ["copilot", "max_ai_credits_per_issue"], ["review", "max_rounds"]]) {
    for (const value of [3, null, undefined]) {
      const raw = { ...reviewed, [section!]: { ...(section === "review" ? reviewed.review : {}), [key!]: value } };
      assert.throws(() => buildConfig(raw, "/repo/WORKFLOW.md", {}), (e: ConfigError) =>
        e.problems.some((p) => p.includes(`${section}.${key}`) && p.includes("removed") && p.includes("agent.max_sessions")));
    }
  }
  const inherited = Object.create({ max_ai_credits: 1, max_ai_credits_per_issue: 1 });
  assert.doesNotThrow(() => buildConfig({ ...minimal, copilot: inherited }, "/repo/WORKFLOW.md", {}));
  const unreadable = Object.defineProperty({}, "max_ai_credits", { get() { throw new Error("retired value must not be read"); } });
  assert.throws(() => buildConfig({ ...minimal, copilot: unreadable }, "/repo/WORKFLOW.md", {}),
    (e: ConfigError) => e instanceof ConfigError && e.problems.some((p) => p.includes("copilot.max_ai_credits was removed")));
});

test("GitHub lifecycle mappings are required, not inferred from active-state order", () => {
  for (const key of ["start_state", "working_state", "blocked_state"]) {
    for (const value of [undefined, null, "", "  ", 42]) {
      assert.throws(() => buildConfig({ tracker: { ...minimal.tracker, provider: { ...provider, [key]: value } } }, "/repo/WORKFLOW.md", {}),
        (e: ConfigError) => e.problems.some((p) => p.includes(`tracker.provider.${key}`)));
    }
  }
  const c = buildConfig({ tracker: {
    kind: "github_project", active_states: ["返工", " 进行中 ", "待开始"], terminal_states: ["完成"],
    provider: { start_state: " 待开始 ", working_state: "进行中", blocked_state: " 阻塞 ", handoff_state: "人工审查" },
  } }, "/repo/WORKFLOW.md", {});
  assert.equal(c.tracker.startState, "待开始");
  assert.equal(c.tracker.workingState, "进行中");
  assert.equal(c.tracker.blockedState, "阻塞");
  assert.equal(c.tracker.handoffState, "人工审查");
});

test("only fake test configurations get lifecycle defaults, and handoff remains optional", () => {
  const fake = makeConfig();
  assert.deepEqual([fake.tracker.startState, fake.tracker.workingState, fake.tracker.blockedState, fake.tracker.handoffState],
    ["Todo", "In Progress", "Blocked", "Human Review"]);
  assert.throws(() => makeConfig({ tracker: { kind: "github_project" } }), /tracker.provider.start_state is required/);
  const c = buildConfig({ tracker: { ...minimal.tracker, provider: { ...provider, handoff_state: undefined } } }, "/repo/WORKFLOW.md", {});
  assert.equal(c.tracker.handoffState, null);
  const original = makeIssue({ id: "item-old", identifier: "GH-9" });
  const readded = makeIssue({ id: "item-new", identifier: "GH-9" });
  assert.equal(original.nativeRef?.issue_id, readded.nativeRef?.issue_id);
  assert.notEqual(original.nativeRef?.project_item_id, readded.nativeRef?.project_item_id);
  assert.equal(original.nativeRef?.repository, "fake/repo");
});

test("runtime rejects mixed lifecycle roles and automatic returns to the authorization entry", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, start_state: " in progress " } } }, "start_state"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, working_state: "Missing" } } }, "working_state"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, start_state: "Missing" } } }, "start_state"],
    [{ review: { ...reviewed.review, states: ["Todo", "AI Review"] } }, "start_state"],
    [{ review: { ...reviewed.review, states: ["In Progress", "AI Review"] } }, "working_state"],
    [{ tracker: { ...reviewed.tracker, terminal_states: ["Done", "Todo"] } }, "terminal_states"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, agent_states: [" TODO "] } } }, "agent_states"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, handoff_state: " todo " } } }, "handoff_state"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, handoff_state: "Done" } } }, "handoff_state"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, handoff_state: "Blocked" } } }, "handoff_state"],
    [{ review: { ...reviewed.review, fail_state: " tOdO " } }, "review.fail_state"],
    [{ review: { ...reviewed.review, fail_state: "AI Review" } }, "review.fail_state"],
    [{ review: { ...reviewed.review, pass_state: "Todo" } }, "review.pass_state"],
    [{ review: { ...reviewed.review, pass_state: "Done" } }, "review.pass_state"],
    [{ review: { ...reviewed.review, pass_state: "Blocked" } }, "review.pass_state"],
    [{ merge_conflicts: { states: ["Human Review"], return_state: " todo " } }, "merge_conflicts.return_state"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, blocked_state: "In Progress" } } }, "blocked_state"],
    [{ tracker: { ...reviewed.tracker, provider: { ...reviewed.tracker.provider, blocked_state: "Done" } } }, "blocked_state"],
    [{ merge_conflicts: { states: [" blocked "], return_state: "Rework" } }, "blocked_state"],
  ];
  for (const [override, field] of cases) {
    assert.throws(() => buildConfig({ ...reviewed, ...override }, "/repo/WORKFLOW.md", {}),
      (e: ConfigError) => e.problems.some((p) => p.includes(field)), JSON.stringify(override));
  }
});

test("new follow-ups may enter Todo without dispatch labels, unlike existing-card transitions", () => {
  const raw = { ...minimal, tracker: { ...minimal.tracker, required_labels: ["agent"], provider: {
    ...provider, followups: { state: "Todo", labels: ["tech-debt"] },
  } } };
  assert.doesNotThrow(() => buildConfig(raw, "/repo/WORKFLOW.md", {}));
  assert.throws(() => buildConfig({ ...raw, tracker: { ...raw.tracker, provider: {
    ...raw.tracker.provider, followups: { state: "Todo", labels: [" Agent "] },
  } } }, "/repo/WORKFLOW.md", {}), /followups.labels.*required_labels/);
  assert.throws(() => buildConfig({ ...raw, tracker: { ...raw.tracker, required_labels: [] } }, "/repo/WORKFLOW.md", {}), /followups.*required_labels/);
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
  const p = { ...provider, owner: "me", custom: { a: 1 } };
  const c = buildConfig({ tracker: { ...minimal.tracker, provider: p } }, "/r/WORKFLOW.md", {});
  assert.deepEqual(c.tracker.provider, p);
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
  const c = makeConfig({ tracker: { provider: { start_state: "待开始" }, active_states: ["待开始", "In Progress"], terminal_states: ["Done"] } });
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

test("review config needs its states among the active states, a prompt file and both outcome states", () => {
  const base = { tracker: reviewed.tracker };
  const c = buildConfig({ ...base, review: { states: ["AI Review"], prompt_file: "REVIEW.md", model: "gpt-6-sol", pass_state: "Human Review", fail_state: "Rework" } }, "/repo/WORKFLOW.md", {});
  assert.equal(c.review?.promptFile, "/repo/REVIEW.md");
  assert.ok(c.review && !Object.hasOwn(c.review, "maxRounds"));
  assert.equal(roleFor(c, "ai review"), "review");
  assert.equal(roleFor(c, "Rework"), "implement");
  assert.equal(buildConfig(minimal, "/repo/WORKFLOW.md", {}).review, null);
  assert.throws(
    () => buildConfig({ ...base, review: { states: ["Checking"], prompt_file: "R.md", pass_state: "Human Review" } }, "/repo/WORKFLOW.md", {}),
    (e: ConfigError) => e.problems.some((p) => p.includes("must also be in tracker.active_states")) && e.problems.includes("review.fail_state is required"),
  );
});

test("merge_conflicts watches waiting states and returns cards to an implementation state", () => {
  const base = reviewed;
  const c = buildConfig({ ...base, merge_conflicts: { states: ["Human Review"], return_state: "Rework" } }, "/repo/WORKFLOW.md", {});
  assert.deepEqual(c.mergeConflicts, { states: ["Human Review"], returnState: "Rework" });
  assert.equal(buildConfig(minimal, "/repo/WORKFLOW.md", {}).mergeConflicts, null);
  const problems = (mc: unknown) => {
    try {
      buildConfig({ ...base, merge_conflicts: mc }, "/repo/WORKFLOW.md", {});
      return [];
    } catch (error) {
      return (error as ConfigError).problems;
    }
  };
  assert.ok(problems({ states: ["Rework"], return_state: "Rework" }).some((p) => p.includes('"Rework" must be a waiting state')));
  assert.ok(problems({ states: ["Human Review"], return_state: "AI Review" }).some((p) => p.includes("must be an active state worked by the implementer")));
  assert.ok(problems({ states: ["Human Review"], return_state: "Parked" }).some((p) => p.includes("must be an active state")));
  assert.deepEqual(problems({}), ["merge_conflicts.states is required", "merge_conflicts.return_state is required"]);
});
