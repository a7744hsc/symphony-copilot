import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { canonicalPath, processAlive, RunnerRegistry, validateId, workflowId, type RunnerRecord } from "./instances.ts";
import { requestRunner } from "./runner-control.ts";

const USAGE = `Usage:
  symphony start|run [path/to/WORKFLOW.md] [--id ID]
  symphony list
  symphony status|stop|logs [ID]       (logs: --no-follow prints and exits)

Without --id, a workflow gets a stable ID from its canonical path.
With one registered workflow, ID/path may be omitted. With several, choose one.
status without an ID lists all runners; stop never stops all runners.`;

function target(records: RunnerRecord[], id: string | undefined): RunnerRecord | undefined {
  if (id) {
    const record = records.find((r) => r.id === validateId(id));
    if (!record) throw new Error(`unknown workflow ID "${id}"; use symphony list`);
    return record;
  }
  if (records.length > 1) throw new Error("multiple workflows are registered; specify an ID (see symphony list)");
  return records[0];
}

function logTail(record: RunnerRecord): string {
  const path = join(record.directory, "orchestrator.log");
  if (!existsSync(path)) return `No log yet: ${path}\n`;
  const file = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    readSync(file, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString("utf8").split("\n").filter((line) => line && !line.includes("permission approved")).slice(-30).join("\n") + "\n";
  } finally { closeSync(file); }
}

async function status(record: RunnerRecord): Promise<void> {
  let state: string = "stopped";
  if (record.run) {
    if (!processAlive(record.run.pid)) state = "exited (stale claim; inspect logs before restart)";
    else state = await requestRunner(record, "status").catch((error: Error) => `unavailable (${error.message}; ownership retained)`);
  }
  process.stdout.write(`${record.id}: ${state}${record.run ? ` (pid ${record.run.pid})` : ""}\n  workflow: ${record.workflow}\n  workspace: ${record.workspace}\n  log: ${join(record.directory, "orchestrator.log")}\n`);
}

async function launch(workflow: string, id: string, background: boolean): Promise<number> {
  const child = spawn(process.execPath, [join(import.meta.dirname, "cli.ts"), workflow, "--id", id], {
    detached: background,
    stdio: [background ? "ignore" : "inherit", background ? "ignore" : "inherit", background ? "ignore" : "inherit", "ipc"],
    env: process.env,
  });
  let startupError: string | undefined;
  let ready = false;
  const forward = () => child.kill("SIGTERM");
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  return new Promise<number>((resolveExit, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
    };
    const timer = setTimeout(() => {
      startupError = `runner "${id}" did not become ready within 60 s; stopping it`;
      process.stderr.write(`${startupError}\n`);
      child.kill("SIGTERM");
    }, 60_000);
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) return;
      if (message.type === "error" && "message" in message) startupError = String(message.message);
      if (message.type !== "ready") return;
      if (startupError) return;
      ready = true;
      clearTimeout(timer);
      if (!background) return;
      cleanup();
      child.unref();
      if (process.platform === "darwin") {
        const awake = spawn("caffeinate", ["-i", "-w", String(child.pid)], { detached: true, stdio: "ignore" });
        awake.on("error", (error) => process.stderr.write(`could not prevent idle sleep: ${error.message}\n`));
        awake.unref();
      }
      process.stdout.write(`Started "${id}" (pid ${child.pid}) with ${workflow}\nFollow it with: symphony logs ${id}\n`);
      resolveExit(0);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (!ready) process.stderr.write(`${startupError ?? `runner exited before startup (${signal ?? code}); inspect symphony logs ${id}`}\n`);
      resolveExit(ready ? code ?? 1 : 1);
    });
  });
}

async function main(): Promise<number> {
  const args = parseArgs({
    allowPositionals: true,
    options: { id: { type: "string" }, "no-follow": { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  const [command, positional] = args.positionals;
  if (args.values.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  if (!command || !["start", "run", "list", "status", "logs", "stop"].includes(command) || args.positionals.length > 2 ||
    (args.values["no-follow"] && command !== "logs") || (command === "list" && (positional || args.values.id))) {
    throw new Error(USAGE);
  }
  const registry = new RunnerRegistry();
  const records = registry.list();
  if (command === "start" || command === "run") {
    let id = args.values.id ? validateId(args.values.id) : undefined;
    let workflow = positional || (id ? records.find((r) => r.id === id)?.workflow : undefined) || process.env.SYMPHONY_WORKFLOW;
    if (!workflow) {
      const known = id ? records.find((r) => r.id === id) : target(records, undefined);
      if (known) { workflow = known.workflow; id = known.id; }
      else {
        const last = join(process.env.SYMPHONY_STATE_DIR || join(homedir(), "symphony-workspaces"), ".last-workflow");
        workflow = existsSync(last) ? readFileSync(last, "utf8").trim() : "WORKFLOW.md";
      }
    }
    workflow = canonicalPath(workflow);
    if (!statSync(workflow).isFile()) throw new Error(`not a workflow file: ${workflow}`);
    id ??= records.find((r) => r.workflow === workflow)?.id ?? workflowId(workflow);
    return launch(workflow, id, command === "start");
  }
  if (positional && args.values.id) throw new Error("specify an ID either positionally or with --id, not both");
  const id = positional ?? args.values.id;
  if (command === "list" || (command === "status" && !id)) {
    if (!records.length) process.stdout.write("Not running. No workflows registered.\n");
    for (const record of records) await status(record);
    if (command === "status" && records.length === 1) process.stdout.write(logTail(records[0]!));
    return 0;
  }
  const record = target(records, id);
  if (!record) { process.stdout.write("Not running. No workflows registered.\n"); return 0; }
  if (command === "status") { await status(record); process.stdout.write(logTail(record)); return 0; }
  if (command === "logs") {
    const path = resolve(record.directory, "orchestrator.log");
    if (args.values["no-follow"] || !existsSync(path)) { process.stdout.write(logTail(record)); return 0; }
    const child = spawn("tail", ["-n", "30", "-f", path], { stdio: "inherit" });
    return new Promise<number>((resolveExit, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolveExit(code ?? 0));
    });
  }
  if (!record.run || !processAlive(record.run.pid)) {
    process.stdout.write(`"${record.id}" is not running.\n`);
    return 0;
  }
  await requestRunner(record, "stop");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = registry.list().find((r) => r.id === record.id);
    if (current?.run?.nonce !== record.run.nonce || !processAlive(record.run.pid)) {
      process.stdout.write(`Stopped "${record.id}". Workspaces and ledger are kept.\n`);
      return 0;
    }
    await delay(100);
  }
  throw new Error(`runner "${record.id}" is still stopping after 60 s; inspect symphony logs ${record.id}. Ownership is retained; no other runner was stopped`);
}

process.exitCode = await main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  return 1;
});
