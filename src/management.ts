import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { WorkflowStore } from "./workflow.ts";

export interface RunnerRecord {
  id: string;
  workflow: string;
  workspace: string;
  project: string;
  pid: number;
  instance?: string;
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return join(canonicalPath(parent), basename(absolute));
}

export function projectIdentity(config: ServiceConfig): string {
  const p = config.tracker.provider;
  if (config.tracker.kind !== "github_project") throw new Error(`unsupported managed tracker: ${config.tracker.kind}`);
  const owner = p.owner;
  const number = Number(p.project_number);
  if (typeof owner !== "string" || !owner.trim() || !Number.isInteger(number) || number < 1) {
    throw new Error("managed runner requires tracker.provider.owner and a positive project_number");
  }
  return `${String(p.endpoint ?? "https://api.github.com/graphql").toLowerCase().replace(/\/+$/, "")}|${String(p.owner_type ?? "user").toLowerCase()}|${owner.trim().toLowerCase()}|${number}`;
}

function overlaps(a: string, b: string): boolean {
  return a === b || (!relative(a, b).startsWith("..") && !isAbsolute(relative(a, b)))
    || (!relative(b, a).startsWith("..") && !isAbsolute(relative(b, a)));
}

export function workflowId(path: string): string {
  const name = basename(dirname(path)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "workflow";
  return `${name}-${createHash("sha256").update(canonicalPath(path)).digest("hex").slice(0, 10)}`;
}

export function validId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
}

export function pathFromFileUrl(url: URL): string {
  return fileURLToPath(url);
}

export class RunnerManager {
  readonly root: string;
  private readonly cli: string;
  private readonly alive: (record: RunnerRecord) => boolean;
  private readonly launch: (workflow: string, env: NodeJS.ProcessEnv, log: string, foreground: boolean, instance: string) => ChildProcess;

  constructor(root: string, cli: string, options: {
    alive?: (record: RunnerRecord) => boolean;
    launch?: (workflow: string, env: NodeJS.ProcessEnv, log: string, foreground: boolean, instance: string) => ChildProcess;
  } = {}) {
    this.root = canonicalPath(root);
    this.cli = canonicalPath(cli);
    this.alive = options.alive ?? ((record) => {
      try {
        if (!record.instance) return false;
        process.kill(record.pid, 0);
        const command = execFileSync("ps", ["-ww", "-p", String(record.pid), "-o", "command="], { encoding: "utf8" });
        return command.split(/\s+/).includes(`--symphony-runner-instance=${record.instance}`);
      } catch {
        return false;
      }
    });
    this.launch = options.launch ?? ((workflow, env, log, foreground, instance) => {
      const args = [this.cli, workflow, `--symphony-runner-instance=${instance}`];
      if (foreground) return spawn(process.execPath, args, { env, stdio: ["inherit", "pipe", "pipe"] });
      const fd = openSync(log, "a");
      try {
        const child = spawn(process.execPath, args, { env, stdio: ["ignore", fd, fd], detached: true });
        child.on("error", (error) => console.error(`runner launch failed: ${error.message}`));
        child.unref();
        if (process.platform === "darwin" && child.pid) {
          const awake = spawn("caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore", detached: true });
          awake.on("error", (error) => console.error(`could not prevent idle sleep: ${error.message}`));
          awake.unref();
        }
        return child;
      } finally {
        closeSync(fd);
      }
    });
  }

  private recordPath(id: string): string {
    if (!validId(id)) throw new Error("workflow ID must be 1-64 letters, numbers, hyphens or underscores and start with a letter or number");
    return join(this.root, "runners", id, "runner.json");
  }

  logPath(id: string): string {
    this.recordPath(id);
    return join(this.root, "runners", id, "logs", "orchestrator.log");
  }

  records(): RunnerRecord[] {
    const dir = join(this.root, "runners");
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && validId(entry.name))
      .flatMap((entry) => {
        const file = this.recordPath(entry.name);
        if (!existsSync(file)) return [];
        const record = JSON.parse(readFileSync(file, "utf8")) as RunnerRecord;
        if (record.id !== entry.name || !Number.isInteger(record.pid) || typeof record.workflow !== "string"
          || typeof record.workspace !== "string" || typeof record.project !== "string"
          || (record.instance !== undefined && typeof record.instance !== "string")) {
          throw new Error(`invalid runner record: ${file}`);
        }
        return [record];
      });
  }

  isRunning(record: RunnerRecord): boolean {
    return this.alive(record);
  }

  get(id: string): RunnerRecord | undefined {
    this.recordPath(id);
    return this.records().find((record) => record.id === id);
  }

  lastId(): string | null {
    const file = join(this.root, ".last-runner");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  }

  private async locked<T>(action: () => T): Promise<T> {
    mkdirSync(this.root, { recursive: true });
    const lock = join(this.root, ".runner-lock");
    for (let i = 0; ; i++) {
      try {
        mkdirSync(lock);
        writeFileSync(join(lock, "pid"), String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number(existsSync(join(lock, "pid")) ? readFileSync(join(lock, "pid"), "utf8") : 0);
        if ((owner > 0 && !isPidAlive(owner)) || (owner === 0 && Date.now() - statSync(lock).mtimeMs > 2_000)) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (i >= 100) throw new Error(`runner registry is locked: ${lock}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
    try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }

  async start(path: string, requestedId: string | undefined, foreground = false): Promise<{ record: RunnerRecord; child: ChildProcess }> {
    const workflow = canonicalPath(path);
    const store = new WorkflowStore(workflow, createLogger("error"));
    const config = store.workflow.config;
    store.close();
    const id = requestedId ?? workflowId(workflow);
    this.recordPath(id);
    const workspace = canonicalPath(config.workspace.root);
    const project = projectIdentity(config);
    if (overlaps(join(this.root, "runners"), workspace)) {
      throw new Error(`workspace.root ${workspace} overlaps managed runner records ${join(this.root, "runners")}`);
    }
    const record = await this.locked(() => {
      const records = this.records();
      const existing = records.find((item) => item.id === id);
      if (existing && existing.workflow !== workflow) throw new Error(`ID ${id} already belongs to ${existing.workflow}`);
      for (const item of records) {
        if (item.id === id) {
          if (this.isRunning(item)) throw new Error(`workflow already running as ${item.id} (pid ${item.pid})`);
          continue;
        }
        if (item.workflow === workflow) throw new Error(`workflow already registered as ${item.id}; use that ID`);
        if (overlaps(item.workspace, workspace)) throw new Error(`workspace.root ${workspace} overlaps runner ${item.id}: ${item.workspace}`);
        if (this.isRunning(item) && item.project === project) throw new Error(`GitHub Project ${project} already has runner ${item.id}; shared-card claiming is not safe`);
      }
      const state = join(this.root, "runners", id);
      if (overlaps(state, workspace)) throw new Error(`workspace.root ${workspace} overlaps runner state ${state}`);
      mkdirSync(dirname(this.logPath(id)), { recursive: true });
      const instance = randomUUID();
      const child = this.launch(workflow, {
        ...process.env, SYMPHONY_RUNNER_PROJECT: project, SYMPHONY_RUNNER_WORKSPACE: workspace,
      }, this.logPath(id), foreground, instance);
      if (!child.pid) {
        child.on("error", (error) => console.error(`could not launch runner ${id}: ${error.message}`));
        throw new Error(`could not launch runner ${id}`);
      }
      const next = { id, workflow, workspace, project, pid: child.pid, instance };
      try {
        writeFileSync(this.recordPath(id), `${JSON.stringify(next, null, 2)}\n`);
        writeFileSync(join(this.root, ".last-runner"), `${id}\n`);
      } catch (error) {
        child.kill("SIGTERM");
        throw error;
      }
      return { record: next, child };
    });
    return record;
  }

  async stop(id: string): Promise<boolean> {
    const record = this.get(id);
    if (!record || !this.isRunning(record)) return false;
    process.kill(record.pid, "SIGTERM");
    return true;
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
