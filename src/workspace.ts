import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ServiceConfig } from "./config.ts";
import { issueEnvironment } from "./env.ts";
import { truncate, type Logger } from "./log.ts";
import type { Issue } from "./types.ts";

export class WorkspaceError extends Error {
  readonly code: "invalid_workspace_path" | "workspace_create_failed" | "hook_failed";
  constructor(code: "invalid_workspace_path" | "workspace_create_failed" | "hook_failed", message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface Workspace {
  path: string;
  key: string;
  createdNow: boolean;
}

/** Spec §4.2: only [A-Za-z0-9._-]; a changed identifier gets a 64-bit hash suffix. */
export function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === identifier && sanitized !== "" && sanitized !== "." && sanitized !== "..") return sanitized;
  const hash = createHash("sha256").update(identifier).digest("hex").slice(0, 16);
  return `${sanitized}-${hash}`;
}

export function assertInsideRoot(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new WorkspaceError("invalid_workspace_path", `${path} is not inside workspace root ${root}`);
  }
}

export function workspacePath(root: string, identifier: string): string {
  const path = resolve(root, workspaceKey(identifier));
  assertInsideRoot(root, path);
  return path;
}

export interface HookResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** Runs a trusted hook script with `bash -lc` in the workspace; kills the whole process group on timeout. */
export function runHook(script: string, cwd: string, timeoutMs: number, env: Record<string, string>): Promise<HookResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", script], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // Already exited.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, exitCode: null, timedOut, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0 && !timedOut, exitCode: code, timedOut, output });
    });
  });
}

export type HookName = "after_create" | "before_run" | "after_run" | "before_remove";

function hookScript(config: ServiceConfig, name: HookName): string | null {
  switch (name) {
    case "after_create": return config.hooks.afterCreate;
    case "before_run": return config.hooks.beforeRun;
    case "after_run": return config.hooks.afterRun;
    case "before_remove": return config.hooks.beforeRemove;
  }
}

export class WorkspaceManager {
  private readonly log: Logger;
  private readonly baseEnv: Record<string, string>;

  /** `baseEnv` must already be scrubbed of tracker secrets. */
  constructor(log: Logger, baseEnv: Record<string, string>) {
    this.log = log;
    this.baseEnv = baseEnv;
  }

  async prepare(config: ServiceConfig, issue: Issue): Promise<Workspace> {
    const root = config.workspace.root;
    const key = workspaceKey(issue.identifier);
    const path = workspacePath(root, issue.identifier);
    mkdirSync(root, { recursive: true });
    let createdNow = false;
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      throw new WorkspaceError("invalid_workspace_path", `${path} is a symlink`);
    }
    if (existing && !existing.isDirectory()) {
      throw new WorkspaceError("workspace_create_failed", `${path} exists and is not a directory`);
    }
    if (!existing) {
      mkdirSync(path);
      createdNow = true;
    }
    assertInsideRoot(realpathSync(root), realpathSync(path));
    const workspace = { path, key, createdNow };
    if (createdNow) {
      try {
        await this.hook(config, "after_create", workspace, issue, true);
      } catch (error) {
        rmSync(path, { recursive: true, force: true });
        throw error;
      }
    }
    return workspace;
  }

  /** Fatal hooks throw; best-effort hooks only log. */
  async hook(config: ServiceConfig, name: HookName, workspace: Workspace, issue: Issue, fatal: boolean): Promise<void> {
    const script = hookScript(config, name);
    if (!script) return;
    const log = this.log.child({ issue_id: issue.id, issue_identifier: issue.identifier, hook: name });
    log.info("hook started");
    const env = { ...this.baseEnv, ...issueEnvironment(issue, workspace.path, workspace.key) };
    const result = await runHook(script, workspace.path, config.hooks.timeoutMs, env);
    if (result.ok) {
      log.info("hook completed");
      return;
    }
    const reason = result.timedOut ? `timed out after ${config.hooks.timeoutMs} ms` : `exit code ${result.exitCode}`;
    log[fatal ? "error" : "warn"]("hook failed", { reason, output: truncate(result.output.trim(), 1500) });
    if (fatal) throw new WorkspaceError("hook_failed", `${name} ${reason}`);
  }

  async remove(config: ServiceConfig, issue: Issue): Promise<void> {
    const path = workspacePath(config.workspace.root, issue.identifier);
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (!existing) return;
    if (existing.isDirectory()) {
      await this.hook(config, "before_remove", { path, key: workspaceKey(issue.identifier), createdNow: false }, issue, false);
    }
    rmSync(path, { recursive: true, force: true });
    this.log.info("workspace removed", { issue_id: issue.id, issue_identifier: issue.identifier, path });
  }
}
