import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunLedger } from "../src/ledger.ts";
import { canonicalPath, pathFromFileUrl, projectIdentity, RunnerManager, startSelection, workflowId } from "../src/management.ts";
import { createLogger } from "../src/log.ts";
import { WorkflowStore } from "../src/workflow.ts";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const wrapper = join(import.meta.dirname, "..", "bin", "symphony");

function workflow(dir: string, name: string, project: number, root: string): string {
  const folder = join(dir, name);
  mkdirSync(folder);
  const file = join(folder, "WORKFLOW.md");
  writeFileSync(file, `---
tracker:
  kind: github_project
  provider:
    owner: Me
    repo: me/${name}
    project_number: ${project}
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${root}
---
Prompt for ${name}: {{ issue.identifier }}
`);
  return file;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "symphony-manager-"));
  const state = join(dir, "state");
  const children: ChildProcess[] = [];
  const manager = new RunnerManager(state, cli, {
    launch: (wf, env, _log, _foreground, instance) => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", cli, wf, `--symphony-runner-instance=${instance}`], { stdio: "ignore", env });
      children.push(child);
      return child;
    },
  });
  return { dir, state, manager, children };
}

test("two live workflows retain separate prompts, ledgers, logs and targeted lifecycle", { skip: process.platform === "win32" }, async (t) => {
  const { dir, state, manager, children } = fixture();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const first = workflow(dir, "first", 1, join(dir, "work-first"));
  const second = workflow(dir, "second", 2, join(dir, "work-second"));
  const a = await manager.start(first, "alpha");
  const b = await manager.start(second, "beta");
  assert.notEqual(a.record.pid, b.record.pid);
  assert.equal(manager.isRunning(a.record), true);
  assert.equal(manager.isRunning(b.record), true);
  assert.match(new WorkflowStore(first, createLogger("error")).workflow.definition.promptTemplate, /first/);
  assert.match(new WorkflowStore(second, createLogger("error")).workflow.definition.promptTemplate, /second/);

  const ledgerA = new RunLedger(join(a.record.workspace, ".symphony-ledger.json"));
  ledgerA.open("same-issue-id", "ONE", new Date(0));
  ledgerA.save();
  const ledgerB = new RunLedger(join(b.record.workspace, ".symphony-ledger.json"));
  ledgerB.open("same-issue-id", "TWO", new Date(0));
  ledgerB.save();
  assert.equal(new RunLedger(ledgerA.path).get("same-issue-id")?.identifier, "ONE");
  assert.equal(new RunLedger(ledgerB.path).get("same-issue-id")?.identifier, "TWO");
  writeFileSync(manager.logPath("alpha"), "alpha event\n");
  writeFileSync(manager.logPath("beta"), "level=warn msg=beta_event\n");
  assert.equal(readFileSync(manager.logPath("beta"), "utf8"), "level=warn msg=beta_event\n");
  const status = spawnSync(wrapper, ["status", "beta"], { env: { ...process.env, SYMPHONY_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /beta: Running/);
  assert.match(status.stdout, /beta_event/);
  assert.doesNotMatch(status.stdout, /alpha event/);
  const logs = spawn(wrapper, ["logs", "beta"], { env: { ...process.env, SYMPHONY_STATE_DIR: state } });
  let timeout: NodeJS.Timeout | undefined;
  const seen = await Promise.race([
    new Promise<string>((done) => logs.stdout.once("data", (data: Buffer) => done(data.toString()))),
    new Promise<string>((_, reject) => { timeout = setTimeout(() => reject(new Error("logs beta did not produce output")), 3000); }),
  ]);
  clearTimeout(timeout);
  logs.kill("SIGTERM");
  await new Promise<void>((done) => logs.once("exit", () => done()));
  assert.match(seen, /beta_event/);
  assert.doesNotMatch(seen, /alpha event/);
  assert.equal(spawnSync(wrapper, ["stop"], { env: { ...process.env, SYMPHONY_STATE_DIR: state }, encoding: "utf8" }).status, 1);
  const stop = spawn(wrapper, ["stop", "alpha"], { env: { ...process.env, SYMPHONY_STATE_DIR: state } });
  let output = "";
  stop.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  const [stopCode] = await Promise.all([
    new Promise<number | null>((done) => stop.once("exit", done)),
    new Promise<void>((done) => children[0]!.once("exit", () => done())),
  ]);
  assert.equal(stopCode, 0);
  assert.match(output, /alpha: stopped/);
  assert.equal(manager.isRunning(a.record), false);
  assert.equal(manager.isRunning(b.record), true);
  assert.equal(await manager.stop("beta"), true);
  await new Promise<void>((done) => children[1]!.once("exit", () => done()));
});

test("a stale record cannot stop a runner whose workflow path shares its prefix", { skip: process.platform === "win32" }, async (t) => {
  const { dir, manager, children } = fixture();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const staleWorkflow = workflow(dir, "workflow", 20, join(dir, "stale-work"));
  const liveWorkflow = workflow(dir, "workflow-other", 21, join(dir, "live-work"));
  const live = await manager.start(liveWorkflow, "live");
  const stale = {
    ...live.record,
    id: "stale",
    workflow: staleWorkflow,
    instance: live.record.instance!.slice(0, -1),
  };
  mkdirSync(join(manager.root, "runners", stale.id), { recursive: true });
  writeFileSync(join(manager.root, "runners", stale.id, "runner.json"), `${JSON.stringify(stale)}\n`);

  assert.equal(await manager.stop("stale"), false);
  assert.equal(manager.isRunning(live.record), true);
  assert.equal(await manager.stop("live"), true);
  await new Promise<void>((done) => children[0]!.once("exit", () => done()));
});

test("default launch accepts a CLI path containing spaces", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "symphony manager-"));
  const scriptUrl = new URL("runner%20checkout/cli.mjs", new URL(`file://${dir}/`));
  const script = pathFromFileUrl(scriptUrl);
  mkdirSync(join(dir, "runner checkout"), { recursive: true });
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const manager = new RunnerManager(join(dir, "state"), script);
  const file = workflow(dir, "spaced", 22, join(dir, "work"));
  const started = await manager.start(file, "spaced");
  t.after(() => { if (started.child.exitCode === null) started.child.kill(); });

  assert.equal(manager.isRunning(started.record), true);
  assert.equal(await manager.stop("spaced"), true);
  await new Promise<void>((done) => started.child.once("exit", () => done()));
});

test("reject duplicate projects, overlapping workspace roots, aliases and IDs before launch", { skip: process.platform === "win32" }, async (t) => {
  const { dir, manager, children } = fixture();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const root = join(dir, "work");
  const a = workflow(dir, "one", 7, root);
  const duplicate = workflow(dir, "two", 7, join(dir, "other"));
  const overlap = workflow(dir, "three", 8, join(root, "nested"));
  const alias = join(dir, "alias");
  mkdirSync(root);
  symlinkSync(root, alias);
  const viaAlias = workflow(dir, "four", 9, join(alias, "nested"));
  await manager.start(a, "one");
  await assert.rejects(manager.start(duplicate, "two"), /GitHub Project .*already has runner one/);
  await assert.rejects(manager.start(overlap, "three"), /workspace.root .*overlaps runner one/);
  await assert.rejects(manager.start(viaAlias, "four"), /workspace.root .*overlaps runner one/);
  await assert.rejects(manager.start(a, "another"), /already registered as one/);
  await assert.rejects(manager.start(a, "../escape"), /workflow ID must/);
  assert.equal(children.length, 1);
  await manager.stop("one");
  await new Promise<void>((done) => children[0]!.once("exit", () => done()));
  await assert.rejects(manager.start(overlap, "three"), /workspace.root .*overlaps runner one/);
  const next = await manager.start(duplicate, "two");
  assert.equal(manager.isRunning(next.record), true);
  await manager.stop("two");
  await new Promise<void>((done) => children[1]!.once("exit", () => done()));
});

test("single-workflow default ID is stable and restart preserves the record", { skip: process.platform === "win32" }, async (t) => {
  const { dir, state, manager, children } = fixture();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const file = workflow(dir, "single", 12, join(dir, "work"));
  const a = await manager.start(file, undefined);
  assert.equal(a.record.id, workflowId(file));
  assert.equal(manager.lastId(), a.record.id);
  assert.equal(canonicalPath(file), a.record.workflow);
  await manager.stop(a.record.id);
  await new Promise<void>((done) => children[0]!.once("exit", () => done()));
  const b = await manager.start(file, undefined);
  assert.equal(b.record.id, a.record.id);
  const status = spawnSync(wrapper, ["status"], { env: { ...process.env, SYMPHONY_STATE_DIR: state }, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`${a.record.id}: Running`));
  await manager.stop(b.record.id);
  await new Promise<void>((done) => children[1]!.once("exit", () => done()));
});

test("no-argument start migrates the legacy remembered workflow", { skip: process.platform === "win32" }, async (t) => {
  const { dir, state, manager, children } = fixture();
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const file = workflow(dir, "legacy", 13, join(dir, "work"));
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, ".last-workflow"), `${file}\n`);

  const selected = startSelection(undefined, manager.records(), manager, join(dir, "missing-current-workflow"));
  assert.deepEqual(selected, { workflow: file });
  const started = await manager.start(selected.workflow, selected.id);
  assert.equal(started.record.workflow, canonicalPath(file));
  assert.equal(manager.lastId(), started.record.id);
  assert.equal(manager.isRunning(started.record), true);

  await manager.stop(started.record.id);
  await new Promise<void>((done) => children[0]!.once("exit", () => done()));
});

test("managed workflow reload refuses project or workspace changes without replacing its prompt/config", () => {
  const dir = mkdtempSync(join(tmpdir(), "symphony-reload-"));
  const file = workflow(dir, "repo", 3, join(dir, "root"));
  const initial = new WorkflowStore(file, createLogger("error"));
  const identity = projectIdentity(initial.workflow.config);
  const root = canonicalPath(initial.workflow.config.workspace.root);
  const store = new WorkflowStore(file, createLogger("error"), process.env, (config) => {
    if (projectIdentity(config) !== identity || canonicalPath(config.workspace.root) !== root) throw new Error("managed identity changed");
  });
  writeFileSync(file, readFileSync(file, "utf8").replace("project_number: 3", "project_number: 4").replace("Prompt for repo", "Changed prompt"));
  store.refresh();
  assert.match(store.reloadError ?? "", /managed identity changed/);
  assert.equal(projectIdentity(store.workflow.config), identity);
  assert.match(store.workflow.definition.promptTemplate, /Prompt for repo/);
  writeFileSync(file, readFileSync(file, "utf8").replace("project_number: 4", "project_number: 3").replace(`root: ${join(dir, "root")}`, `root: ${join(dir, "other")}`));
  store.refresh();
  assert.match(store.reloadError ?? "", /managed identity changed/);
  assert.equal(canonicalPath(store.workflow.config.workspace.root), root);
  store.close();
  initial.close();
});
