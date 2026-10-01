import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { canonicalPath, processAlive, RunnerRegistry, workflowId } from "../src/instances.ts";
import { RunLedger } from "../src/ledger.ts";
import { requestRunner } from "../src/runner-control.ts";
import { makeIssue, reviewWorkflowText, workflowText } from "./helpers.ts";

const wrapper = join(import.meta.dirname, "..", "bin", "symphony");
const cli = join(import.meta.dirname, "..", "src", "cli.ts");

function capture(child: ChildProcess) {
  let stdout = "", stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("condition was not reached within 10 s");
}

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "symphony-manage-"));
  const env = { ...process.env, HOME: home, SYMPHONY_STATE_DIR: join(home, "state"), SYMPHONY_GITHUB_TOKEN: "test-only-token", SYMPHONY_WORKFLOW: undefined };
  const registry = new RunnerRegistry(join(home, ".symphony", "runners"));
  const calls: Array<{ number: number; token: string | undefined }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { query, variables } = JSON.parse(body);
      const number = variables.number as number;
      calls.push({ number, token: request.headers.authorization });
      if (!query.includes("items(first:")) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "unexpected request in offline test" }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { owner: { projectV2: { items: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          __typename: "ProjectV2Item", id: `item-${number}`, project: { id: `project-${number}` },
          status: { name: "Human Review" }, content: {
            __typename: "Issue", id: `issue-${number}`, number: 1, title: `workflow-${number}`, state: "OPEN",
            repository: { nameWithOwner: `me/app-${number}` }, labels: { nodes: [{ name: "agent" }] },
          },
        }],
      } } } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/graphql`;
  const command = (args: string[], overrides: NodeJS.ProcessEnv = {}) => capture(spawn("bash", [wrapper, ...args], {
    cwd: home, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"],
  }));
  t.after(async () => {
    for (const r of registry.list()) {
      if (!r.run) continue;
      if (processAlive(r.run.pid)) {
        try { await requestRunner(r, "stop"); } catch { process.kill(r.run.pid, "SIGTERM"); }
        try { await until(() => !processAlive(r.run!.pid)); }
        catch { process.kill(r.run.pid, "SIGKILL"); }
      }
      if (process.platform !== "win32") rmSync(r.run.socket, { force: true });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  const workflow = (number: number, options: { workspace?: string; name?: string; seed?: boolean; reviewPrompt?: string } = {}) => {
    const workspace = options.workspace ?? join(home, "work", `app-${number}`);
    const path = join(home, options.name ?? `workflow-${number}.md`);
    writeFileSync(path, options.reviewPrompt
      ? reviewWorkflowText(workspace, number, options.reviewPrompt, endpoint)
      : workflowText(workspace, number, endpoint));
    if (options.seed !== false) {
      const ledger = new RunLedger(join(workspace, ".symphony-ledger.json"));
      ledger.authorize(makeIssue({
        id: `item-${number}`, nativeRef: { repository: `me/app-${number}`, issue_id: `issue-${number}` },
      }), 20);
    }
    return { path, workspace, ledger: join(workspace, ".symphony-ledger.json") };
  };
  return { home, env, registry, command, workflow, calls };
}

test("two background runners have independent state, targeted logs/status/stop, and stable restart IDs", { timeout: 40_000 }, async (t) => {
  const { command, registry, workflow, calls, home } = await fixture(t);
  const a = workflow(1), b = workflow(2);
  const started = await Promise.all([
    command(["start", a.path, "--id", "alpha"], { SYMPHONY_GITHUB_TOKEN: "token-alpha" }),
    command(["start", b.path, "--id", "beta"], { SYMPHONY_GITHUB_TOKEN: "token-beta", SYMPHONY_STATE_DIR: join(home, "other-state") }),
  ]);
  for (const result of started) assert.equal(result.code, 0, result.stderr);
  await until(() => [a, b].every((w) => new RunLedger(w.ledger).records()[0]?.lastState === "Human Review"));
  assert.ok(calls.some((c) => c.number === 1 && c.token === "bearer token-alpha"));
  assert.ok(calls.some((c) => c.number === 2 && c.token === "bearer token-beta"));
  const list = await command(["status"]);
  assert.match(list.stdout, /alpha: running/);
  assert.match(list.stdout, /beta: running/);
  const alphaStatus = await command(["status", "alpha"]);
  assert.match(alphaStatus.stdout, /alpha: running/);
  assert.doesNotMatch(alphaStatus.stdout, /beta/);
  const logs = await command(["logs", "beta", "--no-follow"]);
  assert.match(logs.stdout, /workflow_id=beta/);
  assert.doesNotMatch(logs.stdout, /workflow_id=alpha/);
  assert.notEqual(registry.list()[0]?.directory, registry.list()[1]?.directory);
  assert.doesNotMatch(readFileSync(registry.path, "utf8"), /token-alpha|token-beta/);
  for (const args of [["stop"], ["logs", "--no-follow"], ["start"]]) {
    const result = await command(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /multiple workflows.*specify an ID/);
  }
  const beforeB = new RunLedger(b.ledger).records()[0]!.authorizationId;
  assert.equal((await command(["stop", "alpha"])).code, 0);
  const oldCount = calls.filter((c) => c.number === 2).length;
  await until(() => calls.filter((c) => c.number === 2).length > oldCount);
  assert.match((await command(["status", "beta"])).stdout, /beta: running/);
  assert.equal(new RunLedger(b.ledger).records()[0]!.authorizationId, beforeB);
  assert.ok(existsSync(a.ledger));
  assert.equal(registry.list().find((r) => r.id === "alpha")?.run, null);
  assert.equal((await command(["start", "--id", "alpha"], { SYMPHONY_WORKFLOW: b.path })).code, 0, "explicit registered ID wins over an environment default");
  assert.equal(registry.list().filter((r) => r.id === "alpha").length, 1);
});

test("simultaneous duplicate projects are rejected before second logs/ledger, even with another state directory", { timeout: 30_000 }, async (t) => {
  const { command, registry, workflow, home } = await fixture(t);
  const a = workflow(1, { name: "a.md", seed: false });
  const b = workflow(1, { name: "b.md", workspace: join(home, "work-b"), seed: false });
  writeFileSync(b.path, readFileSync(b.path, "utf8").replace("repo: me/app-1", "repo: me/different").replace("owner: me", "owner: ME"));
  const results = await Promise.all([
    command(["start", a.path, "--id", "alpha"]),
    command(["start", b.path, "--id", "beta"], { SYMPHONY_STATE_DIR: join(home, "elsewhere") }),
  ]);
  assert.equal(results.filter((r) => r.code === 0).length, 1);
  assert.match(results.find((r) => r.code !== 0)!.stderr, /same project are not supported/);
  assert.equal(registry.list().length, 1);
  assert.equal(existsSync(a.ledger), false);
  assert.equal(existsSync(b.ledger), false);
  const loser = results[0]!.code === 0 ? join(home, "elsewhere", "runners", "beta") : join(home, "state", "runners", "alpha");
  assert.equal(existsSync(loser), false);
});

test("state path collision is rejected even for different projects, including direct CLI launches", { timeout: 30_000 }, async (t) => {
  const { command, workflow, registry, env } = await fixture(t);
  const a = workflow(1);
  assert.equal((await command(["start", a.path, "--id", "alpha"])).code, 0);
  const b = workflow(2, { workspace: join(a.workspace, "nested"), seed: false });
  const result = await capture(spawn(process.execPath, [cli, b.path, "--id", "beta"], { env, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /state path collision.*alpha/);
  assert.equal(existsSync(b.workspace), false);
  assert.equal(registry.list().length, 1);
  assert.match((await command(["status", "alpha"])).stdout, /alpha: running/);
});

for (const [kind, link] of [["symlink", symlinkSync], ["hard link", linkSync]] as const) {
  test(`real runners reject log ${kind} aliases to reviewer prompts before polling or writes`, { timeout: 40_000 }, async (t) => {
    const { command, workflow, registry, env, home, calls } = await fixture(t);
    const prompt = join(home, "REVIEW.md");
    writeFileSync(prompt, "alpha review instructions");
    const a = workflow(1, { reviewPrompt: prompt }), b = workflow(2);
    assert.equal((await command(["start", a.path, "--id", "alpha"])).code, 0);
    const alpha = registry.list()[0]!;
    const originalLedger = readFileSync(b.ledger, "utf8");
    const betaDirectory = join(home, "state", "runners", "beta");
    mkdirSync(betaDirectory, { recursive: true });
    const betaLog = join(betaDirectory, "orchestrator.log");
    link(prompt, betaLog);
    const rejected = await capture(spawn(process.execPath, [cli, b.path, "--id", "beta", "--once"], {
      env, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(rejected.code, 1, rejected.stderr);
    assert.match(rejected.stderr, /state path collision.*alpha/);
    assert.equal(readFileSync(prompt, "utf8"), "alpha review instructions");
    assert.equal(readFileSync(b.ledger, "utf8"), originalLedger);
    assert.equal(registry.list().length, 1);
    assert.equal(calls.some((c) => c.number === 2), false);
    assert.equal(await requestRunner(alpha, "status"), "running");
    const polls = calls.filter((c) => c.number === 1).length;
    await until(() => calls.filter((c) => c.number === 1).length > polls);
    rmSync(betaLog);
    assert.equal((await command(["start", b.path, "--id", "beta"])).code, 0);
    assert.equal((await command(["stop", "beta"])).code, 0);
    assert.equal(await requestRunner(alpha, "status"), "running");
  });

  test(`a real runner rejects its own log ${kind} to its reviewer prompt`, { timeout: 30_000 }, async (t) => {
    const { workflow, registry, env, home, calls } = await fixture(t);
    const prompt = join(home, "REVIEW.md");
    writeFileSync(prompt, "review instructions");
    const a = workflow(1, { reviewPrompt: prompt });
    const directory = join(home, "state", "runners", "alpha");
    mkdirSync(directory, { recursive: true });
    link(prompt, join(directory, "orchestrator.log"));
    const ledger = readFileSync(a.ledger, "utf8");
    const result = await capture(spawn(process.execPath, [cli, a.path, "--id", "alpha", "--once"], {
      env, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /must not overlap/);
    assert.equal(readFileSync(prompt, "utf8"), "review instructions");
    assert.equal(readFileSync(a.ledger, "utf8"), ledger);
    assert.equal(calls.length, 0);
    assert.deepEqual(registry.list(), []);
  });

  test(`a real runner rejects a ledger temporary ${kind} to a live runner's log before startup`, { timeout: 40_000 }, async (t) => {
    const { command, workflow, registry, env, home, calls } = await fixture(t);
    const a = workflow(1), b = workflow(2);
    assert.equal((await command(["start", a.path, "--id", "alpha"])).code, 0);
    await until(() => new RunLedger(a.ledger).records()[0]?.lastState === "Human Review");
    const alpha = registry.list()[0]!;
    const log = join(alpha.directory, "orchestrator.log");
    const originalLog = readFileSync(log, "utf8");
    const originalLedger = readFileSync(b.ledger, "utf8");
    const authorization = new RunLedger(b.ledger).records()[0]!.authorizationId;
    link(log, `${b.ledger}.tmp`);
    const rejected = await capture(spawn(process.execPath, [cli, b.path, "--id", "beta", "--once"], {
      env, stdio: ["ignore", "pipe", "pipe"],
    }));
    assert.equal(rejected.code, 1, rejected.stderr);
    assert.match(rejected.stderr, /state path collision.*alpha/);
    assert.ok(readFileSync(log, "utf8").startsWith(originalLog), "alpha's existing log must remain intact");
    assert.doesNotMatch(readFileSync(log, "utf8"), /"version": 2|"me\/app-2:issue-2"/);
    assert.equal(readFileSync(b.ledger, "utf8"), originalLedger);
    assert.equal(existsSync(join(home, "state", "runners", "beta")), false);
    assert.equal(registry.list().length, 1);
    assert.equal(calls.some((c) => c.number === 2), false, "beta must not poll before rejection");
    assert.equal(await requestRunner(alpha, "status"), "running");
    const polls = calls.filter((c) => c.number === 1).length;
    await until(() => calls.filter((c) => c.number === 1).length > polls);
    rmSync(`${b.ledger}.tmp`);
    const started = await command(["start", b.path, "--id", "beta"]);
    assert.equal(started.code, 0, started.stderr);
    await until(() => new RunLedger(b.ledger).records()[0]?.lastState === "Human Review");
    assert.equal(new RunLedger(b.ledger).records()[0]?.authorizationId, authorization);
    assert.equal((await command(["stop", "beta"])).code, 0);
    assert.equal(await requestRunner(alpha, "status"), "running");
  });
}

test("single-workflow default commands, legacy remembered paths, foreground run and read-only CLI remain compatible", { timeout: 40_000 }, async (t) => {
  const { command, workflow, registry, env, home } = await fixture(t);
  const a = workflow(1);
  mkdirSync(env.SYMPHONY_STATE_DIR, { recursive: true });
  writeFileSync(join(env.SYMPHONY_STATE_DIR, ".last-workflow"), a.path);
  const started = await command(["start"]);
  assert.equal(started.code, 0, started.stderr);
  const id = workflowId(a.path);
  assert.equal(registry.list()[0]?.id, id);
  assert.match((await command(["status"])).stdout, /running/);
  assert.equal((await command(["logs", "--no-follow"])).code, 0);
  assert.equal((await command(["stop"])).code, 0);
  const child = spawn("bash", [wrapper, "run"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
  const finished = capture(child);
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await until(async () => {
    const record = registry.list()[0];
    return Boolean(record?.run && await requestRunner(record, "status").then((s) => s === "running", () => false));
  });
  assert.equal((await command(["stop"])).code, 0);
  assert.equal((await finished).code, 0);
  const ledgerBefore = readFileSync(a.ledger, "utf8");
  const dry = await capture(spawn(process.execPath, [cli, a.path, "--dry-run", "--once"], { env, stdio: ["ignore", "pipe", "pipe"] }));
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(readFileSync(a.ledger, "utf8"), ledgerBefore);
  assert.equal(registry.list()[0]?.run, null);
  assert.equal(registry.list()[0]?.workflow, canonicalPath(a.path));
});

test("failed startup releases its claim and a crashed runner can restart with the same ledger", { timeout: 40_000 }, async (t) => {
  const { command, workflow, registry } = await fixture(t);
  const a = workflow(1);
  const initialLedger = readFileSync(a.ledger, "utf8");
  writeFileSync(a.ledger, "{broken");
  const failed = await command(["start", a.path, "--id", "alpha"]);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /cannot read run ledger/);
  assert.equal(registry.list()[0]?.run, null);
  writeFileSync(a.ledger, initialLedger);
  assert.equal((await command(["start"])).code, 0);
  const oldRun = registry.list()[0]!.run!;
  process.kill(oldRun.pid, "SIGKILL");
  await until(() => !processAlive(oldRun.pid));
  assert.match((await command(["status"])).stdout, /exited \(stale claim/);
  assert.equal((await command(["start"])).code, 0);
  assert.notEqual(registry.list()[0]?.run?.nonce, oldRun.nonce);
  rmSync(oldRun.socket, { force: true });
  assert.ok(new RunLedger(a.ledger).records()[0]);
});
