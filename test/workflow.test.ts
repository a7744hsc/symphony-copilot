import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadWorkflow, parseWorkflow, WorkflowError, WorkflowStore } from "../src/workflow.ts";
import { captureLog } from "./helpers.ts";

const VALID = `---
tracker:
  kind: github_project
  provider:
    start_state: Todo
    working_state: In Progress
    blocked_state: Blocked
  active_states: [Todo, In Progress]
  terminal_states: [Done]
polling:
  interval_ms: 5000
---

Hello {{ issue.identifier }}
`;

test("front matter becomes config and the trimmed body the prompt", () => {
  const wf = parseWorkflow(VALID);
  assert.deepEqual(wf.config.polling, { interval_ms: 5000 });
  assert.equal(wf.promptTemplate, "Hello {{ issue.identifier }}");
});

test("a file without front matter is all prompt with empty config", () => {
  const wf = parseWorkflow("  just a prompt \n");
  assert.deepEqual(wf.config, {});
  assert.equal(wf.promptTemplate, "just a prompt");
});

test("empty front matter is an empty map", () => {
  assert.deepEqual(parseWorkflow("---\n---\nbody").config, {});
});

test("non-map front matter is a typed error", () => {
  assert.throws(() => parseWorkflow("---\n- a\n- b\n---\nbody"), (e: WorkflowError) => e.code === "workflow_front_matter_not_a_map");
});

test("invalid YAML and unclosed front matter are parse errors", () => {
  assert.throws(() => parseWorkflow("---\na: [1,\n---\n"), (e: WorkflowError) => e.code === "workflow_parse_error");
  assert.throws(() => parseWorkflow("---\na: 1\n"), (e: WorkflowError) => e.code === "workflow_parse_error");
});

test("a missing file is a typed error", () => {
  assert.throws(() => loadWorkflow("/nonexistent/WORKFLOW.md"), (e: WorkflowError) => e.code === "missing_workflow_file");
});

test("store applies valid edits and keeps the last good config on invalid ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-"));
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(path, VALID);
  const { log, lines } = captureLog();
  const store = new WorkflowStore(path, log, {});
  assert.equal(store.workflow.config.polling.intervalMs, 5000);

  const bump = (text: string, mtime: number) => {
    writeFileSync(path, text);
    utimesSync(path, mtime, mtime);
  };
  bump(VALID.replace("5000", "7000"), 2_000_000_000);
  assert.equal(store.refresh().config.polling.intervalMs, 7000);
  assert.equal(store.reloadError, null);

  bump("---\ntracker: [broken\n---\n", 2_000_000_100);
  assert.equal(store.refresh().config.polling.intervalMs, 7000);
  assert.match(store.reloadError ?? "", /workflow_parse_error/);
  assert.ok(lines.some((l) => l.includes("keeping last good config")));

  bump(VALID, 2_000_000_200);
  assert.equal(store.refresh().config.polling.intervalMs, 5000);
  assert.equal(store.reloadError, null);
});

test("language reload replaces the config without mutating running snapshots and rejects unsupported languages", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wf-language-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "WORKFLOW.md");
  const { log } = captureLog();
  writeFileSync(path, VALID);
  const store = new WorkflowStore(path, log, {});
  const original = store.workflow;
  writeFileSync(path, VALID.replace("tracker:", "language: zh-CN\ntracker:"));
  utimesSync(path, 2_000_000_000, 2_000_000_000);
  assert.equal(store.refresh().config.language, "zh-CN");
  assert.equal(original.config.language, "en");
  assert.equal(store.reloadError, null);
  writeFileSync(path, VALID.replace("tracker:", "language: fr\ntracker:"));
  utimesSync(path, 2_000_000_100, 2_000_000_100);
  assert.equal(store.refresh().config.language, "zh-CN");
  assert.match(store.reloadError!, /language must be "en" or "zh-CN"/);
});
