#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { buildConfig } from "./config.ts";
import { loadWorkflow } from "./workflow.ts";

export interface WorkflowInstance {
  id: string;
  workflowPath: string;
  workspaceRoot: string;
  ledgerPath: string;
  project: string | null;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export function defaultWorkflowId(workflowPath: string): string {
  const path = resolve(workflowPath);
  const file = basename(path, extname(path)).toLowerCase();
  const slug = file.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "workflow";
  return `${slug}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
}

export function describeWorkflow(workflowPath: string, requestedId?: string): WorkflowInstance {
  const path = resolve(workflowPath);
  const definition = loadWorkflow(path);
  const config = buildConfig(definition.config, path);
  const id = requestedId ?? defaultWorkflowId(path);
  if (!ID_PATTERN.test(id)) {
    throw new Error("workflow ID must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens, and must start and end with a letter or number");
  }
  return {
    id,
    workflowPath: path,
    workspaceRoot: config.workspace.root,
    ledgerPath: resolve(config.workspace.root, ".symphony-ledger.json"),
    project: projectIdentity(config.tracker.kind, config.tracker.provider),
  };
}

function projectIdentity(kind: string, provider: Record<string, unknown>): string | null {
  if (kind !== "github_project") return null;
  const owner = typeof provider.owner === "string" ? provider.owner.trim().toLowerCase() : "";
  const ownerType = typeof provider.owner_type === "string" ? provider.owner_type.trim().toLowerCase() : "user";
  const projectNumber = Number(provider.project_number);
  if (!owner || !Number.isInteger(projectNumber) || projectNumber < 1) return null;
  return `github_project:${ownerType}:${owner}:${projectNumber}`;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return resolve(realpathSync.native(existing), relative(existing, absolute));
}

export function collisionMessage(candidate: WorkflowInstance, existing: WorkflowInstance[]): string | null {
  const candidateWorkflow = canonicalPath(candidate.workflowPath);
  const candidateWorkspace = canonicalPath(candidate.workspaceRoot);
  const candidateLedger = canonicalPath(candidate.ledgerPath);
  for (const other of existing) {
    const otherWorkflow = canonicalPath(other.workflowPath);
    if (other.id === candidate.id && otherWorkflow !== candidateWorkflow) {
      return `workflow ID "${candidate.id}" is already assigned to ${other.workflowPath}; choose a different ID with --id`;
    }
    if (otherWorkflow === candidateWorkflow) {
      return `workflow ${candidate.workflowPath} is already running as "${other.id}"`;
    }
    if (canonicalPath(other.workspaceRoot) === candidateWorkspace || canonicalPath(other.ledgerPath) === candidateLedger) {
      return `workflow "${candidate.id}" shares state with running workflow "${other.id}" at ${candidate.workspaceRoot}; configure a different workspace.root`;
    }
    if (candidate.project && other.project === candidate.project) {
      return `workflow "${candidate.id}" targets the same GitHub Project as running workflow "${other.id}" (${candidate.project}); sharing a project is unsafe because card claiming is not coordinated`;
    }
  }
  return null;
}

function readInstance(path: string): WorkflowInstance {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkflowInstance>;
  if (!value.id || !value.workflowPath || !value.workspaceRoot || !value.ledgerPath) {
    throw new Error(`invalid runner metadata ${path}`);
  }
  return { ...value, project: value.project ?? null } as WorkflowInstance;
}

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "describe" && args[0]) {
      process.stdout.write(`${JSON.stringify(describeWorkflow(args[0], args[1]))}\n`);
      return 0;
    }
    if (command === "field" && args[0] && args[1]) {
      const instance = readInstance(args[0]);
      const value = instance[args[1] as keyof WorkflowInstance];
      if (value !== null && value !== undefined) process.stdout.write(String(value));
      return 0;
    }
    if (command === "check" && args[0]) {
      const candidate = readInstance(args[0]);
      const problem = collisionMessage(candidate, args.slice(1).map(readInstance));
      if (problem) {
        process.stderr.write(`${problem}\n`);
        return 1;
      }
      return 0;
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  process.stderr.write("Usage: instance.ts describe WORKFLOW [ID] | field FILE FIELD | check CANDIDATE [RUNNING...]\n");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
