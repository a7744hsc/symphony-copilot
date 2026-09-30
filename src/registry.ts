import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ServiceConfig } from "./config.ts";

export interface RunnerRecord {
  id: string;
  workflow: string;
  root: string;
  project: string;
  state: string;
  pid: number;
  started: string;
}

export interface RunnerReservation extends Omit<RunnerRecord, "pid" | "started"> {
  token: string;
  ownerPid: number;
  ownerStarted: string;
}

export const stateDir = () => resolve(process.env.SYMPHONY_STATE_DIR ?? join(process.env.HOME ?? "", "symphony-workspaces"));
const hostDir = () => process.env.NODE_TEST_CONTEXT && process.env.SYMPHONY_TEST_HOST_STATE_DIR
  ? resolve(process.env.SYMPHONY_TEST_HOST_STATE_DIR)
  : join(userInfo().homedir, ".symphony-copilot", "runners");
export const runnerId = (workflow: string) => {
  const path = canonical(workflow);
  const name = basename(path, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "") || "workflow";
  return name + "-" + createHash("sha256").update(path).digest("hex").slice(0, 8);
};

export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`invalid runner ID "${id}" (use letters, digits, _ or -)`);
}

export function normalizeId(id: string): string {
  validateId(id);
  return id.toLowerCase();
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
  const rawType = p.owner_type ?? "user";
  const type = typeof rawType === "string" ? rawType.trim() : rawType;
  const number = Number(p.project_number);
  if (typeof owner !== "string" || !owner.trim() || !["user", "organization"].includes(String(type)) || !Number.isInteger(number) || number < 1) {
    throw new Error("tracker.provider must specify a valid owner, owner_type and project_number");
  }
  return `${type}:${owner.trim().toLowerCase()}:${number}`;
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
  const dir = hostDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function records(): RunnerRecord[] {
  const dir = directory();
  return readdirSync(dir).filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RunnerRecord);
}

export function record(id: string): RunnerRecord | undefined {
  const normalized = normalizeId(id);
  return records().find((entry) => entry.id === normalized);
}

function overlaps(a: string, b: string): boolean {
  const rel = relative(a, b);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function reservationFile(dir: string, id: string): string {
  return join(dir, `${id}.reservation.json`);
}

function reservations(dir: string): RunnerReservation[] {
  return readdirSync(dir).filter((name) => /^[a-z0-9][a-z0-9_-]*\.reservation\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as RunnerReservation);
}

function reservationLive(entry: RunnerReservation): boolean {
  return pidStart(entry.ownerPid) === entry.ownerStarted && entry.ownerStarted !== "";
}

function candidate(id: string, workflow: string, config: ServiceConfig): Omit<RunnerRecord, "pid" | "started"> {
  return {
    id: normalizeId(id),
    workflow: canonical(workflow),
    root: canonical(config.workspace.root),
    project: projectKey(config),
    state: stateDir(),
  };
}

function assertAvailable(
  next: Omit<RunnerRecord, "pid" | "started">,
  activeRecords: RunnerRecord[],
  activeReservations: RunnerReservation[],
  claimToken?: string,
): void {
  for (const existing of [...activeRecords, ...activeReservations.filter((entry) => entry.token !== claimToken)]) {
    if (existing.id === next.id && existing.workflow !== next.workflow) {
      throw new Error(`runner ID "${next.id}" belongs to ${existing.workflow}; choose a different ID for ${next.workflow}`);
    }
    if (existing.id === next.id) throw new Error(`runner "${next.id}" is already running or starting`);
    if (existing.workflow === next.workflow) throw new Error(`workflow ${next.workflow} is already running as "${existing.id}"`);
    if (overlaps(existing.root, next.root) || overlaps(next.root, existing.root)) {
      throw new Error(`workspace root ${next.root} overlaps runner "${existing.id}" (${existing.root}); set a separate workspace.root`);
    }
    if (existing.project === next.project) {
      throw new Error(`GitHub Project ${next.project} is already managed by runner "${existing.id}"; shared-card claiming is not supported`);
    }
  }
}

function assertIdOwnership(next: Omit<RunnerRecord, "pid" | "started">, existing: RunnerRecord[]): void {
  const owner = existing.find((entry) => entry.id === next.id && entry.workflow !== next.workflow);
  if (owner) throw new Error(`runner ID "${next.id}" belongs to ${owner.workflow}; choose a different ID for ${next.workflow}`);
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

export function reserve(id: string, workflow: string, config: ServiceConfig): RunnerReservation {
  const next = candidate(id, workflow, config);
  const ownerStarted = pidStart(process.pid);
  if (!ownerStarted) throw new Error(`cannot inspect manager process ${process.pid}`);
  return locked((dir) => {
    const allRecords = records();
    const activeRecords = allRecords.filter(live);
    const allReservations = reservations(dir);
    const activeReservations = allReservations.filter(reservationLive);
    assertIdOwnership(next, allRecords);
    assertAvailable(next, activeRecords, activeReservations);
    for (const stale of allReservations.filter((entry) => !reservationLive(entry))) rmSync(reservationFile(dir, stale.id), { force: true });
    const reservation: RunnerReservation = { ...next, token: randomUUID(), ownerPid: process.pid, ownerStarted };
    writeFileSync(reservationFile(dir, next.id), JSON.stringify(reservation) + "\n", { mode: 0o600 });
    return reservation;
  });
}

export function releaseReservation(token: string): void {
  locked((dir) => {
    const entry = reservations(dir).find((item) => item.token === token);
    if (entry) rmSync(reservationFile(dir, entry.id), { force: true });
  });
}

export function register(id: string, workflow: string, config: ServiceConfig, pid = process.pid, reservationToken?: string): RunnerRecord {
  const started = pidStart(pid);
  if (!started) throw new Error(`cannot inspect runner process ${pid}`);
  const base = candidate(id, workflow, config);
  const next: RunnerRecord = { ...base, pid, started };
  return locked((dir) => {
    const allRecords = records();
    const allReservations = reservations(dir);
    if (reservationToken) {
      const claimed = allReservations.find((entry) => entry.token === reservationToken);
      if (!claimed || claimed.id !== next.id || claimed.workflow !== next.workflow || claimed.root !== next.root
        || claimed.project !== next.project || claimed.state !== next.state || !reservationLive(claimed)) {
        throw new Error(`runner reservation for "${next.id}" is missing, expired, or does not match its workflow`);
      }
    }
    assertIdOwnership(next, allRecords);
    assertAvailable(next, allRecords.filter(live), allReservations.filter(reservationLive), reservationToken);
    writeFileSync(join(dir, `${next.id}.json`), JSON.stringify(next) + "\n", { mode: 0o600 });
    if (reservationToken) rmSync(reservationFile(dir, next.id), { force: true });
    return next;
  });
}

export function assertUnchanged(config: ServiceConfig, entry: RunnerRecord): void {
  if (canonical(config.workspace.root) !== entry.root || projectKey(config) !== entry.project) {
    throw new Error("workspace.root and tracker project cannot change while a runner is active; stop it before changing either");
  }
}
