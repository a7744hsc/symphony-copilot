import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { buildConfig } from "../src/config.ts";
import { RunLedger } from "../src/ledger.ts";
import { assertUnchanged, canonical, live, record, register, runnerId, validateId } from "../src/registry.ts";
import { loadWorkflow, WorkflowStore } from "../src/workflow.ts";
import { captureLog } from "./helpers.ts";

const bin = resolve("bin/symphony");
const cli = resolve("src/cli.ts");
const fixture = resolve("test/runner-fixture.ts");
const base = () => mkdtempSync(join(tmpdir(), "symphony-runners-"));
const environment = (dir: string, state = "state") => ({
  ...process.env,
  SYMPHONY_GITHUB_TOKEN: "fixture-token",
  SYMPHONY_STATE_DIR: join(dir, state),
  SYMPHONY_TEST_HOST_STATE_DIR: join(dir, "host-state"),
});
const config = (workflow: string, root: string, project: number) => buildConfig({
  tracker: {
    kind: "github_project",
    provider: { owner: "Fixture", project_number: project, repo: "fixture/repo" },
    active_states: ["Todo"],
    terminal_states: ["Done"],
  },
  workspace: { root },
}, workflow);
const workflowText = (root: string, project: number, prompt: string, owner = "Fixture", ownerType = "user") =>
  `---
tracker:
  kind: github_project
  provider: { owner: ${JSON.stringify(owner)}, owner_type: ${JSON.stringify(ownerType)}, project_number: ${project}, repo: fixture/repo }
  active_states: [Todo]
  terminal_states: [Done]
workspace: { root: ${JSON.stringify(root)} }
---
${prompt}`;
const reviewWorkflowText = (root: string, project: number, promptFile: string, prompt = "implementation prompt") =>
  `---
tracker:
  kind: github_project
  provider: { owner: Fixture, project_number: ${project}, repo: fixture/repo }
  active_states: [Todo, AI Review]
  terminal_states: [Done]
workspace: { root: ${JSON.stringify(root)} }
review:
  states: [AI Review]
  prompt_file: ${JSON.stringify(promptFile)}
  pass_state: Human Review
  fail_state: Rework
---
${prompt}`;

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

async function launch(env: NodeJS.ProcessEnv, id: string, workflow: string, root: string, sessions: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [fixture, id, workflow, String(sessions)], { env, stdio: "pipe" });
  for (let i = 0; i < 100 && !existsSync(`${root}.fixture`); i++) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${child.exitCode}`);
    await delay(20);
  }
  assert.ok(existsSync(`${root}.fixture`), "fixture registered");
  return child;
}

test("two isolated workflows have independent ledgers, logs and targeted lifecycle", async () => {
  const dir = base();
  const env = environment(dir);
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  const rootA = join(dir, "workspace-a"), rootB = join(dir, "workspace-b");
  writeFileSync(a, workflowText(rootA, 1, "prompt a"));
  writeFileSync(b, workflowText(rootB, 2, "prompt b"));
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    first = await launch(env, "alpha", a, rootA, 3);
    second = await launch(env, "beta", b, rootB, 1);
    const firstFixture = JSON.parse(readFileSync(`${rootA}.fixture`, "utf8"));
    const secondFixture = JSON.parse(readFileSync(`${rootB}.fixture`, "utf8"));
    assert.deepEqual(
      [firstFixture.prompt, firstFixture.projectNumber, secondFixture.prompt, secondFixture.projectNumber],
      ["prompt a", 1, "prompt b", 2],
    );
    assert.equal(new RunLedger(join(rootA, ".symphony-ledger.json")).get("shared-item")?.sessions, 3);
    assert.equal(new RunLedger(join(rootB, ".symphony-ledger.json")).get("shared-item")?.sessions, 1);
    mkdirSync(join(env.SYMPHONY_STATE_DIR!, "logs"), { recursive: true });
    writeFileSync(join(env.SYMPHONY_STATE_DIR!, "logs", "alpha.log"), "alpha-only\n");
    writeFileSync(join(env.SYMPHONY_STATE_DIR!, "logs", "beta.log"), "beta-only\n");
    assert.match(command(env, "status", "alpha").stdout, /alpha: Running.*a\.md/);
    assert.doesNotMatch(command(env, "status", "alpha").stdout, /beta-only/);
    assert.match(command(env, "status", "beta").stdout, /beta: Running.*b\.md/);
    assert.equal(command(env, "stop").status, 1, "ambiguous stop must not kill either runner");
    const stopped = command(env, "stop", "alpha");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(command(env, "status", "beta").stdout, /beta: Running/);
    assert.equal(readFileSync(join(env.SYMPHONY_STATE_DIR!, "logs", "beta.log"), "utf8"), "beta-only\n");
    assert.equal(new RunLedger(join(rootB, ".symphony-ledger.json")).get("shared-item")?.sessions, 1);
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
  const env = environment(dir);
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  const root = join(dir, "workspace");
  writeFileSync(a, workflowText(root, 1, "prompt a"));
  writeFileSync(b, workflowText(join(dir, "other"), 1, "prompt b", " fixture ", " user "));
  let child: ChildProcess | undefined;
  try {
    child = await launch(env, "first", a, root, 1);
    const result = spawnSync(process.execPath, [cli, b, "--once"], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub Project .*already managed by runner .*first/);
    const previous = process.env.SYMPHONY_STATE_DIR;
    const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
    try {
      assert.throws(() => register("second", b, config(b, join(root, "nested"), 2)), /overlaps runner "first"/);
      assert.throws(() => register("second", b, config(b, join(root, "..shared"), 2)), /overlaps runner "first"/);
      symlinkSync(root, join(dir, "alias"));
      assert.equal(canonical(join(dir, "alias", "nested")), canonical(join(root, "nested")));
      assert.throws(() => register("second", b, config(b, join(dir, "alias", "nested"), 2)), /overlaps runner "first"/);
      assert.throws(() => register("second", a, config(a, join(dir, "other"), 2)), /already running as "first"/);
      assert.throws(() => register("first", b, config(b, join(dir, "other"), 2)), /belongs to/);
      assert.throws(() => register("FIRST", b, config(b, join(dir, "other"), 2)), /belongs to/);
    } finally {
      if (previous === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previous;
      if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
      else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
    }
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
  }
});

test("filesystem-equivalent workflow and workspace paths share ownership without conflating case-sensitive paths", () => {
  for (const initiallyExists of [false, true]) {
    const dir = base();
    const env = environment(dir);
    const previousState = process.env.SYMPHONY_STATE_DIR;
    const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
    try {
      const upperRoot = join(dir, "Workspace");
      const lowerRoot = join(dir, "workspace");
      if (initiallyExists) mkdirSync(upperRoot);
      const insensitive = initiallyExists
        ? existsSync(lowerRoot)
        : (() => {
            mkdirSync(upperRoot);
            const result = existsSync(lowerRoot);
            rmSync(upperRoot, { recursive: true });
            return result;
          })();
      const firstWorkflow = join(dir, "first.md");
      const secondWorkflow = join(dir, "second.md");
      writeFileSync(firstWorkflow, "prompt");
      writeFileSync(secondWorkflow, "prompt");
      register("upper", firstWorkflow, config(firstWorkflow, upperRoot, 20));
      const rootAttempt = () => register("lower", secondWorkflow, config(secondWorkflow, lowerRoot, 21));
      if (insensitive) assert.throws(rootAttempt, /workspace root .*overlaps/);
      else assert.doesNotThrow(rootAttempt);

      const upperWorkflow = join(dir, "Flow.md");
      const lowerWorkflow = join(dir, "flow.md");
      writeFileSync(upperWorkflow, "prompt");
      register("flow-upper", upperWorkflow, config(upperWorkflow, join(dir, "flow-upper-root"), 22));
      const workflowAttempt = () => register("flow-lower", lowerWorkflow, config(lowerWorkflow, join(dir, "flow-lower-root"), 23));
      if (insensitive) assert.throws(workflowAttempt, /workflow .*already running/);
      else assert.doesNotThrow(workflowAttempt);
    } finally {
      if (previousState === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previousState;
      if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
      else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
    }
  }
});

test("Unicode-equivalent workspace paths cannot share a ledger on normalization-insensitive filesystems", () => {
  for (const initiallyExists of [false, true]) {
    const dir = base();
    const env = environment(dir);
    const previousState = process.env.SYMPHONY_STATE_DIR;
    const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
    try {
      const composedRoot = join(dir, "caf\u00e9");
      const decomposedRoot = join(dir, "cafe\u0301");
      if (initiallyExists) mkdirSync(composedRoot);
      const insensitive = initiallyExists
        ? existsSync(decomposedRoot)
        : (() => {
            mkdirSync(composedRoot);
            const result = existsSync(decomposedRoot);
            rmSync(composedRoot, { recursive: true });
            return result;
          })();
      const firstWorkflow = join(dir, "unicode-first.md");
      const secondWorkflow = join(dir, "unicode-second.md");
      writeFileSync(firstWorkflow, "prompt");
      writeFileSync(secondWorkflow, "prompt");
      register("unicode-first", firstWorkflow, config(firstWorkflow, composedRoot, 24));
      mkdirSync(composedRoot, { recursive: true });
      const firstLedger = new RunLedger(join(composedRoot, ".symphony-ledger.json"));
      firstLedger.open("shared-item", "first-issue", new Date(0)).sessions = 3;
      firstLedger.save();

      const secondRegistration = () =>
        register("unicode-second", secondWorkflow, config(secondWorkflow, decomposedRoot, 25));
      if (insensitive) {
        assert.throws(secondRegistration, /workspace root .*overlaps/);
        assert.equal(new RunLedger(join(composedRoot, ".symphony-ledger.json")).get("shared-item")?.sessions, 3);
      } else {
        assert.doesNotThrow(secondRegistration);
      }

      const composedWorkflow = join(dir, "fl\u00f3w.md");
      const decomposedWorkflow = join(dir, "flo\u0301w.md");
      writeFileSync(composedWorkflow, "prompt");
      register("unicode-flow-first", composedWorkflow, config(composedWorkflow, join(dir, "unicode-flow-first"), 28));
      const workflowRegistration = () =>
        register("unicode-flow-second", decomposedWorkflow, config(decomposedWorkflow, join(dir, "unicode-flow-second"), 29));
      if (insensitive) assert.throws(workflowRegistration, /workflow .*already running/);
      else assert.doesNotThrow(workflowRegistration);
    } finally {
      if (previousState === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previousState;
      if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
      else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
    }
  }
});

test("configuration inputs cannot be owned inside another runner workspace in either startup order", () => {
  for (const workspaceRunnerFirst of [true, false]) {
    const dir = base();
    const env = environment(dir);
    const previousState = process.env.SYMPHONY_STATE_DIR;
    const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
    try {
      const rootA = join(dir, "alpha-workspaces");
      const issueWorkspace = join(rootA, "GH-1");
      const workflowA = join(dir, "alpha.md");
      const workflowB = join(issueWorkspace, "WORKFLOW.md");
      mkdirSync(issueWorkspace, { recursive: true });
      writeFileSync(workflowA, "prompt a");
      writeFileSync(workflowB, "prompt b");
      const registerAlpha = () => register("alpha", workflowA, config(workflowA, rootA, 26));
      const registerBeta = () => register("beta", workflowB, config(workflowB, join(dir, "beta-workspaces"), 27));

      if (workspaceRunnerFirst) {
        registerAlpha();
        assert.throws(registerBeta, /configuration input .* overlaps .* workspace/);
      } else {
        registerBeta();
        assert.throws(registerAlpha, /configuration input .* overlaps .* workspace/);
      }
      assert.equal(readFileSync(workflowB, "utf8"), "prompt b");
    } finally {
      if (previousState === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previousState;
      if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
      else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
    }
  }
});

test("review prompts cannot be deleted by another runner workspace in either startup order", () => {
  for (const workspaceRunnerFirst of [true, false]) {
    const dir = base();
    const env = environment(dir);
    const previousState = process.env.SYMPHONY_STATE_DIR;
    const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
    try {
      const rootA = join(dir, "alpha-workspaces");
      const issueWorkspace = join(rootA, "GH-1");
      const workflowA = join(dir, "alpha.md");
      const workflowB = join(dir, "beta.md");
      const reviewPrompt = join(issueWorkspace, "REVIEW.md");
      mkdirSync(issueWorkspace, { recursive: true });
      writeFileSync(workflowA, workflowText(rootA, 34, "prompt a"));
      writeFileSync(workflowB, reviewWorkflowText(join(dir, "beta-workspaces"), 35, reviewPrompt));
      writeFileSync(reviewPrompt, "review prompt");
      const alphaConfig = buildConfig(loadWorkflow(workflowA).config, workflowA);
      const betaConfig = buildConfig(loadWorkflow(workflowB).config, workflowB);
      const registerAlpha = () => register("prompt-alpha", workflowA, alphaConfig);
      const registerBeta = () => register("prompt-beta", workflowB, betaConfig);

      if (workspaceRunnerFirst) {
        registerAlpha();
        assert.throws(registerBeta, /configuration input .* overlaps .* workspace/);
      } else {
        registerBeta();
        assert.throws(registerAlpha, /configuration input .* overlaps .* workspace/);
      }
      assert.equal(readFileSync(reviewPrompt, "utf8"), "review prompt");
    } finally {
      if (previousState === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previousState;
      if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
      else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
    }
  }
});

test("managed state writes cannot enter another runner workspace in either startup order", async () => {
  const dir = base();
  const normal = environment(dir, "shared-state");
  const rootA = join(dir, "alpha-workspaces");
  const nested = environment(dir, join("alpha-workspaces", "GH-1"));
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  const rootB = join(dir, "beta-workspaces");
  writeFileSync(a, workflowText(rootA, 30, "prompt a"));
  writeFileSync(b, workflowText(rootB, 31, "prompt b"));
  let first: ChildProcess | undefined;
  try {
    first = await launch(normal, "alpha", a, rootA, 1);
    const result = command(nested, "run", "--id", "beta", b);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /managed state .* overlaps .* workspace/);
    assert.equal(existsSync(join(rootA, "GH-1")), false, "rejected start must not create an issue workspace");
  } finally {
    if (first?.exitCode === null) first.kill("SIGTERM");
  }

  const reverse = base();
  const reverseNormal = environment(reverse, "shared-state");
  const reverseRootA = join(reverse, "alpha-workspaces");
  const reverseNested = environment(reverse, join("alpha-workspaces", "GH-1"));
  const reverseA = join(reverse, "a.md"), reverseB = join(reverse, "b.md");
  const reverseRootB = join(reverse, "beta-workspaces");
  writeFileSync(reverseA, workflowText(reverseRootA, 32, "prompt a"));
  writeFileSync(reverseB, workflowText(reverseRootB, 33, "prompt b"));
  let second: ChildProcess | undefined;
  try {
    second = await launch(reverseNested, "beta", reverseB, reverseRootB, 1);
    const result = command(reverseNormal, "run", "--id", "alpha", reverseA);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /managed state .* overlaps .* workspace/);
  } finally {
    if (second?.exitCode === null) second.kill("SIGTERM");
  }
});

test("host ownership survives state relocation and rejected starts do not contaminate an existing log", async () => {
  const dir = base();
  const envA = environment(dir, "state-a");
  const envB = environment(dir, "state-b");
  const a = join(dir, "a.md"), b = join(dir, "b.md");
  const rootA = join(dir, "workspace-a"), rootB = join(dir, "workspace-b");
  writeFileSync(a, workflowText(rootA, 1, "prompt a"));
  writeFileSync(b, workflowText(rootB, 1, "prompt b"));
  let child: ChildProcess | undefined;
  try {
    child = await launch(envA, "alpha", a, rootA, 1);
    mkdirSync(join(envA.SYMPHONY_STATE_DIR!, "logs"), { recursive: true });
    const alphaLog = join(envA.SYMPHONY_STATE_DIR!, "logs", "alpha.log");
    writeFileSync(alphaLog, "alpha-only\n");
    const relocated = command(envB, "start", "--id", "beta", b);
    assert.equal(relocated.status, 1);
    assert.match(relocated.stderr, /GitHub Project .*already managed by runner "alpha"/);
    const reusedId = command(envA, "start", "--id", "ALPHA", b);
    assert.equal(reusedId.status, 1);
    assert.match(reusedId.stderr, /runner ID "alpha" belongs to/);
    assert.equal(readFileSync(alphaLog, "utf8"), "alpha-only\n");
    assert.match(command(envB, "status", "alpha").stdout, /alpha: Running/);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
  }
});

test("an aliased runner log is rejected before startup writes to its owner", async () => {
  for (const alias of ["symlink", "hard link"]) {
    const dir = base();
    const env = environment(dir);
    const alpha = join(dir, "alpha.md");
    const beta = join(dir, "beta.md");
    const rootA = join(dir, "alpha-workspaces");
    writeFileSync(alpha, workflowText(rootA, 36, "prompt alpha"));
    writeFileSync(beta, workflowText(join(dir, "beta-workspaces"), 37, "prompt beta").replace(", repo: fixture/repo", ""));
    let child: ChildProcess | undefined;
    try {
      child = await launch(env, "log-alpha", alpha, rootA, 1);
      const logs = join(env.SYMPHONY_STATE_DIR!, "logs");
      mkdirSync(logs, { recursive: true });
      const alphaLog = join(logs, "log-alpha.log");
      const betaLog = join(logs, "log-beta.log");
      writeFileSync(alphaLog, "alpha-only\n");
      if (alias === "symlink") symlinkSync(alphaLog, betaLog);
      else linkSync(alphaLog, betaLog);

      const result = command(env, "run", "--id", "log-beta", beta);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /log for runner "log-beta" aliases runner "log-alpha" log/);
      assert.equal(readFileSync(alphaLog, "utf8"), "alpha-only\n");
    } finally {
      if (child?.exitCode === null) child.kill("SIGTERM");
    }
  }
});

test("managed foreground and background startup failures retain targeted logs", async () => {
  const dir = base();
  const env = environment(dir);
  const foreground = join(dir, "foreground.md");
  const background = join(dir, "background.md");
  const invalidWorkflow = (root: string, project: number, prompt: string) =>
    workflowText(root, project, prompt).replace(", repo: fixture/repo", "");
  writeFileSync(foreground, invalidWorkflow(join(dir, "foreground-root"), 10, "foreground prompt"));
  writeFileSync(background, invalidWorkflow(join(dir, "background-root"), 11, "background prompt"));
  const run = command(env, "run", "--id", "foreground", foreground);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /startup failed/);
  assert.match(readFileSync(join(env.SYMPHONY_STATE_DIR!, "logs", "foreground.log"), "utf8"), /startup failed/);
  const start = command(env, "start", "--id", "background", background);
  assert.equal(start.status, 1);
  assert.match(start.stderr, /did not start/);
  assert.match(readFileSync(join(env.SYMPHONY_STATE_DIR!, "logs", "background.log"), "utf8"), /startup failed/);
});

test("single-runner commands work without IDs, stale PID is not treated as live, and reload retains safe config", async () => {
  const dir = base();
  const env = environment(dir);
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
    const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
    process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
    try {
      assert.throws(() => register(runnerId(wf), join(dir, "other.md"), config(wf, join(dir, "different"), 2)), /belongs to/);
    } finally {
      if (previous === undefined) delete process.env.SYMPHONY_STATE_DIR;
      else process.env.SYMPHONY_STATE_DIR = previous;
      if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
      else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
    }
    assert.equal(live({ ...entry, started: "not the actual start time" }), false);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
  }
});

test("reload retains a safe review prompt when the new prompt overlaps another runner workspace", () => {
  const dir = base();
  const env = environment(dir);
  const previousState = process.env.SYMPHONY_STATE_DIR;
  const previousHost = process.env.SYMPHONY_TEST_HOST_STATE_DIR;
  process.env.SYMPHONY_STATE_DIR = env.SYMPHONY_STATE_DIR;
  process.env.SYMPHONY_TEST_HOST_STATE_DIR = env.SYMPHONY_TEST_HOST_STATE_DIR;
  try {
    const alphaWorkflow = join(dir, "reload-alpha.md");
    const betaWorkflow = join(dir, "reload-beta.md");
    const alphaRoot = join(dir, "reload-alpha-workspaces");
    const betaRoot = join(dir, "reload-beta-workspaces");
    const safePrompt = join(dir, "safe-review.md");
    const unsafePrompt = join(alphaRoot, "GH-1", "REVIEW.md");
    mkdirSync(join(alphaRoot, "GH-1"), { recursive: true });
    writeFileSync(alphaWorkflow, workflowText(alphaRoot, 38, "alpha prompt"));
    writeFileSync(safePrompt, "safe review");
    writeFileSync(unsafePrompt, "unsafe review");
    writeFileSync(betaWorkflow, reviewWorkflowText(betaRoot, 39, safePrompt));
    register("reload-alpha", alphaWorkflow, buildConfig(loadWorkflow(alphaWorkflow).config, alphaWorkflow));
    const entry = register("reload-beta", betaWorkflow, buildConfig(loadWorkflow(betaWorkflow).config, betaWorkflow));
    const { log } = captureLog();
    const store = new WorkflowStore(betaWorkflow, log);
    store.onValidate((next) => assertUnchanged(next.config, entry));

    writeFileSync(betaWorkflow, reviewWorkflowText(betaRoot, 39, unsafePrompt));
    utimesSync(betaWorkflow, 2_000_000_200, 2_000_000_200);
    assert.equal(store.refresh().config.review?.promptFile, safePrompt);
    assert.match(store.reloadError ?? "", /configuration input .* overlaps .* workspace/);
    store.close();
  } finally {
    if (previousState === undefined) delete process.env.SYMPHONY_STATE_DIR;
    else process.env.SYMPHONY_STATE_DIR = previousState;
    if (previousHost === undefined) delete process.env.SYMPHONY_TEST_HOST_STATE_DIR;
    else process.env.SYMPHONY_TEST_HOST_STATE_DIR = previousHost;
  }
});

test("generated IDs are valid for hidden and punctuation-leading workflow filenames", () => {
  const dir = base();
  for (const name of [".WORKFLOW.md", "---.md", "_private.md"]) {
    const path = join(dir, name);
    writeFileSync(path, "prompt");
    assert.doesNotThrow(() => validateId(runnerId(path)));
  }
});
