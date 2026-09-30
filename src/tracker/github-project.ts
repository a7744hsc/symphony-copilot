import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { resolveEnvRef } from "../config.ts";
import { ExecError, run } from "../exec.ts";
import { IMPLEMENTATION_HEAD_CHECK_LIMIT, IMPLEMENTATION_HEAD_RETRY_MS, validateReviewResult, type IssueMessageRef, type PendingHandoff } from "../iteration.ts";
import { truncate, type Logger } from "../log.ts";
import { isInside } from "../policy.ts";
import { normalizeState, type BlockerRef, type Issue } from "../types.ts";
import { graphqlRequest, restRequest, type FetchLike, type GitHubApi } from "./github-api.ts";
import { CONTEXT_SECTIONS, readIssueContext } from "./issue-context.ts";
import { TrackerError, type AgentControl, type AgentToolContext, type MergeConflict, type TrackerAdapter } from "./types.ts";

interface ReviewArgs {
  verdict: string;
  reviewed_head?: string | null;
  progress: string;
  progress_reason: string;
  next_action?: string | null;
  next_step?: string | null;
  summary: string;
  blocking_issues?: string[];
  attachments?: string[];
}

export interface GitHubProjectSettings {
  endpoint: string;
  token: string;
  tokenEnvName: string | null;
  owner: string;
  ownerType: "user" | "organization";
  projectNumber: number;
  repoOwner: string;
  repoName: string;
  statusField: string;
  priorityField: string;
  identifierPrefix: string;
  branchPrefix: string;
  startState: string;
  workingState: string;
  agentStates: string[];
  handoffState: string | null;
  blockedState: string;
  /** Branch that holds screenshots attached to submissions; never merged. */
  evidenceBranch: string;
  /** Where agents file out-of-scope problems; null means agents cannot create issues. */
  followups: FollowupSettings | null;
}

export interface FollowupSettings {
  labels: string[];
  state: string | null;
  priority: string | null;
  maxPerSession: number;
}

const NO_STATUS = "No Status";
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface Attachment {
  name: string;
  data: Buffer;
}

/** Checks agent-supplied image paths: inside the workspace, an image type, and within the size limit. */
export function readAttachments(workspacePath: string, paths: unknown): { files: Attachment[] } | { failure: string } {
  if (paths === undefined || paths === null) return { files: [] };
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string" && p.trim() !== "")) return { failure: "attachments must be a list of file paths" };
  const files: Attachment[] = [];
  for (const raw of paths as string[]) {
    const path = isAbsolute(raw) ? raw : resolve(workspacePath, raw);
    if (!isInside(path, [workspacePath], workspacePath)) return { failure: `${raw} is outside the workspace` };
    if (!IMAGE_TYPES.has(extname(path).toLowerCase())) return { failure: `${raw} is not a PNG, JPEG, GIF or WebP image` };
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return { failure: `${raw} is not a file` };
      size = stat.size;
    } catch {
      return { failure: `${raw} does not exist` };
    }
    if (size > MAX_ATTACHMENT_BYTES) return { failure: `${raw} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB; attach a smaller image` };
    files.push({ name: basename(path), data: readFileSync(path) });
  }
  return { files };
}

/** Files that would conflict when merging `base` into HEAD, checked without touching the working tree. Empty when git cannot tell. */
export async function conflictingFiles(cwd: string, base: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  try {
    await run("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD"], { cwd, env });
    return [];
  } catch (error) {
    // Exit status 1 means conflicts: the first line is the tree, then one path per line. Older git (< 2.38) fails differently.
    if (!(error instanceof ExecError) || error.exitCode !== 1) return [];
    return error.stdout.split("\n").slice(1).map((line) => line.trim()).filter(Boolean);
  }
}

export function parseSettings(provider: Record<string, unknown>, env: NodeJS.ProcessEnv): GitHubProjectSettings {
  const str = (key: string, fallback?: string): string => {
    const value = provider[key] ?? fallback;
    if (typeof value !== "string" || value.trim() === "") throw new TrackerError("invalid_tracker_config", `tracker.provider.${key} is required`);
    return value.trim();
  };
  const rawToken = provider.token ?? "$SYMPHONY_GITHUB_TOKEN";
  const tokenEnvName = typeof rawToken === "string" && rawToken.startsWith("$") ? rawToken.slice(1) : null;
  const token = resolveEnvRef(rawToken, env);
  if (typeof token !== "string" || token === "") {
    throw new TrackerError("missing_tracker_secret", `tracker.provider.token is empty${tokenEnvName ? ` (set ${tokenEnvName})` : ""}`);
  }
  const ownerType = str("owner_type", "user");
  if (ownerType !== "user" && ownerType !== "organization") throw new TrackerError("invalid_tracker_config", "tracker.provider.owner_type must be user or organization");
  const projectNumber = Number(provider.project_number);
  if (!Number.isInteger(projectNumber) || projectNumber < 1) throw new TrackerError("invalid_tracker_config", "tracker.provider.project_number must be a positive integer");
  const [repoOwner, repoName, extra] = str("repo").split("/");
  if (!repoOwner || !repoName || extra !== undefined) throw new TrackerError("invalid_tracker_config", "tracker.provider.repo must look like owner/name");
  const agentStates = provider.agent_states ?? [];
  if (!Array.isArray(agentStates) || !agentStates.every((s) => typeof s === "string")) {
    throw new TrackerError("invalid_tracker_config", "tracker.provider.agent_states must be a list of strings");
  }
  const handoff = provider.handoff_state;
  if (handoff !== undefined && handoff !== null && typeof handoff !== "string") throw new TrackerError("invalid_tracker_config", "tracker.provider.handoff_state must be a string");
  return {
    endpoint: str("endpoint", "https://api.github.com/graphql"),
    token,
    tokenEnvName,
    owner: str("owner"),
    ownerType,
    projectNumber,
    repoOwner,
    repoName,
    statusField: str("status_field", "Status"),
    priorityField: str("priority_field", "Priority"),
    identifierPrefix: str("identifier_prefix", "GH-"),
    branchPrefix: str("branch_prefix", "agent/"),
    startState: str("start_state"),
    workingState: str("working_state"),
    agentStates: agentStates as string[],
    handoffState: typeof handoff === "string" && handoff.trim() !== "" ? handoff.trim() : null,
    blockedState: str("blocked_state"),
    evidenceBranch: str("evidence_branch", "symphony-evidence"),
    followups: parseFollowups(provider.followups),
  };
}

function parseFollowups(raw: unknown): FollowupSettings | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new TrackerError("invalid_tracker_config", "tracker.provider.followups must be a map");
  const f = raw as Record<string, unknown>;
  const labels = f.labels ?? [];
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string" && l.trim() !== "")) {
    throw new TrackerError("invalid_tracker_config", "tracker.provider.followups.labels must be a list of label names");
  }
  const optional = (key: string) => {
    const value = f[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim() === "") throw new TrackerError("invalid_tracker_config", `tracker.provider.followups.${key} must be a string`);
    return value.trim();
  };
  const max = f.max_per_session ?? 3;
  if (!Number.isInteger(max) || (max as number) < 1) throw new TrackerError("invalid_tracker_config", "tracker.provider.followups.max_per_session must be a positive integer");
  return { labels: labels as string[], state: optional("state"), priority: optional("priority"), maxPerSession: max as number };
}

// ---- Normalization (pure; see README "Adapter profile") ----

interface RawBlocker { id?: string; number?: number; state?: string; repository?: { nameWithOwner?: string } }
interface RawContent {
  __typename?: string;
  id?: string;
  number?: number;
  title?: string;
  body?: string | null;
  url?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  repository?: { nameWithOwner?: string };
  assignees?: { nodes?: Array<{ login?: string } | null> };
  labels?: { nodes?: Array<{ name?: string } | null> };
  blockedBy?: { nodes?: Array<RawBlocker | null> };
}
export interface RawItem {
  __typename?: string;
  id?: string;
  isArchived?: boolean;
  project?: { id?: string };
  status?: { name?: string } | null;
  priority?: { name?: string; number?: number } | null;
  content?: RawContent | null;
}

export type NormalizeResult =
  | { kind: "issue"; issue: Issue }
  | { kind: "out_of_scope"; reason: string }
  | { kind: "malformed"; reason: string };

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parsePriority(raw: RawItem["priority"]): number | null {
  if (!raw) return null;
  if (typeof raw.number === "number" && Number.isFinite(raw.number)) return Math.trunc(raw.number);
  const match = typeof raw.name === "string" ? /(\d+)/.exec(raw.name) : null;
  return match ? Number(match[1]) : null;
}

export function normalizeItem(item: RawItem, s: GitHubProjectSettings): NormalizeResult {
  if (typeof item?.id !== "string" || item.id === "") return { kind: "malformed", reason: "project item without id" };
  const content = item.content;
  if (!content || content.__typename !== "Issue") return { kind: "out_of_scope", reason: `content is ${content?.__typename ?? "missing"}` };
  const repo = content.repository?.nameWithOwner ?? "";
  const scopeRepo = `${s.repoOwner}/${s.repoName}`;
  if (repo.toLowerCase() !== scopeRepo.toLowerCase()) return { kind: "out_of_scope", reason: `issue from ${repo || "unknown repo"}` };
  if (typeof content.id !== "string" || !Number.isInteger(content.number) || typeof content.title !== "string" || content.title.trim() === "") {
    return { kind: "malformed", reason: `item ${item.id} lacks issue id, number or title` };
  }
  if (content.state !== "OPEN" && content.state !== "CLOSED") return { kind: "malformed", reason: `item ${item.id} lacks a valid native issue state` };
  const number = content.number as number;
  const labels = [...new Set((content.labels?.nodes ?? [])
    .map((node) => (typeof node?.name === "string" ? node.name.trim().toLowerCase() : ""))
    .filter((name) => name !== ""))];
  const blockedBy: BlockerRef[] = (content.blockedBy?.nodes ?? [])
    .filter((node): node is RawBlocker => node !== null && typeof node === "object")
    .map((node) => {
      const sameRepo = (node.repository?.nameWithOwner ?? scopeRepo).toLowerCase() === scopeRepo.toLowerCase();
      const identifier = Number.isInteger(node.number)
        ? sameRepo ? `${s.identifierPrefix}${node.number}` : `${node.repository?.nameWithOwner}#${node.number}`
        : null;
      return { id: node.id ?? null, identifier, state: node.state ?? null };
    });
  const state = item.status?.name?.trim() || NO_STATUS;
  const open = content.state === "OPEN";
  return {
    kind: "issue",
    issue: {
      id: item.id,
      nativeRef: { project_item_id: item.id, issue_id: content.id, issue_number: number, repository: repo },
      identifier: `${s.identifierPrefix}${number}`,
      title: content.title,
      description: typeof content.body === "string" && content.body.trim() !== "" ? content.body : null,
      priority: parsePriority(item.priority),
      state,
      contentState: content.state,
      branchName: `${s.branchPrefix}${number}`,
      url: typeof content.url === "string" ? content.url : null,
      assigneeId: content.assignees?.nodes?.find((n) => typeof n?.login === "string")?.login ?? null,
      labels,
      blockedBy,
      dispatchable: open && item.isArchived !== true && blockedBy.every((b) => b.state === "CLOSED"),
      createdAt: parseDate(content.createdAt),
      updatedAt: parseDate(content.updatedAt),
    },
  };
}

// ---- GraphQL ----

const ITEM_FIELDS = `
  __typename
  id
  isArchived
  project { id }
  status: fieldValueByName(name: $statusField) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
  priority: fieldValueByName(name: $priorityField) {
    ... on ProjectV2ItemFieldSingleSelectValue { name }
    ... on ProjectV2ItemFieldNumberValue { number }
  }
  content {
    __typename
    ... on Issue {
      id number title body url state createdAt updatedAt
      repository { nameWithOwner }
      assignees(first: 1) { nodes { login } }
      labels(first: 50) { nodes { name } }
      blockedBy(first: 20) { nodes { id number state repository { nameWithOwner } } }
    }
  }`;

interface ProjectMeta {
  projectId: string;
  statusFieldId: string;
  statusOptions: Array<{ id: string; name: string }>;
  priorityFieldId: string | null;
  priorityOptions: Array<{ id: string; name: string }>;
}

interface ToolFailure {
  failure: string;
}

function toolFailure(message: string): ToolResultObject {
  return { resultType: "failure", textResultForLlm: message, error: message };
}

const resultMarker = (p: PendingHandoff) => `<!-- symphony-result:${p.id} -->`;
const invocationMarker = (id: string) => `<!-- symphony-invocation:${id} -->`;
const usageBlock = (id: string, footer = "") => `<!-- symphony-usage:${id}:start -->\n${footer ? `${footer}\n` : ""}<!-- symphony-usage:${id}:end -->`;
const statusBlock = (p: PendingHandoff, text: string) => `<!-- symphony-handoff:${p.id}:start -->\n${text}\n<!-- symphony-handoff:${p.id}:end -->`;
function resultBody(p: PendingHandoff): string {
  const r = p.result;
  const details = r.kind === "review" ? [
    `**AI review · ${r.verdict}**`, `Reviewed HEAD: ${r.reviewedHead ?? "unavailable (no quality verdict)"}`,
    r.summary, `**Progress: ${r.progress}**\n\n${r.progressReason}`,
    r.nextAction ? `**Next action: ${r.nextAction}**\n\n${r.nextStep}` : "",
    r.blockingIssues.length ? `**Blocking issues**\n\n${r.blockingIssues.map((b, i) => `${i + 1}. ${b}`).join("\n")}` : "",
  ] : r.kind === "implement" ? [`**Implementation handoff: ${r.title}**`, `HEAD: ${r.head}`, r.summary] : ["**Blocked**", r.summary];
  return [...details, p.haltReason ? `**Stop reason: ${p.haltReason}**${p.haltReason === "session_limit_unreviewed" ? " — latest implementation has not been reviewed." : ""}` : "",
    resultMarker(p), invocationMarker(p.invocationId)].filter(Boolean).join("\n\n");
}

interface OpenPullRequest { id: string; number: number; url: string; headRefOid: string; body: string }

function replaceMarkedBlock(body: string, start: string, end: string, replacement: string): string | null {
  if (body.split(start).length !== 2 || body.split(end).length !== 2) return null;
  const from = body.indexOf(start), to = body.indexOf(end);
  if (to < from) return null;
  return body.slice(0, from) + replacement + body.slice(to + end.length);
}

/** Canonical identity and the host-owned status block are critical; the usage footer is not. */
function isIssueResult(body: string, p: PendingHandoff): boolean {
  return body.split(resultMarker(p)).length === 2 && body.split(invocationMarker(p.invocationId)).length === 2 &&
    replaceMarkedBlock(body, `<!-- symphony-handoff:${p.id}:start -->`, `<!-- symphony-handoff:${p.id}:end -->`, "") !== null;
}

export class GitHubProjectTracker implements TrackerAdapter {
  readonly kind = "github_project";
  readonly settings: GitHubProjectSettings;
  private readonly log: Logger;
  private readonly fetchImpl: FetchLike;
  private meta: Promise<ProjectMeta> | null = null;
  private repoMeta: Promise<{ id: string; defaultBranch: string }> | null = null;

  constructor(provider: Record<string, unknown>, env: NodeJS.ProcessEnv, log: Logger, fetchImpl: FetchLike = fetch) {
    this.settings = parseSettings(provider, env);
    this.log = log;
    this.fetchImpl = fetchImpl;
  }

  secretEnvironmentNames(): string[] {
    const names = ["SYMPHONY_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
    if (this.settings.tokenEnvName) names.push(this.settings.tokenEnvName);
    return [...new Set(names)];
  }

  async commentOnIssue(issue: Issue, body: string): Promise<void> {
    await this.addComment(this.issueNodeId(issue), body);
  }

  async blockIssue(issue: Issue): Promise<string | null> {
    if (!this.settings.blockedState) return null;
    await this.setStatus(issue, this.settings.blockedState);
    return this.settings.blockedState;
  }

  async moveIssue(issue: Issue, state: string): Promise<void> {
    await this.setStatus(issue, state);
  }

  async findMergeConflicts(issues: Issue[]): Promise<MergeConflict[]> {
    const withBranch = issues.filter((issue) => issue.branchName);
    const conflicts: MergeConflict[] = [];
    for (let i = 0; i < withBranch.length; i += 50) {
      const chunk = withBranch.slice(i, i + 50);
      const params = chunk.map((_, j) => `$b${j}: String!`).join(", ");
      const fields = chunk.map((_, j) => `pr${j}: pullRequests(headRefName: $b${j}, states: [OPEN], first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { number url mergeable baseRefName } }`).join("\n");
      const data: any = await this.graphql(
        `query($owner: String!, $name: String!, ${params}) { repository(owner: $owner, name: $name) { ${fields} } }`,
        { owner: this.settings.repoOwner, name: this.settings.repoName, ...Object.fromEntries(chunk.map((issue, j) => [`b${j}`, issue.branchName])) },
      );
      chunk.forEach((issue, j) => {
        // GitHub computes mergeability in the background and answers UNKNOWN until it is done; a later poll sees the result.
        const pr = data?.repository?.[`pr${j}`]?.nodes?.[0];
        if (pr?.mergeable === "CONFLICTING") conflicts.push({ issue, pullRequest: { number: pr.number, url: pr.url, baseBranch: pr.baseRefName } });
      });
    }
    return conflicts;
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    if (states.length === 0) return [];
    const wanted = new Set(states.map(normalizeState));
    const ownerField = this.settings.ownerType === "user" ? "user" : "organization";
    const query = `query($login: String!, $number: Int!, $after: String, $statusField: String!, $priorityField: String!) {
      owner: ${ownerField}(login: $login) { projectV2(number: $number) {
        items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${ITEM_FIELDS} } }
      } } }`;
    const issues: Issue[] = [];
    let after: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= 100) throw new TrackerError("tracker_pagination", "more than 100 pages of project items");
      const data: any = await this.graphql(query, { ...this.vars(), after });
      const connection = data?.owner?.projectV2?.items;
      if (!connection) throw new TrackerError("invalid_tracker_config", `project ${this.settings.owner}#${this.settings.projectNumber} not found or not accessible`);
      for (const node of connection.nodes ?? []) {
        const result = normalizeItem(node ?? {}, this.settings);
        if (result.kind === "malformed") this.log.warn("skipping malformed project item", { reason: result.reason });
        else if (result.kind === "issue" && wanted.has(normalizeState(result.issue.state))) issues.push(result.issue);
      }
      if (!connection.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (typeof after !== "string" || after === "") throw new TrackerError("tracker_pagination", "hasNextPage without endCursor");
    }
    return issues;
  }

  async fetchIssuesByIds(ids: string[]): Promise<Issue[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const { projectId } = await this.projectMeta();
    const query = `query($ids: [ID!]!, $statusField: String!, $priorityField: String!) {
      nodes(ids: $ids) { ... on ProjectV2Item { ${ITEM_FIELDS} } } }`;
    const issues: Issue[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      const data: any = await this.graphql(query, { ids: unique.slice(i, i + 100), statusField: this.settings.statusField, priorityField: this.settings.priorityField });
      for (const node of data?.nodes ?? []) {
        if (!node || node.__typename !== "ProjectV2Item" || node.project?.id !== projectId) continue;
        const result = normalizeItem(node, this.settings);
        if (result.kind === "malformed") throw new TrackerError("tracker_response", result.reason);
        if (result.kind === "issue") issues.push(result.issue);
      }
    }
    return issues;
  }

  agentTools(context: AgentToolContext): Tool<any>[] {
    let lastComment: { summary: string; body: string; message: IssueMessageRef } | null = null;
    let mutating = false;
    const wrap = <T>(name: string, fn: (args: T) => Promise<unknown>) => async (args: T) => {
      context.log.info("tracker tool called", { tool: name });
      const mutation = name !== "tracker_get_issue";
      let locked = false;
      try {
        context.control?.assertActive(); // Accepted handoffs remain readable until the invocation is drained.
        if (mutation) {
          if (context.control?.accepted()) throw new Error("a result has already been accepted; no further mutations are allowed");
          if (mutating) throw new Error("another mutating tracker tool is still running");
          mutating = locked = true;
        }
        const result = await fn(args);
        if (result && typeof result === "object" && "failure" in result) {
          context.log.warn("tracker tool failed", { tool: name, error: (result as ToolFailure).failure });
          return toolFailure((result as ToolFailure).failure);
        }
        return result;
      } catch (error) {
        context.log.warn("tracker tool failed", { tool: name, error: (error as Error).message });
        return toolFailure(`${name} failed: ${(error as Error).message}`);
      } finally {
        if (locked) mutating = false;
      }
    };
    const tools: Tool<any>[] = [
      defineTool("tracker_get_issue", {
        description: "Read the current issue and its open PR, including full text and unabridged blocking_feedback from reviews. No arguments returns the overview and small pages of recent feedback. Follow pagination.next (including each thread's pagination) by passing those exact arguments to this tool; history_complete=false means more history exists. Text is never clipped; read any runtime-saved output file in sections before claiming a check is complete. Use at the start of work, rework and review.",
        parameters: {
          type: "object",
          properties: {
            section: { type: "string", enum: [...CONTEXT_SECTIONS], description: "Default overview; use the section returned in pagination.next to read more history" },
            cursor: { type: "string", description: "Opaque cursor from pagination.next; comments/reviews go backwards to older pages, threads go forwards" },
            thread_id: { type: "string", description: "Required only for thread_comments; must belong to this issue's open PR" },
          },
          additionalProperties: false,
        },
        skipPermission: true,
        handler: wrap("tracker_get_issue", (args: unknown) => this.issueContext(context.issue, args)),
      }),
      defineTool("tracker_comment", {
        description: "Post a Markdown comment on the current issue (progress notes, assumptions, blockers).",
        parameters: { type: "object", properties: { body: { type: "string", description: "Markdown comment body" } }, required: ["body"], additionalProperties: false },
        skipPermission: true,
        handler: wrap("tracker_comment", async ({ body }: { body: string }) => {
          if (typeof body !== "string" || body.trim() === "") return { failure: "body must be a non-empty string" };
          const postedBody = context.control ? `${body}\n\n${invocationMarker(context.control.id)}\n${usageBlock(context.control.id)}` : body;
          context.control?.assertActive();
          const message = await this.addComment(this.issueNodeId(context.issue), postedBody);
          lastComment = { summary: body, body: postedBody, message };
          context.control?.onIssueMessage(message);
          return { comment_id: message.id, comment_url: message.url };
        }),
      }),
    ];
    const followups = this.settings.followups;
    if (followups) {
      const filed = { count: 0 };
      tools.push(defineTool("tracker_create_followup", {
        description: `File a separate issue for a problem you found that is outside this issue's scope (tech debt, a bug elsewhere, a later improvement), instead of fixing it now or writing it into a document. It goes on the board${followups.state ? ` in "${followups.state}"` : ""}${followups.priority ? ` with priority ${followups.priority}` : ""}, and no agent works on it until a person decides to. One problem per issue, with a specific title; an open issue with the same title is reused. At most ${followups.maxPerSession} per session.`,
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Specific title, for example \"Guest bubbles cover the floor sign when three guests talk\"" },
            body: { type: "string", description: "Markdown: what is wrong, where (file and line), the impact, and a suggested fix" },
          },
          required: ["title", "body"],
          additionalProperties: false,
        },
        skipPermission: true,
        handler: wrap("tracker_create_followup", (args: { title: string; body: string }) => this.createFollowup(context, followups, filed, args)),
      }));
    }
    const review = context.review;
    if (review) {
      tools.push(defineTool("tracker_submit_review", {
        description: `Finish a complete risk-focused review (review ${review.round}). Saves the full record on the issue before mirroring it to the PR. The host decides continuation or Blocked from progress, human requirements and remaining sessions; this is not a fixed review-round cap. Use unable_to_verify when required access or evidence is unavailable. Do not change implementation or commit/push; remove disposable verification tests first. Do not approve unread material.`,
        parameters: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["approve", "request_changes", "unable_to_verify"] },
            reviewed_head: { type: ["string", "null"], description: "Exact checked commit SHA; nullable only for unable_to_verify" },
            progress: { type: "string", enum: ["initial", "made_progress", "no_progress", "not_assessed"] },
            progress_reason: { type: "string", description: "Evidence for progress or the missing verification conditions" },
            next_action: { type: ["string", "null"], enum: ["continue", "human_required", null] },
            next_step: { type: ["string", "null"], description: "Changed approach or concrete human action needed; null for approval" },
            summary: { type: "string", description: "Markdown: criteria and inferred invariants checked, independent counterexamples, commands/results, earlier blockers verified, unverified areas and non-blocking suggestions" },
            blocking_issues: { type: "array", items: { type: "string" }, description: "Required when requesting changes: each problem that must be fixed before a human reviews, with file and line where possible" },
            attachments: { type: "array", items: { type: "string" }, description: `Optional: images in your workspace (at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each) that show a visible problem or confirm a visible change. One per scenario; leave out when nothing visible is involved.` },
          },
          required: ["verdict", "reviewed_head", "progress", "progress_reason", "summary"],
          additionalProperties: false,
        },
        skipPermission: true,
        handler: wrap("tracker_submit_review", (args: ReviewArgs) => this.submitReview(context, args)),
      }));
      return tools;
    }
    tools.push(
      defineTool("tracker_submit_for_review", {
        description: `Hand the work to a human: requires all changes committed in the workspace, and HEAD must merge into the default branch without conflicts. Pushes HEAD to branch ${context.issue.branchName}, opens (or updates) the pull request that closes this issue, posts the summary on the issue${this.settings.handoffState ? `, and moves the card to "${this.settings.handoffState}"` : ""}. Do not push yourself.`,
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Pull request title" },
            summary: { type: "string", description: "Markdown: what changed, how it was verified (commands and results), and what still needs human or device verification" },
            attachments: {
              type: "array",
              items: { type: "string" },
              description: `Optional: images in the workspace (PNG, JPEG, GIF or WebP, at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each) that show a visible change, such as a before/after comparison. They are shown on the issue and the pull request. Pick one image per scenario that matters; do not attach many near-identical images (for example the same screen at every size). Leave this out when the change has no visible effect.`,
            },
          },
          required: ["title", "summary"],
          additionalProperties: false,
        },
        skipPermission: true,
        handler: wrap("tracker_submit_for_review", (args: { title: string; summary: string; attachments?: string[] }) => this.submitForReview(context, args)),
      }),
    );
    if (this.settings.agentStates.length > 0) {
      tools.push(defineTool("tracker_set_status", {
        description: `Move the current issue's card to another status. Allowed: ${this.settings.agentStates.join(", ")}. Comment with the reason before setting a blocked status.`,
        parameters: { type: "object", properties: { status: { type: "string", enum: this.settings.agentStates } }, required: ["status"], additionalProperties: false },
        skipPermission: true,
        handler: wrap("tracker_set_status", async ({ status }: { status: string }) => {
          const allowed = this.settings.agentStates.find((s) => normalizeState(s) === normalizeState(String(status)));
          if (!allowed) return { failure: `status must be one of: ${this.settings.agentStates.join(", ")}` };
          if (normalizeState(allowed) === normalizeState(this.settings.blockedState)) {
            if (!lastComment) return { failure: "post the complete blocking reason with tracker_comment in this invocation first" };
            const control = this.handoffControl(context);
            const p = await control.accept({ kind: "blocked", summary: lastComment.summary }, context.workspacePath);
            // Upgrade the exact prior comment, never whichever comment happens to be last remotely.
            const previous = await this.issueMessage(context.issue, lastComment.message);
            if (previous?.body === lastComment.body && await this.handoffIssue(context.issue, p)) {
              control.assertActive();
              await this.editIssueMessage(lastComment.message.id, this.issueResultBody(p));
              p.issueMessage = lastComment.message;
              control.checkpoint();
            }
            return this.publishAccepted(context, control, p);
          }
          context.control?.assertActive();
          await this.setStatus(context.issue, allowed, () => context.control?.assertActive());
          return { status: allowed };
        }),
      }));
    }
    return tools;
  }

  // ---- tool implementations ----

  private async createFollowup(context: AgentToolContext, f: FollowupSettings, filed: { count: number }, args: { title: string; body: string }): Promise<unknown> {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (title === "") return { failure: "title must be a non-empty string" };
    if (typeof args.body !== "string" || args.body.trim() === "") return { failure: "body must be a non-empty string" };
    if (filed.count >= f.maxPerSession) return { failure: `you already filed ${f.maxPerSession} issues in this session; list further problems in your summary instead` };
    const repoName = `${this.settings.repoOwner}/${this.settings.repoName}`;
    const found: any = await this.graphql(
      `query($q: String!) { search(query: $q, type: ISSUE, first: 10) { nodes { ... on Issue { number title url } } } }`,
      { q: `repo:${repoName} is:issue is:open in:title ${JSON.stringify(title)}` },
    );
    const duplicate = (found?.search?.nodes ?? []).find((n: any) => typeof n?.title === "string" && n.title.trim().toLowerCase() === title.toLowerCase());
    if (duplicate) return { duplicate_of: duplicate.url, number: duplicate.number, note: "an open issue with this title already exists; nothing was created" };

    const repo = await this.repository();
    const labelData: any = await this.graphql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { labels(first: 100) { nodes { id name } } } }`,
      { owner: this.settings.repoOwner, name: this.settings.repoName },
    );
    const existing = labelData?.repository?.labels?.nodes ?? [];
    const labelIds: string[] = [];
    for (const name of f.labels) {
      const label = existing.find((l: any) => normalizeState(l?.name ?? "") === normalizeState(name));
      if (label) labelIds.push(label.id);
      else context.log.warn("follow-up label not found in repository", { label: name });
    }
    const source = context.issue.nativeRef?.issue_number;
    const role = context.review ? "reviewer" : "implementer";
    const body = `${args.body.trim()}\n\n---\n_Filed by symphony-copilot's ${role} while working on #${source}._`;
    context.control?.assertActive();
    const created: any = await this.graphql(
      `mutation($repo: ID!, $title: String!, $body: String!, $labels: [ID!]) { createIssue(input: { repositoryId: $repo, title: $title, body: $body, labelIds: $labels }) { issue { id number url } } }`,
      { repo: repo.id, title, body, labels: labelIds },
    );
    const issue = created?.createIssue?.issue;
    if (!issue?.id) throw new TrackerError("tracker_response", "createIssue returned no issue");
    filed.count++;
    const meta = await this.projectMeta();
    context.control?.assertActive();
    const added: any = await this.graphql(
      `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
      { project: meta.projectId, content: issue.id },
    );
    const itemId = added?.addProjectV2ItemById?.item?.id;
    const warnings: string[] = [];
    context.control?.assertActive();
    if (itemId && f.state) await this.setOption(itemId, meta.statusFieldId, meta.statusOptions, f.state, () => context.control?.assertActive()).catch((e: Error) => warnings.push(e.message));
    if (itemId && f.priority) {
      if (meta.priorityFieldId) await this.setOption(itemId, meta.priorityFieldId, meta.priorityOptions, f.priority, () => context.control?.assertActive()).catch((e: Error) => warnings.push(e.message));
      else warnings.push(`priority field "${this.settings.priorityField}" is not a single-select field`);
    }
    for (const warning of warnings) context.log.warn("follow-up board update failed", { issue: issue.url, error: warning });
    context.log.info("follow-up issue created", { issue: issue.url });
    return { issue_url: issue.url, number: issue.number, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  private handoffControl(context: AgentToolContext): AgentControl {
    if (!context.control) throw new Error("mutating handoff requires an invocation control");
    context.control.assertActive();
    if (context.control.accepted()) throw new Error("a result has already been accepted");
    return context.control;
  }

  private async publishAccepted(context: AgentToolContext, control: AgentControl, p: PendingHandoff): Promise<unknown> {
    let outcome: { stale: boolean };
    try {
      outcome = await this.publishHandoff(context.issue, p, () => control.checkpoint(), () => control.assertActive());
    } finally {
      if (p.issueMessage) control.onIssueMessage(p.issueMessage);
    }
    control.finish(outcome.stale);
    return { accepted: true, stale: outcome.stale, status: outcome.stale ? null : p.targetState, pull_request: p.pr?.url ?? null };
  }

  private async attachmentSummary(context: AgentToolContext, summary: string, files: Attachment[]): Promise<string> {
    if (!files.length) return summary;
    context.control?.assertActive();
    try {
      const images = (await this.uploadEvidence(context.issue, files, () => context.control?.assertActive())).map((u) => `![${u.name}](${u.url})`).join("\n");
      return `${summary}\n\n${images}`;
    } catch (error) {
      context.log.warn("attachment upload failed", { error: (error as Error).message });
      return `${summary}\n\n_Screenshots could not be attached: ${truncate((error as Error).message, 300)}_`;
    }
  }

  private async submitReview(context: AgentToolContext, args: ReviewArgs): Promise<unknown> {
    const control = this.handoffControl(context);
    const result = validateReviewResult({ kind: "review", verdict: args.verdict, summary: args.summary,
      reviewedHead: args.reviewed_head ?? null, progress: args.progress, progressReason: args.progress_reason,
      nextAction: args.next_action ?? null, nextStep: args.next_step ?? null, blockingIssues: args.blocking_issues ?? [],
    }, control.initialReview);
    const attachments = readAttachments(context.workspacePath, args.attachments);
    if ("failure" in attachments) return attachments;
    let pr: OpenPullRequest | null = null;
    if (result.verdict !== "unable_to_verify") {
      pr = await this.openPullRequest(context.issue);
      if (!pr) return { failure: `there is no open pull request for ${context.issue.branchName} to review` };
      if (pr.headRefOid !== result.reviewedHead) return { failure: "reviewed_head does not match the current PR head; read and verify the new head first" };
      if (await this.git(context.workspacePath, ["rev-parse", "HEAD"]) !== result.reviewedHead) {
        return { failure: "reviewed_head does not match the local checkout HEAD" };
      }
    }
    result.summary = await this.attachmentSummary(context, result.summary, attachments.files);
    control.assertActive();
    const p = await control.accept(result, context.workspacePath);
    if (pr) { p.pr = { id: pr.id, number: pr.number, url: pr.url }; control.checkpoint(); }
    return this.publishAccepted(context, control, p);
  }

  private issueNodeId(issue: Issue): string {
    const id = issue.nativeRef?.issue_id;
    if (typeof id !== "string") throw new TrackerError("tracker_response", `issue ${issue.identifier} has no issue node id`);
    return id;
  }

  private async issueContext(issue: Issue, args: unknown): Promise<unknown> {
    return readIssueContext({
      issue, issueId: this.issueNodeId(issue), repoOwner: this.settings.repoOwner, repoName: this.settings.repoName,
      graphql: (query, variables) => this.graphql(query, variables),
      readStatus: async () => (await this.fetchIssuesByIds([issue.id]))[0]?.state ?? null,
    }, args);
  }

  private async addComment(subjectId: string, body: string): Promise<IssueMessageRef> {
    const data: any = await this.graphql(
      `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { id url } } } }`,
      { id: subjectId, body },
    );
    const node = data?.addComment?.commentEdge?.node;
    if (!node?.id) throw new TrackerError("tracker_response", "addComment returned no comment id");
    return { id: node.id, url: node.url ?? null };
  }

  private async setStatus(issue: Issue, statusName: string, assertActive: () => void = () => {}): Promise<void> {
    const meta = await this.projectMeta();
    await this.setOption(issue.id, meta.statusFieldId, meta.statusOptions, statusName, assertActive);
  }

  private async setOption(itemId: string, fieldId: string, options: Array<{ id: string; name: string }>, optionName: string, assertActive: () => void = () => {}): Promise<void> {
    const meta = await this.projectMeta();
    const option = options.find((o) => normalizeState(o.name) === normalizeState(optionName));
    if (!option) throw new TrackerError("invalid_tracker_config", `"${optionName}" is not an option of that project field`);
    assertActive();
    const data: any = await this.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
      { project: meta.projectId, item: itemId, field: fieldId, option: option.id },
    );
    if (data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) throw new TrackerError("tracker_response", "status mutation returned no matching project item");
  }

  private async submitForReview(context: AgentToolContext, args: { title: string; summary: string; attachments?: string[] }): Promise<unknown> {
    const control = this.handoffControl(context);
    const { issue, workspacePath } = context;
    if (typeof args.title !== "string" || args.title.trim() === "") return { failure: "title must be a non-empty string" };
    if (typeof args.summary !== "string" || args.summary.trim() === "") return { failure: "summary must be a non-empty string" };
    const branch = issue.branchName;
    if (!branch) return { failure: "issue has no branch name" };
    const attachments = readAttachments(workspacePath, args.attachments);
    if ("failure" in attachments) return attachments;
    const git = (gitArgs: string[]) => this.git(workspacePath, gitArgs);

    const dirty = await git(["status", "--porcelain"]);
    if (dirty) return { failure: `the workspace has uncommitted changes; commit them first:\n${truncate(dirty, 1500)}` };
    const repo = await this.repository();
    control.assertActive();
    await git(["fetch", "--quiet", "origin", repo.defaultBranch]);
    const head = await git(["rev-parse", "HEAD"]);
    const existing = await this.openPullRequest(issue);
    const ahead = Number(await git(["rev-list", "--count", `origin/${repo.defaultBranch}..HEAD`]));
    if (!ahead && existing?.headRefOid !== head) return { failure: `HEAD has no commits beyond origin/${repo.defaultBranch}; nothing to review` };
    const conflicts = await conflictingFiles(workspacePath, `origin/${repo.defaultBranch}`, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
    if (conflicts.length > 0) {
      return { failure: `HEAD conflicts with origin/${repo.defaultBranch} in: ${truncate(conflicts.join(", "), 1000)}. Run \`git merge origin/${repo.defaultBranch}\`, resolve the conflicts keeping the intent of both sides, rerun the checks, commit, and submit again.` };
    }
    const summary = await this.attachmentSummary(context, args.summary, attachments.files);
    control.assertActive();
    const p = await control.accept({ kind: "implement", head, title: args.title, summary }, workspacePath);
    if (existing) { p.pr = { id: existing.id, number: existing.number, url: existing.url }; control.checkpoint(); }
    return this.publishAccepted(context, control, p);
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => r.stdout.trim());
  }

  private async openPullRequest(issue: Issue): Promise<OpenPullRequest | null> {
    const data: any = await this.graphql(
      `query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $branch, states: [OPEN], first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { id number url headRefOid body } } } }`,
      { owner: this.settings.repoOwner, name: this.settings.repoName, branch: issue.branchName ?? "" },
    );
    if (!data?.repository?.pullRequests?.nodes) throw new TrackerError("tracker_response", "missing pull request lookup");
    const pr = data.repository.pullRequests.nodes[0];
    if (!pr) return null;
    if (!pr.id || !pr.number || !pr.url || !pr.headRefOid) throw new TrackerError("tracker_response", "incomplete pull request identity/head");
    return pr;
  }

  /** Resolve the current project item from native identity, including remove/re-add of the same issue. */
  private async publicationIssue(issue: Issue): Promise<Issue | null> {
    const { projectId } = await this.projectMeta();
    let after: string | null = null;
    const cursors = new Set<string>();
    let current: Issue | null = null;
    for (;;) {
      const data: any = await this.graphql(
        `query($id: ID!, $after: String, $statusField: String!, $priorityField: String!) {
          node(id: $id) { ... on Issue { id state repository { nameWithOwner }
            projectItems(first: 100, after: $after) { nodes { ${ITEM_FIELDS} } pageInfo { hasNextPage endCursor } }
          } } }`,
        { id: this.issueNodeId(issue), after, statusField: this.settings.statusField, priorityField: this.settings.priorityField },
      );
      const node = data?.node;
      if (!node || node.state === "CLOSED") return null;
      if (node.id !== this.issueNodeId(issue) || node.state !== "OPEN" ||
        node.repository?.nameWithOwner?.toLowerCase() !== `${this.settings.repoOwner}/${this.settings.repoName}`.toLowerCase()) {
        throw new TrackerError("tracker_response", "publication issue identity/state mismatch");
      }
      const connection = node.projectItems;
      if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new TrackerError("tracker_response", "missing issue project items/pagination");
      for (const raw of connection.nodes) {
        if (raw?.project?.id !== projectId || raw.isArchived) continue;
        const normalized = normalizeItem(raw, this.settings);
        if (normalized.kind !== "issue" || this.issueNodeId(normalized.issue) !== node.id) throw new TrackerError("tracker_response", "invalid publication item");
        if (current) throw new TrackerError("tracker_response", "ambiguous publication item");
        current = normalized.issue;
      }
      if (!connection.pageInfo.hasNextPage) return current?.dispatchable ? current : null;
      after = connection.pageInfo.endCursor;
      if (typeof after !== "string" || !after || cursors.has(after)) throw new TrackerError("tracker_pagination", "project item cursor did not advance");
      cursors.add(after);
    }
  }

  /** Search only the current result's marker, with full bodies and complete pagination. */
  private async findResultMessage(subjectId: string, p: PendingHandoff, kind: "Issue" | "PullRequest", reviews = false): Promise<IssueMessageRef | null> {
    const field = reviews ? "reviews" : "comments";
    let after: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const data: any = await this.graphql(
        `query($id: ID!, $after: String) { node(id: $id) { ... on ${kind} { id
          ${field}(first: 100, after: $after) { nodes { id url body ${reviews ? "commit { oid }" : ""} } pageInfo { hasNextPage endCursor } }
        } } }`, { id: subjectId, after },
      );
      const connection = data?.node?.[field];
      if (data?.node?.id !== subjectId || !Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
        throw new TrackerError("tracker_response", `missing ${field} for result reconciliation`);
      }
      for (const node of connection.nodes) {
        if (typeof node?.body !== "string" || !node.body.includes(resultMarker(p)) || !node.body.includes(invocationMarker(p.invocationId))) continue;
        if (kind === "Issue" && !isIssueResult(node.body, p)) continue;
        if (reviews && p.result.kind === "review" && node.commit?.oid !== p.result.reviewedHead) continue;
        if (!node.id) throw new TrackerError("tracker_response", "result comment has no identity");
        return { id: node.id, url: node.url ?? null };
      }
      if (!connection.pageInfo.hasNextPage) return null;
      after = connection.pageInfo.endCursor;
      if (typeof after !== "string" || !after || cursors.has(after)) throw new TrackerError("tracker_pagination", "result comment cursor did not advance");
      cursors.add(after);
    }
  }

  private issueResultBody(p: PendingHandoff): string {
    return `${resultBody(p)}\n\n${statusBlock(p, p.stale ? "Stale result: source evidence only; no target state or progress applied." : `Publication pending; target: ${p.targetState}. This is not yet a completed handoff.`)}\n\n${usageBlock(p.invocationId)}`;
  }

  private async handoffIssue(issue: Issue, p: PendingHandoff): Promise<Issue | null> {
    const current = await this.publicationIssue(issue);
    if (!current) return null;
    const needsPr = p.haltReason !== "head_mismatch" && (p.result.kind === "implement" || (p.result.kind === "review" && p.result.verdict !== "unable_to_verify"));
    const completed = p.issueMessage && (!needsPr || p.prPublished && (p.result.kind !== "implement" || p.pushed));
    // Board automation may advance to the intended target before PR metadata catches up.
    // Retain the pending SHA fence there rather than clear it and dispatch a reviewer early.
    const reconcilingHead = p.result.kind === "implement" && p.pushed && p.issueMessage && p.headMismatch;
    return normalizeState(current.state) === normalizeState(p.sourceState) ||
      (completed || reconcilingHead) && normalizeState(current.state) === normalizeState(p.targetState) ? current : null;
  }

  private async ensureIssueResult(issue: Issue, p: PendingHandoff, checkpoint: () => void, assertActive: () => void): Promise<{ body: string } | null> {
    if (p.issueMessage) {
      const current = await this.issueMessage(issue, p.issueMessage);
      assertActive();
      if (current && isIssueResult(current.body, p)) return current;
    }
    // A saved reference is not evidence the comment still exists or remains invocation-owned.
    // Preserve edited comments; reconcile a replacement only within the original native issue.
    const found = await this.findResultMessage(this.issueNodeId(issue), p, "Issue");
    if (!await this.handoffIssue(issue, p)) return null;
    assertActive();
    p.issueMessage = found ?? await this.addComment(this.issueNodeId(issue), this.issueResultBody(p));
    checkpoint();
    const current = await this.issueMessage(issue, p.issueMessage);
    assertActive();
    if (!current || !isIssueResult(current.body, p)) throw new TrackerError("tracker_response", "canonical issue result unavailable or changed during publication");
    return current;
  }

  private async issueMessage(issue: Issue, message: IssueMessageRef): Promise<{ body: string } | null> {
    const data: any = await graphqlRequest(this.api(),
      `query($id: ID!) { node(id: $id) { ... on IssueComment { id body issue { id } } } }`,
      { id: message.id }, { allowNotFound: true });
    const node = data?.node;
    if (!node || node.id !== message.id || node.issue?.id !== this.issueNodeId(issue) || typeof node.body !== "string") return null;
    return { body: node.body };
  }

  private async editIssueMessage(id: string, body: string): Promise<void> {
    const data: any = await this.graphql(
      `mutation($id: ID!, $body: String!) { updateIssueComment(input: { id: $id, body: $body }) { issueComment { id } } }`, { id, body });
    if (data?.updateIssueComment?.issueComment?.id !== id) throw new TrackerError("tracker_response", "updateIssueComment returned no matching comment");
  }

  private async finalizeIssueResult(issue: Issue, p: PendingHandoff, checkpoint: () => void, assertActive: () => void): Promise<boolean> {
    const current = await this.ensureIssueResult(issue, p, checkpoint, assertActive);
    if (!current) return false;
    const start = `<!-- symphony-handoff:${p.id}:start -->`, end = `<!-- symphony-handoff:${p.id}:end -->`;
    const text = p.haltReason === "head_mismatch" && p.result.kind === "implement" && p.headMismatch
      ? `Handoff blocked: ${p.targetState}. Stop reason: head_mismatch after ${p.headMismatch.attempts} host checks; expected HEAD: ${p.result.head}; actual PR HEAD: ${p.headMismatch.actualHead}. Latest implementation has not been reviewed. Check the branch/PR, then return the card to "${this.settings.startState}" to reauthorize.`
      : p.stale ? "Stale result: source evidence only; no target state or progress applied."
      : `Handoff completed: ${p.targetState}.${p.pr ? ` [PR #${p.pr.number}](${p.pr.url})` : ""}`;
    const body = replaceMarkedBlock(current.body, start, end, statusBlock(p, text));
    if (body === null) throw new TrackerError("tracker_response", "canonical issue result has no unambiguous host status block");
    if (body === current.body) return true;
    assertActive();
    await this.editIssueMessage(p.issueMessage!.id, body);
    return true;
  }

  /** Resume the one persisted semantic result. No model, policy decision, or current checkout substitution. */
  async publishHandoff(issue: Issue, p: PendingHandoff, checkpoint: () => void, assertActive: () => void): Promise<{ stale: boolean }> {
    assertActive();
    if (p.headMismatch && p.haltReason !== "head_mismatch" && Date.now() < p.headMismatch.retryAt) {
      throw new Error(`PR head check pending until ${new Date(p.headMismatch.retryAt).toISOString()}; host will retry without another agent`);
    }
    const needsPr = p.result.kind === "implement" || (p.result.kind === "review" && p.result.verdict !== "unable_to_verify");
    const qualityReview = p.result.kind === "review" && p.result.verdict !== "unable_to_verify";
    const stale = () => { p.stale = true; checkpoint(); return { stale: true }; };
    const refresh = async (): Promise<Issue | null> => {
      assertActive();
      const current = await this.handoffIssue(issue, p);
      assertActive();
      return current;
    };
    let current = await refresh();
    if (!current) return stale();
    const staleHead = async () => {
      p.stale = true; checkpoint();
      await this.finalizeIssueResult(current!, p, checkpoint, assertActive);
      return { stale: true };
    };
    const finishPublication = async () => {
      current = await refresh();
      if (!current) return stale();
      if (!await this.ensureIssueResult(current, p, checkpoint, assertActive)) return stale();
      current = await refresh();
      if (!current) return stale();
      assertActive();
      if (normalizeState(current.state) !== normalizeState(p.targetState)) await this.setStatus(current, p.targetState, assertActive);
      p.statusApplied = true; checkpoint();
      if (!await this.finalizeIssueResult(current, p, checkpoint, assertActive)) return stale();
      return { stale: false };
    };
    const mismatchedHead = async (actualHead: string): Promise<{ stale: boolean }> => {
      if (p.result.kind !== "implement" || !p.pushed) return staleHead();
      const attempts = (p.headMismatch?.attempts ?? 0) + 1;
      p.headMismatch = { attempts, actualHead, retryAt: Date.now() + IMPLEMENTATION_HEAD_RETRY_MS };
      if (attempts >= IMPLEMENTATION_HEAD_CHECK_LIMIT) {
        // This is a publication failure, not another rework or a quality verdict.
        p.sourceState = current!.state;
        p.targetState = p.waitingState = this.settings.blockedState;
        p.haltReason = "head_mismatch";
      }
      checkpoint();
      const detail = `PR head mismatch: expected ${p.result.head}; actual ${actualHead}; host check ${attempts}/${IMPLEMENTATION_HEAD_CHECK_LIMIT}`;
      this.log.warn("implementation handoff head mismatch", { issue_identifier: issue.identifier, expected_head: p.result.head, actual_head: actualHead, checks: attempts });
      if (attempts < IMPLEMENTATION_HEAD_CHECK_LIMIT) throw new Error(`${detail}; publication pending, retry after ${new Date(p.headMismatch.retryAt).toISOString()}`);
      return finishPublication();
    };
    const checkHead = async (): Promise<{ stale: boolean } | null> => {
      if (!needsPr) return null;
      const pr = await this.openPullRequest(current!);
      assertActive();
      const expected = p.result.kind === "review" ? p.result.reviewedHead : p.result.kind === "implement" ? p.result.head : null;
      if (p.pr && pr?.id !== p.pr.id) return staleHead();
      if ((qualityReview || p.pushed || p.prPublished) && pr && pr.headRefOid !== expected) return mismatchedHead(pr.headRefOid);
      if ((qualityReview || p.prPublished) && !pr) return staleHead();
      return null;
    };
    if (p.stale) return staleHead();
    // Once Blocked is decided, retry only its publication; do not grant more SHA checks.
    if (p.haltReason === "head_mismatch") return finishPublication();
    const before = await checkHead();
    if (before) return before;
    if (!await this.ensureIssueResult(current, p, checkpoint, assertActive)) return stale();

    if (p.result.kind === "implement" && !p.pushed) {
      current = await refresh();
      if (!current) return stale();
      const git = (args: string[]) => this.git(p.workspacePath, args);
      if (await git(["rev-parse", "HEAD"]) !== p.result.head || await git(["status", "--porcelain"])) {
        throw new Error("accepted implementation no longer matches its clean workspace; refusing to push a different result");
      }
      assertActive();
      // The saved SHA, not a moving HEAD; never force-push.
      await git(["push", "--quiet", "origin", `${p.result.head}:refs/heads/${current.branchName}`]);
      p.pushed = true; checkpoint();
    }

    if (needsPr && !p.prPublished) {
      current = await refresh();
      if (!current) return stale();
      let pr = await this.openPullRequest(current);
      assertActive();
      if (p.pr && pr?.id !== p.pr.id) return staleHead();
      const expected = p.result.kind === "review" ? p.result.reviewedHead : p.result.kind === "implement" ? p.result.head : null;
      if (pr && pr.headRefOid !== expected) return mismatchedHead(pr.headRefOid);
      if (qualityReview && !pr) return staleHead();
      if (!pr && p.result.kind === "implement") {
        const repo = await this.repository();
        if (!await this.ensureIssueResult(current, p, checkpoint, assertActive)) return stale();
        current = await refresh();
        if (!current) return stale();
        assertActive();
        const data: any = await this.graphql(
          `mutation($repo: ID!, $base: String!, $head: String!, $title: String!, $body: String!) {
            createPullRequest(input: { repositoryId: $repo, baseRefName: $base, headRefName: $head, title: $title, body: $body }) { pullRequest { id number url headRefOid body } } }`,
          { repo: repo.id, base: repo.defaultBranch, head: current.branchName, title: p.result.title,
            body: `${resultBody(p)}\n\nCloses #${current.nativeRef?.issue_number}` },
        );
        pr = data?.createPullRequest?.pullRequest ?? null;
        if (!pr?.id || !pr.number || !pr.url) throw new TrackerError("tracker_response", "createPullRequest returned no PR identity");
        p.pr = { id: pr.id, number: pr.number, url: pr.url };
        p.prPublished = true; checkpoint();
      } else if (pr) {
        p.pr = { id: pr.id, number: pr.number, url: pr.url }; checkpoint();
        const inBody = p.result.kind === "implement" && pr.body?.includes(resultMarker(p)) && pr.body.includes(invocationMarker(p.invocationId));
        const found = inBody || await this.findResultMessage(pr.id, p, "PullRequest", qualityReview);
        assertActive();
        if (!found) {
          current = await refresh();
          if (!current) return stale();
          if (!await this.ensureIssueResult(current, p, checkpoint, assertActive)) return stale();
          current = await refresh();
          if (!current) return stale();
          if (p.result.kind === "review") {
            // COMMENT is intentional: GitHub does not allow self-approval. Bind the checked SHA explicitly.
            const data: any = await this.graphql(
              `mutation($pr: ID!, $head: GitObjectID!, $body: String!) { addPullRequestReview(input: { pullRequestId: $pr, commitOID: $head, event: COMMENT, body: $body }) { pullRequestReview { id url } } }`,
              { pr: pr.id, head: p.result.reviewedHead, body: resultBody(p) },
            );
            if (!data?.addPullRequestReview?.pullRequestReview?.id) throw new TrackerError("tracker_response", "addPullRequestReview returned no review id");
          } else await this.addComment(pr.id, resultBody(p));
        }
        p.prPublished = true; checkpoint();
      }
    }

    current = await refresh();
    if (!current) return stale();
    const after = await checkHead();
    return after ?? finishPublication();
  }

  /** Cosmetic only. Read the typed, invocation-owned issue message; never guess the last comment. */
  async updateUsageFooter(issue: Issue, message: IssueMessageRef, invocationId: string, footer: string): Promise<void> {
    if (!invocationId || /[\r\n<>]/.test(invocationId) || !footer.trim() || /[\r\n<>]/.test(footer)) return;
    const current = await this.issueMessage(issue, message);
    if (!current || current.body.split(invocationMarker(invocationId)).length !== 2) return;
    const start = `<!-- symphony-usage:${invocationId}:start -->`, end = `<!-- symphony-usage:${invocationId}:end -->`;
    const body = replaceMarkedBlock(current.body, start, end, usageBlock(invocationId, footer));
    if (body === null || body === current.body) return;
    await this.editIssueMessage(message.id, body);
  }

  /** Commits images to the evidence branch and returns links that render for people with repository access. */
  async uploadEvidence(issue: Issue, files: Attachment[], assertActive: () => void = () => {}): Promise<Array<{ name: string; url: string }>> {
    const repoPath = `/repos/${this.settings.repoOwner}/${this.settings.repoName}`;
    const ref = `heads/${this.settings.evidenceBranch}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const paths = files.map((f, i) => `${issue.identifier}/${stamp}-${i + 1}-${f.name}`);
    const blobs: string[] = [];
    for (const file of files) {
      assertActive();
      const blob: any = await this.rest("POST", `${repoPath}/git/blobs`, { content: file.data.toString("base64"), encoding: "base64" });
      blobs.push(blob.sha);
    }
    for (let attempt = 0; ; attempt++) {
      const head: any = await this.rest("GET", `${repoPath}/git/ref/${ref}`, undefined, true);
      const parent: string | null = head?.object?.sha ?? null;
      const baseTree: string | undefined = parent ? (await this.rest("GET", `${repoPath}/git/commits/${parent}`) as any).tree.sha : undefined;
      assertActive();
      const tree: any = await this.rest("POST", `${repoPath}/git/trees`, {
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: paths.map((path, i) => ({ path, mode: "100644", type: "blob", sha: blobs[i] })),
      });
      assertActive();
      const commit: any = await this.rest("POST", `${repoPath}/git/commits`, {
        message: `evidence: ${issue.identifier}`, tree: tree.sha, parents: parent ? [parent] : [],
      });
      try {
        assertActive();
        if (parent) await this.rest("PATCH", `${repoPath}/git/refs/${ref}`, { sha: commit.sha, force: false });
        else await this.rest("POST", `${repoPath}/git/refs`, { ref: `refs/${ref}`, sha: commit.sha });
      } catch (error) {
        if (attempt < 2) continue;
        throw error;
      }
      const web = `https://github.com/${this.settings.repoOwner}/${this.settings.repoName}`;
      return paths.map((path, i) => ({ name: files[i]!.name, url: `${web}/blob/${commit.sha}/${path.split("/").map(encodeURIComponent).join("/")}?raw=true` }));
    }
  }

  // ---- plumbing ----

  private vars() {
    return { login: this.settings.owner, number: this.settings.projectNumber, statusField: this.settings.statusField, priorityField: this.settings.priorityField };
  }

  private projectMeta(): Promise<ProjectMeta> {
    this.meta ??= (async () => {
      const ownerField = this.settings.ownerType === "user" ? "user" : "organization";
      const data: any = await this.graphql(
        `query($login: String!, $number: Int!, $statusField: String!, $priorityField: String!) { owner: ${ownerField}(login: $login) { projectV2(number: $number) {
          id field(name: $statusField) { ... on ProjectV2SingleSelectField { id options { id name } } }
          priority: field(name: $priorityField) { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
        { login: this.settings.owner, number: this.settings.projectNumber, statusField: this.settings.statusField, priorityField: this.settings.priorityField },
      );
      const project = data?.owner?.projectV2;
      if (!project?.id) throw new TrackerError("invalid_tracker_config", `project ${this.settings.owner}#${this.settings.projectNumber} not found or not accessible`);
      if (!project.field?.id) throw new TrackerError("invalid_tracker_config", `single-select field "${this.settings.statusField}" not found`);
      return {
        projectId: project.id,
        statusFieldId: project.field.id,
        statusOptions: project.field.options ?? [],
        priorityFieldId: project.priority?.id ?? null,
        priorityOptions: project.priority?.options ?? [],
      };
    })().catch((error) => {
      this.meta = null;
      throw error;
    });
    return this.meta;
  }

  private repository(): Promise<{ id: string; defaultBranch: string }> {
    this.repoMeta ??= (async () => {
      const data: any = await this.graphql(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id defaultBranchRef { name } } }`,
        { owner: this.settings.repoOwner, name: this.settings.repoName },
      );
      const repo = data?.repository;
      if (!repo?.id || !repo.defaultBranchRef?.name) throw new TrackerError("invalid_tracker_config", `repository ${this.settings.repoOwner}/${this.settings.repoName} not accessible`);
      return { id: repo.id, defaultBranch: repo.defaultBranchRef.name };
    })().catch((error) => {
      this.repoMeta = null;
      throw error;
    });
    return this.repoMeta;
  }

  /** GitHub REST call with the tracker token; `allowMissing` turns a 404 into null. */
  private rest(method: string, path: string, body?: unknown, allowMissing = false): Promise<unknown> {
    return restRequest(this.api(), method, path, body, allowMissing);
  }

  private graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    return graphqlRequest(this.api(), query, variables);
  }

  private api(): GitHubApi {
    return { endpoint: this.settings.endpoint, token: this.settings.token, fetchImpl: this.fetchImpl };
  }
}
