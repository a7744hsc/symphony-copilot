import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { boardFindings, boardStates, desiredBoard, setupBoard, writeProjectNumber, type BoardSnapshot } from "../src/board.ts";
import { buildConfig } from "../src/config.ts";
import { parseSettings } from "../src/tracker/github-project.ts";

const WORKFLOW = `---
tracker:
  kind: github_project
  provider:
    owner: me
    owner_type: user
    repo: me/app
    start_state: Todo
    working_state: In Progress
    agent_states: [In Progress, Blocked]
    handoff_state: Human Review
    blocked_state: Blocked
    followups:
      labels: [tech-debt]
      state: Backlog
      priority: Later
  required_labels: [agent]
  active_states: [Todo, In Progress, Rework]
  terminal_states: [Done, Canceled]
merge_conflicts:
  states: [Human Review]
  return_state: Rework
hooks:
  after_create: git clone https://example.test/me/app.git .
---
Work on {{ issue.identifier }}.
`;

function load(text: string) {
  const raw = parseYaml(text.split("---")[1]!);
  const config = buildConfig(raw, "/repo/WORKFLOW.md", {});
  const settings = parseSettings({ project_number: 1, ...config.tracker.provider }, { SYMPHONY_GITHUB_TOKEN: "t" });
  return { config, settings };
}

test("board columns follow the workflow: parked, active in order, waiting, blocked, finished", () => {
  const { config, settings } = load(WORKFLOW);
  assert.deepEqual(boardStates(config, settings).map((s) => `${s.name}:${s.role}`), [
    "Backlog:other", "Todo:start", "In Progress:implement", "Rework:implement", "Human Review:waiting", "Blocked:blocked", "Done:terminal", "Canceled:terminal",
  ]);
  const desired = desiredBoard(config, settings);
  assert.deepEqual(desired.statusOptions.map((o) => o.color), ["GRAY", "YELLOW", "BLUE", "BLUE", "ORANGE", "RED", "GREEN", "GRAY"]);
  assert.match(desired.statusOptions[1]!.description, /Human.*authoriz.*agent/);
  assert.match(desired.statusOptions[2]!.description, /Scheduler.*agent/);
  assert.deepEqual(desired.priorityOptions.map((o) => o.name), ["P1", "P2", "P3", "P4", "Later"]);
  assert.deepEqual(desired.labels.map((l) => l.name), ["agent", "tech-debt"]);
});

test("Chinese board descriptions preserve configured column and label identifiers", () => {
  const { config, settings } = load(WORKFLOW.replace("tracker:", "language: zh-CN\ntracker:"));
  const desired = desiredBoard(config, settings);
  assert.deepEqual(desired.statusOptions.map((o) => o.name), boardStates(config, settings).map((s) => s.name));
  assert.match(desired.statusOptions.find((o) => o.name === "Todo")!.description, /人工.*"agent"/);
  assert.match(desired.statusOptions.find((o) => o.name === "Blocked")!.description, /人工.*"Todo"/);
  assert.equal(desired.priorityOptions[0]!.description, "优先处理");
  assert.deepEqual(desired.labels.map((l) => l.name), ["agent", "tech-debt"]);
  assert.match(desired.labels[1]!.description, /人工决定/);
});

test("custom lifecycle columns are deduplicated and keep their configured active order", () => {
  const text = WORKFLOW.replaceAll("Todo", "待开始").replaceAll("In Progress", "进行中")
    .replaceAll("Rework", "返工").replaceAll("Human Review", "人工审查").replaceAll("Blocked", "阻塞")
    .replace("state: Backlog", "state: 待开始")
    .replace("[待开始, 进行中, 返工]", "[返工, 待开始, 进行中, AI Review]")
    .replace("handoff_state: 人工审查", "handoff_state: AI Review")
    .replace("merge_conflicts:", "review:\n  states: [AI Review]\n  prompt_file: REVIEW.md\n  pass_state: 人工审查\n  fail_state: 返工\nmerge_conflicts:");
  const { config, settings } = load(text);
  const states = boardStates(config, settings);
  assert.deepEqual(states.map((s) => `${s.name}:${s.role}`), ["返工:implement", "待开始:start", "进行中:implement", "AI Review:review", "人工审查:waiting", "阻塞:blocked", "Done:terminal", "Canceled:terminal"]);
  const options = desiredBoard(config, settings).statusOptions;
  assert.match(options.find((s) => s.name === "AI Review")!.description, /Scheduler/);
  assert.match(options.find((s) => s.name === "阻塞")!.description, /待开始/);
});

test("the board check names missing columns, labels and a disruptive project workflow", () => {
  const { config, settings } = load(WORKFLOW);
  const snapshot: BoardSnapshot = {
    project: {
      id: "PVT_1", title: "app", url: "https://github.com/users/me/projects/1", closed: false, itemCount: 3,
      statusOptions: ["backlog", "Todo", "In Progress", "Rework", "Human Review", "Done", "Canceled"],
      priority: { dataType: "SINGLE_SELECT", options: ["P1", "P2"] },
      workflows: [{ name: "Pull request linked to issue", enabled: true }, { name: "Item closed", enabled: true }],
    },
    repo: { id: "R_1", labels: ["Agent"] },
  };
  assert.deepEqual(boardFindings(config, settings, snapshot).map((f) => `${f.level}: ${f.message.split(":")[0]}`), [
    'error: column "Blocked" (tracker.provider.blocked_state) is not an option of the board\'s "Status" field',
    'error: priority "Later" (tracker.provider.followups.priority) is not an option of the board\'s "Priority" field',
    'warning: project workflow "Pull request linked to issue" is enabled',
    'warning: label "tech-debt" (tracker.provider.followups.labels) does not exist in me/app; follow-ups are filed without it',
  ]);
  assert.match(boardFindings(config, settings, snapshot)[2]!.message, /inspect it at .*\/workflows if status transitions are unexpected/);
  assert.match(boardFindings(config, settings, { project: null, repo: null }).map((f) => f.message).join("\n"), /me#1 was not found[\s\S]*me\/app was not found/);
});

const front = (provider: string) => `---
# comment kept
tracker:
  kind: github_project
  provider:
${provider}
  active_states: [Todo, In Progress]   # flow list kept
  terminal_states: [Done]
---
Body with project_number: 99 in it
`;

test("the project number replaces an existing value and nothing else", () => {
  const text = front("    owner: me   # owner\n    project_number: 1   # board\n    repo: me/app");
  assert.equal(writeProjectNumber(text, 7), text.replace("project_number: 1 ", "project_number: 7 "));
  const quoted = front('    owner: me\n    project_number: "3"\n    repo: me/app');
  assert.equal(writeProjectNumber(quoted, 12), quoted.replace('"3"', "12"));
});

test("the project number fills an empty value or is added after owner_type", () => {
  const empty = front("    owner: me\n    project_number:   # filled in by setup-board\n    repo: me/app");
  assert.equal(writeProjectNumber(empty, 7), empty.replace("project_number:   #", "project_number: 7   #"));
  const missing = front("    owner: me\n    owner_type: user\n    repo: me/app");
  assert.equal(writeProjectNumber(missing, 7), missing.replace("owner_type: user\n", "owner_type: user\n    project_number: 7\n"));
  const crlf = missing.replaceAll("\n", "\r\n");
  assert.equal(writeProjectNumber(crlf, 7), crlf.replace("owner_type: user\r\n", "owner_type: user\r\n    project_number: 7\r\n"));
  assert.throws(() => writeProjectNumber(front("    { owner: me }").replace("  provider:\n    { owner: me }", "  provider: { owner: me }"), 7), /set project_number by hand/);
});

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; body: any }> = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

function setupDir(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "board-"));
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(path, text);
  return path;
}

function answers(...replies: Array<string | null>) {
  const asked: string[] = [];
  return { asked, ask: async (question: string) => { asked.push(question); return replies.shift() ?? null; } };
}

test("setup-board creates the board from the workflow and writes its number back", async () => {
  const path = setupDir(WORKFLOW);
  const { impl, calls } = fakeFetch([
    { data: { account: { id: "U_1" }, repository: { id: "R_1", labels: { nodes: [{ name: "Tech-Debt" }] } } } },
    { data: { createProjectV2: { projectV2: { id: "PVT_7", number: 7, url: "https://github.com/users/me/projects/7" } } } },
    { data: { node: { field: { id: "F_status" } } } },
    { data: { updateProjectV2Field: { projectV2Field: { id: "F_status" } } } },
    { data: { createProjectV2Field: { projectV2Field: { id: "F_priority" } } } },
    { name: "agent" },
  ]);
  const lines: string[] = [];
  const { ask, asked } = answers("y");
  const code = await setupBoard({ path, env: { SYMPHONY_GITHUB_TOKEN: "t" }, ask, print: (l) => lines.push(l), fetchImpl: impl });
  assert.equal(code, 0, lines.join("\n"));
  assert.deepEqual(asked, ["Go ahead? [y/N] "]);
  assert.equal(readFileSync(path, "utf8"), WORKFLOW.replace("owner_type: user\n", "owner_type: user\n    project_number: 7\n"));
  assert.ok(lines.includes(`Created board 7. Wrote project_number: 7 to ${path} (tracker.provider.project_number).`));
  assert.ok(lines.some((l) => l.includes("Labels:   agent (new), tech-debt (exists)")));
  assert.deepEqual(calls[1]!.body.variables, { owner: "U_1", title: "app", repo: "R_1" });
  assert.deepEqual(calls[3]!.body.variables.options.map((o: { name: string }) => o.name), ["Backlog", "Todo", "In Progress", "Rework", "Human Review", "Blocked", "Done", "Canceled"]);
  assert.equal(calls[3]!.body.variables.name, "Status");
  assert.equal(calls[4]!.body.variables.name, "Priority");
  assert.equal(calls[5]!.url, "https://api.github.com/repos/me/app/labels");
  assert.equal(calls[5]!.body.name, "agent");
  assert.ok(lines.some((l) => l.includes("No workflow changes are required.")));
  assert.ok(lines.some((l) => l.includes("inspect enabled workflows")));
  assert.ok(!lines.some((l) => l.includes('"Pull request linked to issue": turn it off')));
});

const EXISTING = WORKFLOW.replace("owner_type: user\n", "owner_type: user\n    project_number: 3\n");
const existingBoard = { data: { account: { projectV2: { id: "PVT_3", title: "Old", url: "https://github.com/users/me/projects/3", closed: false, items: { totalCount: 5 } } }, repository: null } };

test("an existing board is kept unless its number is typed", async () => {
  for (const replies of [[""], ["d", "4"], [null]]) {
    const path = setupDir(EXISTING);
    const { impl, calls } = fakeFetch([existingBoard]);
    const lines: string[] = [];
    const code = await setupBoard({ path, env: { SYMPHONY_GITHUB_TOKEN: "t" }, ask: answers(...replies).ask, print: (l) => lines.push(l), fetchImpl: impl, yes: true });
    assert.equal(code, replies[0] === "" ? 0 : 1, lines.join("\n"));
    assert.equal(calls.length, 1, "nothing but the lookup");
    assert.equal(readFileSync(path, "utf8"), EXISTING);
    assert.ok(lines[0]!.includes('already exists: "Old" https://github.com/users/me/projects/3 (5 cards)'));
  }
});

test("a typed number deletes the old board before the new one is created", async () => {
  const path = setupDir(EXISTING);
  const { impl, calls } = fakeFetch([
    existingBoard,
    { data: { account: { id: "U_1" }, repository: { id: "R_1", labels: { nodes: [{ name: "agent" }, { name: "tech-debt" }] } } } },
    { data: { deleteProjectV2: { projectV2: { id: "PVT_3" } } } },
    { data: { createProjectV2: { projectV2: { id: "PVT_8", number: 8, url: "https://github.com/users/me/projects/8" } } } },
    { data: { node: { field: { id: "F_status" } } } },
    { data: { updateProjectV2Field: { projectV2Field: { id: "F_status" } } } },
    { data: { createProjectV2Field: { projectV2Field: { id: "F_priority" } } } },
  ]);
  const lines: string[] = [];
  const code = await setupBoard({ path, env: { SYMPHONY_GITHUB_TOKEN: "t" }, ask: answers("d", "3", "y").ask, print: (l) => lines.push(l), fetchImpl: impl });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(calls[2]!.body.query, /deleteProjectV2/);
  assert.deepEqual(calls[2]!.body.variables, { id: "PVT_3" });
  assert.equal(readFileSync(path, "utf8"), EXISTING.replace("project_number: 3", "project_number: 8"));
});

test("setup-board refuses a workflow with errors", async () => {
  const path = setupDir(WORKFLOW.replace("blocked_state: Blocked", "blocked_state: Human Review"));
  const lines: string[] = [];
  const code = await setupBoard({ path, env: { SYMPHONY_GITHUB_TOKEN: "t" }, ask: answers().ask, print: (l) => lines.push(l), fetchImpl: fakeFetch([]).impl });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /fix them first[\s\S]*blocked_state "Human Review" must not be in merge_conflicts.states/);
});
