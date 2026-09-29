import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { defaultWorkflowId } from "../src/instance.ts";

const root = join(import.meta.dirname, "..");
const symphony = join(root, "bin", "symphony");

function writeWorkflow(dir: string, name: string, workspace: string, project: number): string {
  const path = join(dir, name);
  writeFileSync(path, `---
tracker:
  kind: github_project
  provider:
    owner: octo
    project_number: ${project}
  active_states: [Todo]
  terminal_states: [Done]
workspace:
  root: ${workspace}
---
Work.
`);
  return path;
}

test("management commands isolate and target multiple workflow runners", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "symphony-management-"));
  const state = join(dir, "state");
  const fakeCli = join(dir, "fake-cli.mjs");
  writeFileSync(fakeCli, `
const workflow = process.argv[2];
process.stderr.write("ts=2026-01-01T00:00:00.000Z level=info msg=tick workflow=" + workflow + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const one = writeWorkflow(dir, "one.md", join(dir, "work-one"), 1);
  const two = writeWorkflow(dir, "two.md", join(dir, "work-two"), 2);
  const duplicateProject = writeWorkflow(dir, "duplicate-project.md", join(dir, "work-three"), 1);
  const duplicateState = writeWorkflow(dir, "duplicate-state.md", join(dir, "work-one"), 3);
  const env = {
    ...process.env,
    SYMPHONY_STATE_DIR: state,
    SYMPHONY_GITHUB_TOKEN: "test",
    SYMPHONY_CLI: fakeCli,
    SYMPHONY_STARTUP_WAIT_SECONDS: "0.2",
  };
  const run = (...args: string[]) => spawnSync("bash", [symphony, ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
  const stop = (id?: string) => run("stop", ...(id ? [id] : []));
  t.after(() => {
    stop("alpha");
    stop("beta");
    stop(defaultWorkflowId(one));
  });

  const first = run("start", one, "--id", "alpha");
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const second = run("start", two, "--id", "beta");
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

  const status = run("status", "--all");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Running "alpha"/);
  assert.match(status.stdout, /Running "beta"/);
  const alphaLog = join(state, "runners", "alpha", "orchestrator.log");
  const betaLog = join(state, "runners", "beta", "orchestrator.log");
  assert.ok(existsSync(alphaLog));
  assert.ok(existsSync(betaLog));
  assert.match(readFileSync(alphaLog, "utf8"), new RegExp(one.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readFileSync(betaLog, "utf8"), new RegExp(two.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const projectConflict = run("start", duplicateProject, "--id", "project-copy");
  assert.equal(projectConflict.status, 1);
  assert.match(projectConflict.stderr, /same GitHub Project.*card claiming is not coordinated/);
  const stateConflict = run("start", duplicateState, "--id", "state-copy");
  assert.equal(stateConflict.status, 1);
  assert.match(stateConflict.stderr, /shares state.*workspace\.root/);

  const stopped = stop("alpha");
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  assert.match(run("status", "alpha").stdout, /Not running: "alpha"/);
  assert.match(run("status", "beta").stdout, /Running "beta"/);

  const stoppedLast = stop();
  assert.equal(stoppedLast.status, 0, `${stoppedLast.stdout}\n${stoppedLast.stderr}`);
  assert.match(run("status").stdout, /Not running: "beta"/);

  const compatibleStart = run("start", one);
  assert.equal(compatibleStart.status, 0, `${compatibleStart.stdout}\n${compatibleStart.stderr}`);
  assert.match(compatibleStart.stdout, new RegExp(`Started "${defaultWorkflowId(one)}"`));
  assert.match(run("status").stdout, new RegExp(`Running "${defaultWorkflowId(one)}"`));
  const compatibleStop = stop();
  assert.equal(compatibleStop.status, 0, `${compatibleStop.stdout}\n${compatibleStop.stderr}`);
});
