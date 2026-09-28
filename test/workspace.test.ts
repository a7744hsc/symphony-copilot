import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scrubEnvironment } from "../src/env.ts";
import { assertInsideRoot, runHook, WorkspaceError, workspaceKey, WorkspaceManager, workspacePath } from "../src/workspace.ts";
import { makeConfig, makeIssue, quietLog } from "./helpers.ts";

function setup(hooks: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ws-root-"));
  const config = makeConfig({ workspace: { root }, hooks: { timeout_ms: 2000, ...hooks } });
  return { root, config, manager: new WorkspaceManager(quietLog, scrubEnvironment(process.env, [])) };
}

test("workspace keys keep safe identifiers and hash sanitized ones", () => {
  assert.equal(workspaceKey("GH-12"), "GH-12");
  assert.equal(workspaceKey("ABC_1.2"), "ABC_1.2");
  const a = workspaceKey("repo#12");
  const b = workspaceKey("repo/12");
  assert.match(a, /^repo_12-[0-9a-f]{16}$/);
  assert.notEqual(a, b, "identifiers that sanitize alike stay distinct");
  assert.equal(workspaceKey("repo#12"), a, "deterministic");
  assert.notEqual(workspaceKey(".."), "..");
  assert.notEqual(workspaceKey("."), ".");
});

test("workspace paths must stay inside the root", () => {
  assert.equal(workspacePath("/w", "GH-1"), "/w/GH-1");
  assert.throws(() => assertInsideRoot("/w", "/w"), WorkspaceError);
  assert.throws(() => assertInsideRoot("/w", "/w/../etc"), WorkspaceError);
  assert.throws(() => assertInsideRoot("/w", "/other"), WorkspaceError);
});

test("after_create runs only when the directory is new; reuse keeps contents", async () => {
  const { config, manager } = setup({ after_create: "echo created >> marker.txt; echo \"$SYMPHONY_ISSUE_IDENTIFIER $SYMPHONY_ISSUE_BRANCH\" > env.txt" });
  const issue = makeIssue({ identifier: "GH-5", branchName: "agent/5" });
  const first = await manager.prepare(config, issue);
  assert.equal(first.createdNow, true);
  const second = await manager.prepare(config, issue);
  assert.equal(second.createdNow, false);
  assert.equal(second.path, first.path);
  assert.equal(readFileSync(join(first.path, "marker.txt"), "utf8"), "created\n");
  assert.equal(readFileSync(join(first.path, "env.txt"), "utf8"), "GH-5 agent/5\n");
});

test("a failing after_create aborts creation and removes the new directory", async () => {
  const { config, manager, root } = setup({ after_create: "exit 3" });
  await assert.rejects(manager.prepare(config, makeIssue({ identifier: "GH-9" })), (e: WorkspaceError) => e.code === "hook_failed");
  assert.equal(existsSync(join(root, "GH-9")), false);
});

test("an existing non-directory at the workspace path fails safely", async () => {
  const { config, manager, root } = setup();
  writeFileSync(join(root, "GH-2"), "file");
  await assert.rejects(manager.prepare(config, makeIssue({ identifier: "GH-2" })), (e: WorkspaceError) => e.code === "workspace_create_failed");
});

test("a symlinked workspace pointing outside the root is rejected", async () => {
  const { config, manager, root } = setup();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  symlinkSync(outside, join(root, "GH-3"));
  await assert.rejects(manager.prepare(config, makeIssue({ identifier: "GH-3" })), (e: WorkspaceError) => e.code === "invalid_workspace_path");
});

test("before_run failure is fatal, after_run failure is not", async () => {
  const { config, manager } = setup({ before_run: "exit 1", after_run: "exit 1" });
  const issue = makeIssue();
  const ws = await manager.prepare(config, issue);
  await assert.rejects(manager.hook(config, "before_run", ws, issue, true), WorkspaceError);
  await manager.hook(config, "after_run", ws, issue, false);
});

test("hooks time out and their process group is killed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hook-"));
  const started = Date.now();
  const result = await runHook("sleep 30", dir, 300, scrubEnvironment(process.env, []));
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5_000);
});

test("remove runs before_remove, ignores its failure, and deletes the directory", async () => {
  const { config, manager } = setup({ before_remove: "touch ../removed-hook-ran; exit 1" });
  const issue = makeIssue({ identifier: "GH-4" });
  const ws = await manager.prepare(config, issue);
  mkdirSync(join(ws.path, "sub"));
  await manager.remove(config, issue);
  assert.equal(existsSync(ws.path), false);
  assert.equal(existsSync(join(ws.path, "..", "removed-hook-ran")), true);
  await manager.remove(config, issue);
});

test("scrubbed environments drop secret names", () => {
  const env = scrubEnvironment({ PATH: "/bin", GH_TOKEN: "x", SYMPHONY_GITHUB_TOKEN: "y" }, ["GH_TOKEN", "SYMPHONY_GITHUB_TOKEN"]);
  assert.deepEqual(env, { PATH: "/bin" });
});
