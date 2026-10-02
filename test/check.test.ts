import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkWorkflow, unknownKeys, WORKFLOW_SCHEMA } from "../src/check.ts";
import { buildConfig } from "../src/config.ts";
import { parseSettings } from "../src/tracker/github-project.ts";

interface Node {
  properties?: Record<string, Node>;
  additionalProperties?: boolean | Node;
}

/** Every key path in the schema, and the paths whose values are free-form maps. */
function schemaPaths(node: Node, prefix = "", paths = new Set<string>(), maps = new Set<string>()) {
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    paths.add(path);
    if (typeof child.additionalProperties === "object") maps.add(path);
    schemaPaths(child, path, paths, maps);
  }
  return { paths, maps };
}

function tracked(value: Record<string, unknown>, seen: Set<string>, prefix = ""): Record<string, unknown> {
  return new Proxy(value, {
    get(target, prop, receiver) {
      const child = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return child;
      const path = prefix ? `${prefix}.${prop}` : prop;
      seen.add(path);
      return typeof child === "object" && child !== null && !Array.isArray(child) ? tracked(child as Record<string, unknown>, seen, path) : child;
    },
  });
}

const everyKey = {
  language: "en",
  tracker: {
    kind: "github_project",
    provider: {
      owner: "me", owner_type: "user", project_number: 1, repo: "me/app", token: "$TOKEN", endpoint: "https://api.github.com/graphql",
      status_field: "Status", priority_field: "Priority", identifier_prefix: "GH-", branch_prefix: "agent/", agent_states: ["In Progress", "Blocked"],
      start_state: "Todo", working_state: "In Progress", handoff_state: "AI Review", blocked_state: "Blocked", evidence_branch: "evidence",
      followups: { labels: ["tech-debt"], state: "Todo", priority: "P4", max_per_session: 2 },
    },
    required_labels: ["agent"],
    active_states: ["Todo", "In Progress", "Rework", "AI Review"],
    terminal_states: ["Done"],
  },
  polling: { interval_ms: 5000 },
  workspace: { root: "/tmp/ws" },
  hooks: { after_create: "git clone", before_run: "true", after_run: "true", before_remove: "true", timeout_ms: 1000 },
  agent: {
    max_concurrent_agents: 1, max_turns: 2, max_sessions: 3, usage_comments: false, max_retry_backoff_ms: 2000,
    max_concurrent_agents_by_state: { Todo: 1 }, continuation_prompt: "go on",
  },
  copilot: {
    cli_path: "/bin/copilot", model: "auto", reasoning_effort: "high",
    startup_timeout_ms: 1, turn_timeout_ms: 1, stall_timeout_ms: 0, shell_allow: ["npm test"], shell_deny: ["rm"],
    read_allow: ["/opt"], url_allow: ["https://example.test"], user_input_reply: "decide yourself",
  },
  review: {
    states: ["AI Review"], prompt_file: "REVIEW.md", model: "m", reasoning_effort: "high",
    pass_state: "Human Review", fail_state: "Rework", continuation_prompt: "keep reviewing",
  },
  merge_conflicts: { states: ["Human Review"], return_state: "Rework" },
};

test("the schema lists exactly the keys the orchestrator reads", () => {
  const { paths, maps } = schemaPaths(WORKFLOW_SCHEMA as Node);
  const seen = new Set<string>();
  const config = buildConfig(tracked(everyKey, seen), "/repo/WORKFLOW.md", {});
  parseSettings(config.tracker.provider, { TOKEN: "t0ken" });
  const read = new Set([...seen].map((path) => [...maps].find((map) => path.startsWith(`${map}.`)) ?? path));
  assert.deepEqual([...read].filter((p) => !paths.has(p)).sort(), [], "read by the code but missing from the schema");
  assert.deepEqual([...paths].filter((p) => !read.has(p)).sort(), [], "in the schema but never read");
  assert.deepEqual(unknownKeys(everyKey), []);
});

test("provider settings and runtime expose the same trimmed lifecycle mappings", () => {
  const raw = structuredClone(everyKey);
  raw.tracker.provider.start_state = " Todo ";
  raw.tracker.provider.working_state = " In Progress ";
  raw.tracker.provider.blocked_state = " Blocked ";
  raw.tracker.provider.handoff_state = " AI Review ";
  const config = buildConfig(raw, "/repo/WORKFLOW.md", {});
  const settings = parseSettings(config.tracker.provider, { TOKEN: "t" });
  for (const key of ["startState", "workingState", "blockedState", "handoffState"] as const) {
    assert.equal(config.tracker[key], settings[key]);
    assert.equal(settings[key], settings[key]?.trim());
  }
  for (const key of ["start_state", "working_state", "blocked_state"]) {
    for (const value of [undefined, null, " ", 42]) {
      assert.throws(() => parseSettings({ ...raw.tracker.provider, [key]: value }, { TOKEN: "t" }),
        new RegExp(`tracker.provider.${key} is required`));
    }
  }
});

function workflowFile(frontMatter: string, body = "Work on {{ issue.identifier }}: {{ issue.title }}", files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "check-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(path, `---\n${frontMatter.trim()}\n---\n${body}\n`);
  return path;
}

const base = `
tracker:
  kind: github_project
  provider:
    owner: me
    project_number: 1
    repo: me/app
    start_state: Todo
    working_state: In Progress
    handoff_state: Human Review
    blocked_state: Blocked
  required_labels: [agent]
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done]
hooks:
  after_create: git clone https://example.test/me/app.git .
`;

const messages = (path: string, env: NodeJS.ProcessEnv = { SYMPHONY_GITHUB_TOKEN: "t" }) =>
  checkWorkflow(path, env).findings.map((f) => `${f.level}: ${f.message}`);

test("a sound workflow has no findings", () => {
  assert.deepEqual(messages(workflowFile(base)), []);
});

test("offline language validation agrees with runtime validation", () => {
  for (const language of ["en", "zh-CN"]) {
    const path = workflowFile(`language: ${language}\n${base}`);
    assert.deepEqual(messages(path), []);
    assert.equal(checkWorkflow(path).config?.language, language);
  }
  for (const language of ["fr", "null", "false", "[]", '""']) {
    assert.match(messages(workflowFile(`language: ${language}\n${base}`)).join("\n"), /language must be "en" or "zh-CN"/);
  }
});

for (const [folder, language] of [["", "zh-CN"], ["examples", "en"]] as const) {
  test(`the ${folder || "repository"} workflow passes offline checks with only expected findings and uses ${language}`, () => {
    const result = checkWorkflow(join(import.meta.dirname, "..", folder, "WORKFLOW.md"), {});
    assert.deepEqual(result.findings, folder === "examples" ? [{
      level: "warning",
      message: "tracker.provider.project_number is not set: `symphony setup-board` creates the board and fills it in",
    }] : []);
    assert.equal(result.config?.language, language);
    assert.equal(result.tokenAvailable, false);
  });
}

test("misspelled keys are errors with a suggestion", () => {
  const path = workflowFile(`${base}\nagent:\n  max_turn: 3\n  colour: red\n`.replace("project_number: 1", "project_nubmer: 1"));
  const found = messages(path);
  assert.ok(found.includes("error: tracker.provider.project_nubmer: unknown key (did you mean project_number?)"), found.join("\n"));
  assert.ok(found.includes("error: agent.max_turn: unknown key (did you mean max_turns?)"));
  assert.ok(found.includes("error: agent.colour: unknown key"));
});

test("removed limits have actionable offline migration errors", () => {
  for (const [section, key] of [["copilot", "max_ai_credits"], ["copilot", "max_ai_credits_per_issue"], ["review", "max_rounds"]]) {
    const found = messages(workflowFile(`${base}\n${section}:\n  ${key}: null\n`));
    const migration = found.filter((m) => m.includes(`${section}.${key}`) && m.includes("removed") && m.includes("agent.max_sessions"));
    assert.equal(migration.length, 1, found.join("\n"));
  }
});

test("missing provider mappings and automatic returns to Todo fail offline too", () => {
  for (const key of ["start_state", "working_state", "blocked_state"]) {
    const found = messages(workflowFile(base.replace(new RegExp(`    ${key}: [^\\n]+\\n`), "")));
    assert.ok(found.some((m) => m.includes(`tracker.provider.${key} is required`)), found.join("\n"));
  }
  const found = messages(workflowFile(base.replace("handoff_state: Human Review", "handoff_state: Todo")));
  assert.ok(found.some((m) => m.includes("handoff_state") && m.includes("start_state")), found.join("\n"));
});

test("column roles that would loop or bypass limits are errors", () => {
  const path = workflowFile(base
    .replace("handoff_state: Human Review", "handoff_state: Rework")
    .replace("blocked_state: Blocked", "blocked_state: Human Review\n    followups:\n      labels: [Agent]")
    + "merge_conflicts:\n  states: [Human Review]\n  return_state: Rework\n");
  const found = messages(path);
  assert.ok(found.some((m) => m.startsWith('error: tracker.provider.blocked_state "Human Review" must not be in merge_conflicts.states')), found.join("\n"));
  assert.ok(found.some((m) => m.startsWith('error: tracker.provider.handoff_state "Rework" must not be an implementer state')));
  assert.ok(found.some((m) => m.startsWith('error: tracker.provider.followups.labels includes "Agent"')));
});

test("review states are checked against the implementer's columns", () => {
  const review = `${base.replace("[Todo, In Progress, Rework]", "[Todo, In Progress, Rework, AI Review]")}
review:
  states: [AI Review]
  prompt_file: REVIEW.md
  pass_state: Todo
  fail_state: AI Review
`;
  const found = messages(workflowFile(review, undefined, { "REVIEW.md": "Review {{ issue.identifier }} round {{ review_round }}" }));
  assert.ok(found.includes('error: review.pass_state "Todo" must not be an active state: approved work would be picked up again'));
  assert.ok(found.includes('error: review.fail_state "AI Review" must be an active state worked by the implementer'));
  const valid = messages(workflowFile(review.replace("pass_state: Todo", "pass_state: Human Review").replace("fail_state: AI Review", "fail_state: Rework"), undefined,
    { "REVIEW.md": "Review {{ issue.identifier }} round {{ review_round }}" }));
  assert.ok(valid.includes('warning: tracker.provider.handoff_state "Human Review" is not a review state: submissions skip the review agent'), valid.join("\n"));
  assert.ok(valid.some((m) => m.startsWith("warning: hooks.before_run does not look at SYMPHONY_ROLE")));
});

test("templates are rendered with a sample issue, including conditional branches", () => {
  const found = messages(workflowFile(`${base}\nreview:\n  states: [Rework]\n  prompt_file: MISSING.md\n  pass_state: Human Review\n  fail_state: In Progress\n`, "Work on {{ issue.identifer }}"));
  assert.ok(found.some((m) => m.startsWith("error: prompt:") && m.includes("identifer")), found.join("\n"));
  assert.ok(found.some((m) => m.startsWith("error: review.prompt_file") && m.includes("MISSING.md does not exist")));
  const branch = messages(workflowFile(base, "Work on {{ issue.identifier }}\n{% if attempt %}Attempt {{ attemps }}{% endif %}"));
  assert.ok(branch.some((m) => m.startsWith("error: prompt:") && m.includes("attemps")), branch.join("\n"));
});

test("review templates retain the review sequence, not a separate round cap", () => {
  const front = `${base}\nreview:\n  states: [Rework]\n  prompt_file: REVIEW.md\n  pass_state: Human Review\n  fail_state: In Progress\n`;
  const valid = messages(workflowFile(front, undefined, { "REVIEW.md": "Review {{ issue.identifier }} round {{ review_round }} in {{ implementer_workspace }}" }));
  assert.deepEqual(valid.filter((m) => m.startsWith("error:")), []);
  const removed = messages(workflowFile(front, undefined, { "REVIEW.md": "Review {{ review_round }} of {{ max_review_rounds }}" }));
  assert.ok(removed.some((m) => m.startsWith("error: review.prompt_file:") && m.includes("max_review_rounds")), removed.join("\n"));
});

test("a board that does not exist yet and a literal token are warnings", () => {
  const path = workflowFile(base.replace("    project_number: 1\n", "").replace("repo: me/app", "repo: me/app\n    token: ghp_secret"));
  const result = checkWorkflow(path, {});
  assert.equal(result.hasProjectNumber, false);
  assert.equal(result.tokenAvailable, true);
  assert.deepEqual(result.findings.map((f) => f.level), ["warning", "warning"]);
  assert.match(result.findings.map((f) => f.message).join("\n"), /literal token[\s\S]*setup-board/);
});

test("without a token the offline check still passes and reports it as unavailable", () => {
  const result = checkWorkflow(workflowFile(base), {});
  assert.deepEqual(result.findings, []);
  assert.equal(result.tokenAvailable, false);
  assert.equal(result.settings?.projectNumber, 1);
});
