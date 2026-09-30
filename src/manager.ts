#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildConfig } from "./config.ts";
import {
  live, normalizeId, record, records, releaseReservation, reserve, runnerId, stateDir, type RunnerRecord,
} from "./registry.ts";
import { loadWorkflow } from "./workflow.ts";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const home = stateDir();
const lastFile = join(home, ".last-workflow");
const command = process.argv[2];
const argv = process.argv.slice(3);

function workflow(path?: string): string {
  const picked = path ?? process.env.SYMPHONY_WORKFLOW ?? (existsSync(lastFile) ? readFileSync(lastFile, "utf8").trim() : "./WORKFLOW.md");
  const result = resolve(picked);
  if (!existsSync(result)) throw new Error(`No workflow at ${result}. Pass it: symphony ${command} path/to/WORKFLOW.md`);
  return result;
}

function logFile(entry: RunnerRecord | string): string {
  const id = typeof entry === "string" ? entry : entry.id;
  const state = typeof entry === "string" ? home : entry.state ?? home;
  return join(state, "logs", `${id}.log`);
}

function select(id?: string): RunnerRecord | undefined {
  if (id) return record(id);
  const all = records();
  const active = all.filter(live);
  if (active.length > 1) throw new Error(`Multiple runners are active (${active.map((r) => r.id).join(", ")}); specify a runner ID`);
  if (active[0]) return active[0];
  if (all.length > 1) throw new Error(`Multiple runners are registered (${all.map((r) => r.id).join(", ")}); specify a runner ID`);
  return all[0];
}

function details(entry: RunnerRecord): void {
  if (live(entry)) console.log(`${entry.id}: Running (pid ${entry.pid}) with ${entry.workflow}`);
  else console.log(`${entry.id}: Not running (${entry.workflow})`);
  const file = logFile(entry);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n");
  const tick = lines.filter((line) => line.includes("msg=tick")).at(-1);
  if (tick) console.log(`Last poll: ${tick.slice(0, 200)}`);
  const events = lines.filter((line) => /msg=(dispatching|"session summary"|"issue halted"|"submitted for review"|"review submitted"|"run closed")|level=(warn|error)/.test(line));
  if (events.length) console.log(`Latest events:\n${events.slice(-6).map((line) => line.slice(0, 200)).join("\n")}`);
}

async function main(): Promise<number> {
  if (command === "start" || command === "run") {
    let id: string | undefined;
    if (argv[0] === "--id") {
      argv.shift();
      id = argv.shift();
      if (!id) throw new Error("--id requires a runner ID");
    }
    if (argv.length > 1) throw new Error(`Usage: symphony ${command} [--id ID] [path/to/WORKFLOW.md]`);
    const path = workflow(argv[0]);
    id ??= runnerId(path);
    id = normalizeId(id);
    const definition = loadWorkflow(path);
    const reservation = reserve(id, path, buildConfig(definition.config, path, process.env));
    const args = [cli, path, "--runner-id", id, "--reservation", reservation.token];
    if (command === "run") {
      mkdirSync(dirname(logFile(id)), { recursive: true });
      const fd = openSync(logFile(id), "a", 0o600);
      let child;
      try {
        child = spawn(process.execPath, args, { stdio: ["inherit", "pipe", "pipe"] });
      } catch (error) {
        closeSync(fd);
        releaseReservation(reservation.token);
        throw error;
      }
      child.stdout!.on("data", (chunk: Buffer) => {
        writeSync(fd, chunk);
        process.stdout.write(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        writeSync(fd, chunk);
        process.stderr.write(chunk);
      });
      process.on("SIGINT", () => {});
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      let code: number;
      try {
        code = await new Promise<number>((resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", (status, signal) => resolveExit(status ?? (signal ? 1 : 0)));
        });
      } finally {
        closeSync(fd);
        releaseReservation(reservation.token);
      }
      if (code === 0) {
        mkdirSync(home, { recursive: true });
        writeFileSync(lastFile, path + "\n");
      }
      return code;
    }
    mkdirSync(dirname(logFile(id)), { recursive: true });
    const fd = openSync(logFile(id), "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] });
    } catch (error) {
      closeSync(fd);
      releaseReservation(reservation.token);
      throw error;
    }
    closeSync(fd);
    child.unref();
    for (let i = 0; i < 30; i++) {
      await delay(100);
      const entry = record(id);
      if (entry && entry.pid === child.pid && live(entry)) {
        await delay(300);
        if (!live(entry)) break;
        if (process.platform === "darwin" && existsSync("/usr/bin/caffeinate")) {
          const keeper = spawn("/usr/bin/caffeinate", ["-i", "-w", String(child.pid)], { detached: true, stdio: "ignore" });
          keeper.unref();
        }
        writeFileSync(lastFile, path + "\n");
        console.log(`Started ${id} (pid ${child.pid}) with ${path}\nFollow it with: symphony logs ${id}`);
        return 0;
      }
      if (child.exitCode !== null) break;
    }
    releaseReservation(reservation.token);
    console.error(`Runner ${id} did not start. Last log lines:\n${readFileSync(logFile(id), "utf8").split("\n").slice(-15).join("\n")}`);
    return 1;
  }
  if (command === "status") {
    if (argv.length > 1) throw new Error("Usage: symphony status [ID]");
    if (argv[0]) {
      const entry = select(argv[0]);
      if (!entry) throw new Error(`Unknown runner "${argv[0]}"`);
      details(entry);
    } else {
      const entries = records();
      if (!entries.length) console.log("Not running.");
      else for (const entry of entries) details(entry);
    }
    return 0;
  }
  if (command === "stop" || command === "logs") {
    if (argv.length > 1) throw new Error(`Usage: symphony ${command} [ID]`);
    const entry = select(argv[0]);
    if (!entry) {
      if (argv[0]) throw new Error(`Unknown runner "${argv[0]}"`);
      console.log("Not running.");
      return 0;
    }
    if (command === "logs") {
      const path = logFile(entry);
      if (!existsSync(path)) { console.log(`No log yet: ${path}`); return 0; }
      const child = spawn("tail", ["-n", "30", "-f", path], { stdio: "inherit" });
      process.on("SIGINT", () => child.kill("SIGINT"));
      return new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolveExit(code ?? 0));
      });
    }
    if (!live(entry)) { console.log(`${entry.id}: Not running.`); return 0; }
    process.kill(entry.pid, "SIGTERM");
    console.log(`Stopping ${entry.id} (pid ${entry.pid})`);
    for (let i = 0; i < 60; i++) {
      await delay(1000);
      if (!live(entry)) { console.log(`${entry.id}: stopped.`); return 0; }
    }
    throw new Error(`${entry.id} is still stopping after 60 s; inspect symphony logs ${entry.id}`);
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
