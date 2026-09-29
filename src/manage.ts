#!/usr/bin/env node
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunnerManager, type RunnerRecord } from "./management.ts";

const manager = new RunnerManager(process.env.SYMPHONY_STATE_DIR ?? `${homedir()}/symphony-workspaces`, new URL("./cli.ts", import.meta.url).pathname);

function chosen(value: string | undefined, records: RunnerRecord[]): string | null {
  if (value) return value;
  if (records.length === 1) return records[0]!.id;
  if (records.length > 1) throw new Error(`multiple workflows registered; specify an ID: ${records.map((r) => r.id).join(", ")}`);
  return manager.lastId();
}

function details(record: RunnerRecord): void {
  console.log(`${record.id}: ${manager.isRunning(record) ? `Running (pid ${record.pid})` : "Not running"} with ${record.workflow}`);
  const log = manager.logPath(record.id);
  if (!existsSync(log)) return;
  const lines = readFileSync(log, "utf8").split("\n");
  const tick = lines.filter((line) => line.includes("msg=tick")).at(-1);
  if (tick) console.log(`Last poll: ${tick.slice(0, 200)}`);
  const events = lines.filter((line) => /msg=(dispatching|"session summary"|"issue halted"|"submitted for review"|"review submitted"|"run closed")|level=(warn|error)/.test(line));
  if (events.length) console.log(`Latest events:\n${events.slice(-6).map((line) => line.slice(0, 200)).join("\n")}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!["start", "run", "stop", "status", "logs"].includes(command ?? "")) {
    throw new Error("usage: symphony <start|run|stop|status|logs> [WORKFLOW.md|ID] [--id ID]");
  }
  const records = manager.records();
  if (command === "start" || command === "run") {
    const idIndex = args.indexOf("--id");
    if (idIndex >= 0 && !args[idIndex + 1]) throw new Error("--id requires an ID");
    const id = idIndex >= 0 ? args.splice(idIndex, 2)[1] : undefined;
    if (args.length > 1 || args[0]?.startsWith("--")) throw new Error("start/run accepts one workflow path or registered ID");
    const input = args[0] ?? process.env.SYMPHONY_WORKFLOW;
    const registered = input ? records.find((r) => r.id === input) : records.find((r) => r.id === manager.lastId());
    const workflow = registered?.workflow ?? (input ? resolve(input) : resolve("WORKFLOW.md"));
    const started = await manager.start(workflow, id ?? registered?.id, command === "run");
    const { record, child } = started;
    if (command === "start") {
      await delay(500);
      if (!manager.isRunning(record)) {
        const log = manager.logPath(record.id);
        throw new Error(`runner ${record.id} exited during startup${existsSync(log) ? `; last log lines:\n${readFileSync(log, "utf8").split("\n").slice(-16).join("\n")}` : ""}`);
      }
      console.log(`Started ${record.id} (pid ${record.pid}) with ${record.workflow}\nFollow it with: symphony logs ${record.id}`);
      return;
    }
    const log = createWriteStream(manager.logPath(record.id), { flags: "a" });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (data: Buffer) => { process.stderr.write(data); log.write(data); });
    }
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
      if (manager.isRunning(record)) process.kill(record.pid, signal);
    });
    const code = await new Promise<number>((done) => {
      child.once("error", (error) => { console.error(error); done(1); });
      child.once("close", (exit) => done(exit ?? 1));
    });
    await new Promise<void>((done) => log.end(done));
    process.exitCode = code;
    return;
  }
  if (args.length > 1) throw new Error(`${command} accepts at most one runner ID`);
  if (command === "status" && !args[0] && records.length > 1) {
    for (const record of records) console.log(`${record.id}: ${manager.isRunning(record) ? "Running" : "Not running"} (${record.workflow})`);
    return;
  }
  const id = chosen(args[0], records);
  const record = id ? manager.get(id) : undefined;
  if (!record) {
    if (args[0]) throw new Error(`unknown workflow ID: ${args[0]}`);
    console.log("Not running.");
    return;
  }
  if (command === "status") { details(record); return; }
  if (command === "stop") {
    if (!await manager.stop(record.id)) { console.log(`${record.id}: Not running.`); return; }
    for (let i = 0; i < 60; i++) {
      if (!manager.isRunning(record)) { console.log(`${record.id}: stopped.`); return; }
      await delay(1000);
    }
    throw new Error(`${record.id} is still stopping (pid ${record.pid}); inspect symphony logs ${record.id}`);
  }
  const log = manager.logPath(record.id);
  if (!existsSync(log)) { console.log(`No log yet: ${log}`); return; }
  const { spawn } = await import("node:child_process");
  const tail = spawn("tail", ["-n", "30", "-f", log], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => tail.kill(signal));
  await new Promise<void>((done) => tail.once("exit", () => done()));
}

try { await main(); } catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
