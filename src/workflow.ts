import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildConfig, type ServiceConfig } from "./config.ts";
import type { Logger } from "./log.ts";

export type WorkflowErrorCode = "missing_workflow_file" | "workflow_parse_error" | "workflow_front_matter_not_a_map";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export function parseWorkflow(text: string): WorkflowDefinition {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { config: {}, promptTemplate: text.trim() };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) throw new WorkflowError("workflow_parse_error", "front matter is not closed with ---");
  let raw: unknown;
  try {
    raw = parseYaml(lines.slice(1, end).join("\n"));
  } catch (error) {
    throw new WorkflowError("workflow_parse_error", (error as Error).message);
  }
  raw ??= {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowError("workflow_front_matter_not_a_map", "front matter must be a YAML map");
  }
  return { config: raw as Record<string, unknown>, promptTemplate: lines.slice(end + 1).join("\n").trim() };
}

export function loadWorkflow(path: string): WorkflowDefinition {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new WorkflowError("missing_workflow_file", `${path}: ${(error as Error).message}`);
  }
  return parseWorkflow(text);
}

export interface EffectiveWorkflow {
  definition: WorkflowDefinition;
  config: ServiceConfig;
  loadedAt: Date;
}

/**
 * Holds the last known good workflow. Invalid edits are reported and ignored,
 * so the service keeps running on the previous configuration (spec §6.2).
 */
export class WorkflowStore {
  readonly path: string;
  private current: EffectiveWorkflow;
  private lastMtimeMs = 0;
  private lastError: string | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly validate: (config: ServiceConfig) => void;
  private readonly listeners: Array<(workflow: EffectiveWorkflow) => void> = [];

  constructor(path: string, log: Logger, env: NodeJS.ProcessEnv = process.env, validate: (config: ServiceConfig) => void = () => {}) {
    this.path = resolve(path);
    this.log = log;
    this.env = env;
    this.validate = validate;
    this.current = this.read();
  }

  get workflow(): EffectiveWorkflow {
    return this.current;
  }

  /** Error from the most recent failed reload, cleared by a successful one. */
  get reloadError(): string | null {
    return this.lastError;
  }

  onChange(listener: (workflow: EffectiveWorkflow) => void): void {
    this.listeners.push(listener);
  }

  /** Re-reads the file if it changed since the last load; safe to call before every dispatch. */
  refresh(): EffectiveWorkflow {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
    } catch (error) {
      this.fail(new WorkflowError("missing_workflow_file", (error as Error).message));
      return this.current;
    }
    if (mtimeMs === this.lastMtimeMs) return this.current;
    try {
      this.current = this.read();
      this.lastError = null;
      this.log.info("workflow reloaded", { path: this.path });
      for (const listener of this.listeners) listener(this.current);
    } catch (error) {
      this.lastMtimeMs = mtimeMs;
      this.fail(error as Error);
    }
    return this.current;
  }

  watch(): void {
    // Watch the directory: editors often replace the file instead of writing in place.
    this.watcher = watch(dirname(this.path), (_event, file) => {
      if (file !== null && file !== basename(this.path)) return;
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.refresh(), 200);
    });
  }

  close(): void {
    this.watcher?.close();
    if (this.debounce) clearTimeout(this.debounce);
  }

  private read(): EffectiveWorkflow {
    const mtimeMs = statSync(this.path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    const definition = loadWorkflow(this.path);
    const config = buildConfig(definition.config, this.path, this.env);
    this.validate(config);
    this.lastMtimeMs = mtimeMs;
    return { definition, config, loadedAt: new Date() };
  }

  private fail(error: Error): void {
    this.lastError = error.message;
    this.log.error("workflow reload failed; keeping last good config", { path: this.path, error: error.message });
  }
}
