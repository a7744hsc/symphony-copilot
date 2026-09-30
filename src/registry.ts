import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ServiceConfig } from "./config.ts";

export interface RunnerRecord {
  id: string;
  workflow: string;
  root: string;
  project: string;
  pid: number;
  started: string;
}

export const stateDir = () => resolve(process.env.SYMPHONY_STATE_DIR ?? join(process.env.HOME ?? "", "symphony-workspaces"));
export const runnerId = (workflow: string) => {
  const path = canonical(workflow);
  return basename(path, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-")
    + "-" + createHash("sha256").update(path).digest("hex").slice(0, 8);
};

export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`invalid runner ID "${id}" (use letters, digits, _ or -)`);
}

export function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        return canonical(resolve(dirname(absolute), readlinkSync(absolute)));
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
    }
    return join(canonical(dirname(absolute)), basename(absolute));
  }
}

export function projectKey(config: ServiceConfig): string {
  if (config.tracker.kind !== "github_project") throw new Error(`unsupported tracker ${config.tracker.kind}`);
  const p = config.tracker.provider;
  const owner = p.owner;
  const type = p.owner_type ?? "user";
  const number = Number(p.project_number);
  if (typeof owner !== "string" || !owner.trim() || !["user", "organization"].includes(String(type)) || !Number.isInteger(number) || number < 1) {
    throw new Error("tracker.provider must specify a valid owner, owner_type and project_number");
  }
  return `${type}:${owner.toLowerCase()}:${number}`;
}

function pidStart(pid: number): string | null {
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "stat=", "-o", "lstart="], { encoding: "utf8" }).trim();
    const match = /^(\S+)\s+(.+)$/.exec(value);
    return match && !match[1]!.includes("Z") ? match[2]! : null;
  } catch {
    return null;
  }
}

export function live(record: RunnerRecord): boolean {
  return pidStart(record.pid) === record.started && record.started !== "";
}

function directory(): string {
  const dir = join(stateDir(), "runners");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function records(): RunnerRecord[] {
  const dir = directory();
  return readdirSync(dir).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RunnerRecord);
}

export function record(id: string): RunnerRecord | undefined {
  validateId(id);
  return records().find((entry) => entry.id === id);
}

function overlaps(a: string, b: string): boolean {
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function locked<T>(fn: (dir: string) => T): T {
  const dir = directory();
  const lock = join(dir, ".lock");
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lock);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true });
      } catch (staleError) {
        if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
      }
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  if (!acquired) throw new Error("runner registry is busy; try again");
  try {
    return fn(dir);
  } finally {
    rmSync(lock, { recursive: true });
  }
}

export function register(id: string, workflow: string, config: ServiceConfig, pid = process.pid): RunnerRecord {
  validateId(id);
  const started = pidStart(pid);
  if (!started) throw new Error(`cannot inspect runner process ${pid}`);
  const next: RunnerRecord = {
    id, workflow: canonical(workflow), root: canonical(config.workspace.root), project: projectKey(config), pid, started,
  };
  return locked((dir) => {
    for (const existing of records()) {
      if (existing.id === id && existing.workflow !== next.workflow) {
        throw new Error(`runner ID "${id}" belongs to ${existing.workflow}; choose a different ID for ${next.workflow}`);
      }
      if (!live(existing)) continue;
      if (existing.id === id) throw new Error(`runner "${id}" is already running (pid ${existing.pid})`);
      if (existing.workflow === next.workflow) throw new Error(`workflow ${workflow} is already running as "${existing.id}"`);
      if (overlaps(existing.root, next.root) || overlaps(next.root, existing.root)) {
        throw new Error(`workspace root ${next.root} overlaps runner "${existing.id}" (${existing.root}); set a separate workspace.root`);
      }
      if (existing.project === next.project) {
        throw new Error(`GitHub Project ${next.project} is already managed by runner "${existing.id}"; shared-card claiming is not supported`);
      }
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(next) + "\n", { mode: 0o600 });
    return next;
  });
}

export function assertUnchanged(config: ServiceConfig, entry: RunnerRecord): void {
  if (canonical(config.workspace.root) !== entry.root || projectKey(config) !== entry.project) {
    throw new Error("workspace.root and tracker project cannot change while a runner is active; stop it before changing either");
  }
}
