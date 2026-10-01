import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ServiceConfig } from "./config.ts";
import { ledgerWritePaths } from "./ledger.ts";
import { parseSettings } from "./tracker/github-project.ts";

export interface RunnerIdentity {
  workflow: string;
  inputs: string[];
  workspace: string;
  project: string;
  scope: string;
}

export interface RunnerRecord extends RunnerIdentity {
  id: string;
  directory: string;
  run: { pid: number; nonce: string; socket: string } | null;
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Resolve existing ancestors too: new directories can still alias through a symlink. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return canonicalPath(resolve(dirname(absolute), readlinkSync(absolute)));
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), basename(absolute));
  }
}

function locationKey(path: string): string {
  // Conservatively reject aliases on platforms commonly using case-insensitive volumes.
  return process.platform === "darwin" || process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

function pathKey(path: string): string {
  return locationKey(canonicalPath(path));
}

export function pathsOverlap(a: string, b: string): boolean {
  const left = [locationKey(a), pathKey(a)];
  const right = [locationKey(b), pathKey(b)];
  const contains = (root: string, target: string) => {
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
  };
  if (left.some((l) => right.some((r) => contains(l, r) || contains(r, l)))) return true;
  const sa = statSync(a, { throwIfNoEntry: false });
  const sb = statSync(b, { throwIfNoEntry: false });
  return Boolean(sa && sb && sa.dev === sb.dev && sa.ino === sb.ino);
}

export function validateId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new Error("workflow ID must be 1-64 letters, digits, underscores or hyphens, beginning with a letter or digit");
  }
  return id.toLowerCase();
}

export function workflowId(path: string): string {
  const canonical = pathKey(path);
  const label = basename(dirname(canonical)).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 35) || "workflow";
  return `${/^[a-z0-9]/.test(label) ? label : "workflow"}-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}

function workflowInputs(config: ServiceConfig): string[] {
  const paths = [config.workflowPath, ...(config.review ? [config.review.promptFile] : [])];
  // Cleanup can remove an input's symlink entry or an ancestor link, not just its read target.
  return [...new Set(paths.flatMap((path) => {
    const locations = [canonicalPath(path)];
    let parent = resolve(path);
    while (dirname(parent) !== parent) {
      parent = dirname(parent);
      locations.push(join(canonicalPath(parent), relative(parent, path)));
    }
    return locations;
  }))];
}

export function runnerIdentity(config: ServiceConfig): RunnerIdentity {
  if (config.tracker.kind !== "github_project") throw new Error(`unsupported tracker kind: ${config.tracker.kind}`);
  const settings = parseSettings({ ...config.tracker.provider, token: "identity-only" }, {});
  const endpoint = new URL(settings.endpoint);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("tracker endpoint must be an HTTP(S) URL without embedded credentials");
  }
  const project = `${endpoint.host.toLowerCase()}/${settings.owner.toLowerCase()}/${settings.projectNumber}`;
  return {
    workflow: canonicalPath(config.workflowPath),
    inputs: workflowInputs(config),
    workspace: canonicalPath(config.workspace.root),
    project,
    scope: JSON.stringify([project, createHash("sha256").update(endpoint.href).digest("hex"), settings.ownerType, `${settings.repoOwner}/${settings.repoName}`.toLowerCase(), settings.identifierPrefix, settings.branchPrefix, config.review?.promptFile ?? null]),
  };
}

export function assertRunnerIdentity(expected: RunnerIdentity, config: ServiceConfig): void {
  const actual = runnerIdentity(config);
  if (pathKey(actual.workflow) !== pathKey(expected.workflow) || pathKey(actual.workspace) !== pathKey(expected.workspace) || actual.scope !== expected.scope ||
    actual.inputs.length !== expected.inputs.length || actual.inputs.some((path, i) => locationKey(path) !== locationKey(expected.inputs[i]!))) {
    throw new Error("runner identity changed (workflow inputs, review.prompt_file, workspace.root or tracker scope); restore it, stop this runner, then restart with the new configuration");
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errno(error, "ESRCH")) return false;
    if (errno(error, "EPERM")) return true;
    throw error;
  }
}

function workspaceResources(record: RunnerRecord): string[] {
  return [record.workspace, ...ledgerWritePaths(join(record.workspace, ".symphony-ledger.json"))];
}

function resources(record: RunnerRecord): string[] {
  return [...record.inputs, ...workspaceResources(record), record.directory, join(record.directory, "orchestrator.log")];
}

function recordValid(value: unknown): value is RunnerRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<RunnerRecord>;
  return typeof r.id === "string" && validateId(r.id) === r.id && typeof r.workflow === "string" &&
    [r.workflow, r.workspace, r.directory].every((p) => typeof p === "string" && isAbsolute(p)) &&
    Array.isArray(r.inputs) && r.inputs.includes(r.workflow) && r.inputs.every((p) => typeof p === "string" && isAbsolute(p)) &&
    typeof r.project === "string" && typeof r.scope === "string" &&
    (r.run === null || Boolean(r.run && Number.isSafeInteger(r.run.pid) && r.run.pid > 0 &&
      typeof r.run.nonce === "string" && typeof r.run.socket === "string"));
}

/** One per trusted OS user, deliberately independent of the configurable log/state directory. */
export class RunnerRegistry {
  readonly root: string;
  readonly path: string;

  constructor(root = join(homedir(), ".symphony", "runners")) {
    this.root = canonicalPath(root);
    this.path = join(this.root, "registry.json");
  }

  list(): RunnerRecord[] {
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (errno(error, "ENOENT")) return [];
      throw new Error(`cannot read runner registry ${this.path}: ${(error as Error).message}`);
    }
    if (!Array.isArray(data) || !data.every(recordValid) || new Set(data.map((r) => r.id)).size !== data.length) {
      throw new Error(`invalid runner registry ${this.path} (complete workflow input paths are required); restore it with all runners stopped before starting runners`);
    }
    return data;
  }

  async claim(record: RunnerRecord): Promise<void> {
    if (!recordValid(record)) throw new Error("invalid runner record; complete workflow input paths are required");
    await this.transaction((records) => {
      const own = records.find((r) => r.id === record.id);
      if (own && pathKey(own.workflow) !== pathKey(record.workflow)) {
        throw new Error(`workflow ID "${record.id}" already belongs to ${own.workflow}; choose another --id`);
      }
      const requested = resources(record);
      const registryPaths = [this.root, this.path, join(this.root, "registry.lock")];
      if (requested.some((p) => registryPaths.some((other) => pathsOverlap(p, other)))) {
        throw new Error(`runner state paths must not overlap the shared registry ${this.root}`);
      }
      const workspacePaths = workspaceResources(record);
      const [ledger, temporary] = ledgerWritePaths(join(record.workspace, ".symphony-ledger.json"));
      const logPaths = [record.directory, join(record.directory, "orchestrator.log")];
      if (workspacePaths.some((p) => logPaths.some((other) => pathsOverlap(p, other))) ||
        record.inputs.some((p) => [...workspacePaths, ...logPaths].some((other) => pathsOverlap(p, other)))) {
        throw new Error("workspace.root, workflow inputs (including review.prompt_file) and runner log directory must not overlap");
      }
      if (pathsOverlap(ledger, temporary)) throw new Error("ledger and temporary file must not overlap");
      for (const other of records) {
        const live = other.run && processAlive(other.run.pid);
        if (other.id === record.id) {
          if (live) throw new Error(`runner "${other.id}" is already running (pid ${other.run!.pid}); stop it first`);
          continue;
        }
        if (live && record.project === other.project) {
          throw new Error(`GitHub Project ${record.project} is already owned by runner "${other.id}"; multiple runners on the same project are not supported, even with different repository filters`);
        }
        if (pathKey(record.workflow) === pathKey(other.workflow)) {
          throw new Error(`workflow ${record.workflow} is registered as "${other.id}"; use that ID`);
        }
        for (const path of requested) {
          const collision = resources(other).find((p) => pathsOverlap(path, p));
          if (collision) throw new Error(`state path collision with runner "${other.id}": ${path} overlaps ${collision}; choose separate, non-nested input/workspace/log paths`);
        }
      }
      if (lstatSync(temporary, { throwIfNoEntry: false })) {
        throw new Error(`ledger temporary path already exists: ${temporary}; with the runner stopped, inspect and remove the leftover file or alias before restarting; do not delete the ledger`);
      }
      if (own) records.splice(records.indexOf(own), 1, record);
      else records.push(record);
    });
  }

  async release(id: string, nonce: string): Promise<void> {
    await this.transaction((records) => {
      const own = records.find((r) => r.id === id);
      if (own?.run?.nonce === nonce) own.run = null;
    });
  }

  private async transaction(update: (records: RunnerRecord[]) => void): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, "registry.lock");
    const deadline = Date.now() + 5_000;
    let fd: number;
    for (;;) {
      try {
        fd = openSync(lock, "wx", 0o600);
        break;
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
        if (Date.now() >= deadline) {
          throw new Error(`runner registry is locked: ${lock}; if its owner crashed, verify no management/startup operation is running before removing this lock`);
        }
        await delay(25);
      }
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(fd, `${process.pid}\n`);
      const records = this.list();
      update(records);
      writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      closeSync(fd);
      for (const path of [temporary, lock]) {
        try { unlinkSync(path); } catch (error) { if (!errno(error, "ENOENT")) throw error; }
      }
    }
  }
}
