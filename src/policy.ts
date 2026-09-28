import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PermissionHandler, PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";
import type { Logger } from "./log.ts";

export interface PolicyOptions {
  workspace: string;
  shellAllow: string[];
  shellDeny: string[];
  readAllow: string[];
  urlAllow: string[];
}

type ShellRequest = Extract<PermissionRequest, { kind: "shell" }>;

const APPROVE: PermissionRequestResult = { kind: "approve-once" };
const reject = (feedback: string): PermissionRequestResult => ({ kind: "reject", feedback });

/** Resolves symlinks of the longest existing prefix so `ws/link/../..` tricks cannot escape. */
function canonical(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    head = realpathSync(head);
  } catch {
    // Keep the lexical path.
  }
  return join(head, ...tail);
}

export function isInside(path: string, roots: string[], cwd: string): boolean {
  if (path === "/dev/null") return roots.includes("/dev/null");
  const target = canonical(isAbsolute(path) ? path : resolve(cwd, path));
  return roots.some((root) => {
    if (root === "/dev/null") return false;
    const rel = relative(canonical(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function normalizeCommand(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function startsWithWords(text: string, prefix: string): boolean {
  return text === prefix || text.startsWith(prefix.endsWith("/") ? prefix : `${prefix} `);
}

/**
 * A rule with spaces matches a command prefix at a word boundary; otherwise it matches the executable.
 * The runtime's identifier may already include a subcommand ("git status").
 */
export function ruleMatches(rule: string, identifier: string, commandText: string): boolean {
  const r = normalizeCommand(rule);
  if (r === "") return false;
  const id = normalizeCommand(identifier);
  if (r.includes(" ")) return startsWithWords(commandText, r) || startsWithWords(id, r);
  const executable = id.split(" ")[0] ?? "";
  return executable === r || basename(executable) === r;
}

function urlAllowed(url: string, allow: string[]): boolean {
  return allow.some((prefix) => url.startsWith(prefix));
}

function decideShell(request: ShellRequest, o: PolicyOptions): PermissionRequestResult {
  if (request.requestSandboxBypass) return reject("Running outside the sandbox is not allowed in unattended runs.");
  const cwd = request.resolvedWorkingDirectory ?? o.workspace;
  if (!isInside(cwd, [o.workspace], o.workspace)) return reject("Commands must run inside the workspace.");
  const segments = request.commandSegments?.length
    ? request.commandSegments.map((s) => ({ identifier: s.identifier, text: normalizeCommand(s.fullCommandText) }))
    : request.commands.length === 1
      ? [{ identifier: request.commands[0]!.identifier, text: normalizeCommand(request.fullCommandText) }]
      : request.commands.map((c) => ({ identifier: c.identifier, text: normalizeCommand(c.identifier) }));
  if (segments.length === 0) return reject("The command could not be parsed.");
  for (const segment of segments) {
    const denied = o.shellDeny.find((rule) => ruleMatches(rule, segment.identifier, segment.text));
    if (denied) return reject(`"${denied}" is not allowed in unattended runs. Use the tracker_* tools for GitHub actions (they push and open the pull request for you).`);
    if (!o.shellAllow.some((rule) => ruleMatches(rule, segment.identifier, segment.text))) {
      return reject(`Command "${segment.identifier}" is not on this workflow's allow list.`);
    }
  }
  if (request.possibleUrls.some((u) => !urlAllowed(u.url, o.urlAllow))) return reject("Network access from shell commands is disabled.");
  const readOnly = request.commands.every((c) => c.readOnly) && !request.hasWriteFileRedirection;
  const roots = readOnly ? [o.workspace, ...o.readAllow, "/dev/null"] : [o.workspace, "/dev/null"];
  const outside = request.possiblePaths.find((p) => !isInside(p, roots, cwd));
  if (outside) return reject(`Path ${outside} is outside the workspace.`);
  return APPROVE;
}

export function decide(request: PermissionRequest, o: PolicyOptions): PermissionRequestResult {
  // No human is watching; managed policy asks for one explicitly.
  if (request.managedApprovalRequired) return { kind: "user-not-available" };
  switch (request.kind) {
    case "read": {
      const path = request.resolvedPath ?? request.path;
      return isInside(path, [o.workspace, ...o.readAllow], o.workspace) ? APPROVE : reject(`Reading ${path} is outside the workspace.`);
    }
    case "write": {
      if (request.requestSandboxBypass) return reject("Writing outside the sandbox is not allowed.");
      const path = request.resolvedPath ?? request.fileName;
      return isInside(path, [o.workspace], o.workspace) ? APPROVE : reject(`Writing ${path} is outside the workspace.`);
    }
    case "shell":
      return decideShell(request, o);
    case "url":
      return urlAllowed(request.url, o.urlAllow) ? APPROVE : reject("Network access is disabled for this workflow.");
    case "custom-tool":
      // Only the orchestrator registers custom tools, and each is scoped to the current issue.
      return APPROVE;
    case "mcp":
      return reject("MCP tools are disabled in unattended runs; use the tracker_* tools.");
    default:
      return reject(`"${request.kind}" permission is not granted in unattended runs.`);
  }
}

export function createPermissionHandler(options: PolicyOptions, log: Logger): PermissionHandler {
  return (request) => {
    const result = decide(request, options);
    const detail = request.kind === "shell" ? request.fullCommandText
      : request.kind === "write" ? request.fileName
      : request.kind === "read" ? request.path
      : request.kind === "url" ? request.url
      : "toolName" in request ? request.toolName : undefined;
    if (result.kind === "approve-once") log.debug("permission approved", { kind: request.kind, detail });
    else log.warn("permission denied", { kind: request.kind, detail, reason: "feedback" in result ? result.feedback : result.kind });
    return result;
  };
}
