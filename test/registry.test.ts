import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildConfig } from "../src/config.ts";
import { assertUnchanged, canonical, live, record, register, runnerId } from "../src/registry.ts";
import { WorkflowStore } from "../src/workflow.ts";
import { captureLog } from "./helpers.ts";

const bin = resolve("bin/symphony");
const cli = resolve("src/cli.ts");
const fixture = resolve("test/runner-fixture.ts");
const base = () => mkdtempSync(join(tmpdir(), "symphony-runners-"));
const config = (workflow: string, root: string, project: number) => buildConfig({
  tracker: { kind: "github_project", provider: { owner: "Fixture", project_number: project }, active_states: ["Todo"], terminal_states: ["Done"] },
  workspace: { root },
}, workflow);

function command(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(bin, args, { env, encoding: "utf8", timeout: 10_000 });
}

async function followedLog(env: NodeJS.ProcessEnv, id: string, expected: string): Promise<string> {
  const child = spawn(bin, ["logs", id], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  for (let i = 0; i < 100 && !output.includes(expected); i++) await delay(20);
  child.kill("SIGINT");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  return output;
}

async function launch(env: NodeJS.ProcessEnv, id: string, workflow: string, root: string, project: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fixture, id, workflow, root, String(project)], { env, stdio: "pipe" });
  for (let i = 0; i < 100 && !existsSync(`${root}.fixture`); i++) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${child.exitCode}`);
    await delay(20);
  }
  assert.ok(existsSync(`${root}.fixture`), "fixture registered");
  return child;
}

test("two isolated workflows have independent ledgers, logs and targeted lifecycle", async () => {
  const dir = base();
  const env = { ...process.env, SYMPHONY_STATE_DIR: join(dir, "state") };
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  const rootA = join(dir, "workspace-a"), rootB = join(dir, "workspace-b");
  writeFileSync(a, "prompt a");
  writeFileSync(b, "prompt b");
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = await launch(env, "alpha", a, rootA, 1);
    second = await launch(env, "beta", b, rootB, 2);
    mkdirSync(join(env.SYMPHONY_STATE_DIR, "logs"));
    writeFileSync(join(env.SYMPHONY_STATE_DIR, "logs", "alpha.log"), "alpha-only\n");
    writeFileSync(join(env.SYMPHONY_STATE_DIR, "logs", "beta.log"), "beta-only\n");
    assert.notEqual(join(rootA, ".symphony-ledger.json"), join(rootB, ".symphony-ledger.json"));
    assert.match(command(env, "status", "alpha").stdout, /alpha: Running.*a\.md/);
    assert.doesNotMatch(command(env, "status", "alpha").stdout, /beta-only/);
    assert.match(command(env, "status", "beta").stdout, /beta: Running.*b\.md/);
    assert.equal(command(env, "stop").status, 1, "ambiguous stop must not kill either runner");
    const stopped = command(env, "stop", "alpha");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(command(env, "status", "beta").stdout, /beta: Running/);
    assert.equal(readFileSync(join(env.SYMPHONY_STATE_DIR, "logs", "beta.log"), "utf8"), "beta-only\n");
    assert.equal(command(env, "stop", "beta").status, 0);
    assert.match(command(env, "status", "alpha").stdout, /alpha: Not running/);
    assert.match(await followedLog(env, "alpha", "alpha-only"), /alpha-only/);
  } finally {
    if (first?.exitCode === null) first.kill("SIGTERM");
    if (second?.exitCode === null) second.kill("SIGTERM");
  }
});

test("duplicate project, nested/symlink roots and duplicate workflow are rejected before a CLI poll", async () => {
  const dir = base();
  const env = { ...process.env, SYMPHONY_STATE_DIR: join(dir, "state") };
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  const root = join(dir, "workspace");
  writeFileSync(a, "prompt a");
  writeFileSync(b, `---\ntracker:\n  kind: github_project\n  provider: { owner: FIXTURE, project_number: 1 }\n  active_states: [Todo]\n  terminal_states: [Done]\nworkspace: { root: ${join(dir, "other")} }\n---\nprompt b`);
  let child: ChildProcess | undefined;
  try {
    child = await launch(env, "first", a, root, 1);
    const result = spawnSync(process.execPath, [cli, b, "--once"], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub Project .*already managed by runner .*first/);
    const previous = process.env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    try {
      assert.throws(() => register("second", b, config(b, join(root, "nested"), 2)), /overlaps runner "first"/);
      symlinkSync(root, join(dir, "alias"));
      assert.equal(canonical(join(dir, "alias", "nested")), canonical(join(root, "nested")));
      assert.throws(() => register("second", b, config(b, join(dir, "alias", "nested"), 2)), /overlaps runner "first"/);
      assert.throws(() => register("second", a, config(a, join(dir, "other"), 2)), /already running as "first"/);
      assert.throws(() => register("first", b, config(b, join(dir, "other"), 2)), /belongs to/);
    } finally {
      if (previous === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previous;
    }
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
  }
});

test("single-runner commands work without IDs, stale PID is not treated as live, and reload retains safe config", async () => {
  const dir = base();
  const env = { ...process.env, SYMPHONY_STATE_DIR: join(dir, "state") };
  const wf = join(dir, "WORKFLOW.md");
  const root = join(dir, "workspace");
  const text = (project: number, workspace = root) => `---\ntracker:\n  kind: github_project\n  provider: { owner: fixture, project_number: ${project} }\n  active_states: [Todo]\n  terminal_states: [Done]\nworkspace: { root: ${workspace} }\n---\nprompt`;
  writeFileSync(wf, text(1));
  let child: ChildProcess | undefined;
  try {
    child = await launch(env, runnerId(wf), wf, root, 1);
    assert.match(command(env, "status").stdout, /Running/);
    const { log } = captureLog();
    const store = new WorkflowStore(wf, log);
    const entry = JSON.parse(readFileSync(`${root}.fixture`, "utf8")) as NonNullable<ReturnType<typeof record>>;
    store.onValidate((next) => assertUnchanged(next.config, entry));
    writeFileSync(wf, text(2));
    utimesSync(wf, 2_000_000_000, 2_000_000_000);
    assert.equal(store.refresh().config.tracker.provider.project_number, 1);
    assert.match(store.reloadError ?? "", /cannot change/);
    writeFileSync(wf, text(1, join(dir, "different")));
    utimesSync(wf, 2_000_000_100, 2_000_000_100);
    assert.equal(store.refresh().config.workspace.root, root);
    assert.match(store.reloadError ?? "", /cannot change/);
    store.close();
    assert.equal(command(env, "stop").status, 0);
    assert.match(command(env, "status").stdout, /Not running/);
    const previous = process.env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    try {
      assert.throws(() => register(runnerId(wf), join(dir, "other.md"), config(wf, join(dir, "different"), 2)), /belongs to/);
    } finally {
      if (previous === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previous;
    }
    assert.equal(live({ ...entry, started: "not the actual start time" }), false);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
  }
});
