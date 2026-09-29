import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { resolveEnvRef } from "../config.ts";
import { ExecError, run } from "../exec.ts";
import { truncate, type Logger } from "../log.ts";
import { isInside } from "../policy.ts";
import { normalizeState, type BlockerRef, type Issue } from "../types.ts";
import { graphqlRequest, restRequest, type FetchLike, type GitHubApi } from "./github-api.ts";
import { TrackerError, type AgentToolContext, type MergeConflict, type ReviewToolContext, type TrackerAdapter } from "./types.ts";

interface ReviewArgs {
  verdict: string;
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
  agentStates: string[];
  handoffState: string | null;
  blockedState: string | null;
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
  const blocked = provider.blocked_state;
  if (blocked !== undefined && blocked !== null && typeof blocked !== "string") throw new TrackerError("invalid_tracker_config", "tracker.provider.blocked_state must be a string");
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
    agentStates: agentStates as string[],
    handoffState: typeof handoff === "string" && handoff.trim() !== "" ? handoff.trim() : null,
    blockedState: typeof blocked === "string" && blocked.trim() !== "" ? blocked.trim() : null,
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
    const wrap = <T>(name: string, fn: (args: T) => Promise<unknown>) => async (args: T) => {
      context.log.info("tracker tool called", { tool: name });
      try {
        const result = await fn(args);
        if (result && typeof result === "object" && "failure" in result) {
          context.log.warn("tracker tool failed", { tool: name, error: (result as ToolFailure).failure });
          return toolFailure((result as ToolFailure).failure);
        }
        return result;
      } catch (error) {
        context.log.warn("tracker tool failed", { tool: name, error: (error as Error).message });
        return toolFailure(`${name} failed: ${(error as Error).message}`);
      }
    };
    const tools: Tool<any>[] = [
      defineTool("tracker_get_issue", {
        description: "Read the current issue: live board status, body, labels, recent comments, and the open pull request for this issue's branch with its mergeability, reviews and review threads. Use it at the start of a retry or rework.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        skipPermission: true,
        handler: wrap("tracker_get_issue", () => this.issueContext(context.issue)),
      }),
      defineTool("tracker_comment", {
        description: "Post a Markdown comment on the current issue (progress notes, assumptions, blockers).",
        parameters: { type: "object", properties: { body: { type: "string", description: "Markdown comment body" } }, required: ["body"], additionalProperties: false },
        skipPermission: true,
        handler: wrap("tracker_comment", async ({ body }: { body: string }) => {
          if (typeof body !== "string" || body.trim() === "") return { failure: "body must be a non-empty string" };
          return { comment_url: await this.addComment(this.issueNodeId(context.issue), body) };
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
        description: `Finish your review (round ${review.round} of ${review.maxRounds}). Posts the review on the pull request and the issue, then moves the card to "${review.passState}" if you approve or "${review.failState}" if you request changes${review.round >= review.maxRounds ? ` (this is the last round: requesting changes hands the card to a human in "${review.passState}" instead)` : ""}. You cannot change code or push.`,
        parameters: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["approve", "request_changes"] },
            summary: { type: "string", description: "Markdown: what you checked (acceptance criteria one by one, commands you ran and their results) and non-blocking suggestions" },
            blocking_issues: { type: "array", items: { type: "string" }, description: "Required when requesting changes: each problem that must be fixed before a human reviews, with file and line where possible" },
            attachments: { type: "array", items: { type: "string" }, description: `Optional: images in your workspace (at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB each) that show a visible problem or confirm a visible change. One per scenario; leave out when nothing visible is involved.` },
          },
          required: ["verdict", "summary"],
          additionalProperties: false,
        },
        skipPermission: true,
        handler: wrap("tracker_submit_review", (args: ReviewArgs) => this.submitReview(context, review, args)),
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
          await this.setStatus(context.issue, allowed);
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
    const created: any = await this.graphql(
      `mutation($repo: ID!, $title: String!, $body: String!, $labels: [ID!]) { createIssue(input: { repositoryId: $repo, title: $title, body: $body, labelIds: $labels }) { issue { id number url } } }`,
      { repo: repo.id, title, body, labels: labelIds },
    );
    const issue = created?.createIssue?.issue;
    if (!issue?.id) throw new TrackerError("tracker_response", "createIssue returned no issue");
    filed.count++;
    const meta = await this.projectMeta();
    const added: any = await this.graphql(
      `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
      { project: meta.projectId, content: issue.id },
    );
    const itemId = added?.addProjectV2ItemById?.item?.id;
    const warnings: string[] = [];
    if (itemId && f.state) await this.setOption(itemId, meta.statusFieldId, meta.statusOptions, f.state).catch((e: Error) => warnings.push(e.message));
    if (itemId && f.priority) {
      if (meta.priorityFieldId) await this.setOption(itemId, meta.priorityFieldId, meta.priorityOptions, f.priority).catch((e: Error) => warnings.push(e.message));
      else warnings.push(`priority field "${this.settings.priorityField}" is not a single-select field`);
    }
    for (const warning of warnings) context.log.warn("follow-up board update failed", { issue: issue.url, error: warning });
    context.log.info("follow-up issue created", { issue: issue.url });
    return { issue_url: issue.url, number: issue.number, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  private async submitReview(context: AgentToolContext, review: ReviewToolContext, args: ReviewArgs): Promise<unknown> {
    const { issue } = context;
    if (args.verdict !== "approve" && args.verdict !== "request_changes") return { failure: 'verdict must be "approve" or "request_changes"' };
    if (typeof args.summary !== "string" || args.summary.trim() === "") return { failure: "summary must be a non-empty string" };
    const blocking = args.blocking_issues ?? [];
    if (!Array.isArray(blocking) || !blocking.every((b) => typeof b === "string" && b.trim() !== "")) return { failure: "blocking_issues must be a list of non-empty strings" };
    if (args.verdict === "request_changes" && blocking.length === 0) return { failure: "list the blocking issues when requesting changes" };
    if (args.verdict === "approve" && blocking.length > 0) return { failure: "an approval cannot have blocking issues; request changes, or move them to the summary as suggestions" };
    const attachments = readAttachments(context.workspacePath, args.attachments);
    if ("failure" in attachments) return attachments;
    const branch = issue.branchName ?? "";
    const found: any = await this.graphql(
      `query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $branch, states: [OPEN], first: 1) { nodes { id number url } } } }`,
      { owner: this.settings.repoOwner, name: this.settings.repoName, branch },
    );
    const pr = found?.repository?.pullRequests?.nodes?.[0];
    if (!pr) return { failure: `there is no open pull request for ${branch} to review` };

    let images = "";
    if (attachments.files.length > 0) {
      try {
        images = (await this.uploadEvidence(issue, attachments.files)).map((u) => `![${u.name}](${u.url})`).join("\n");
      } catch (error) {
        images = `_Screenshots could not be attached: ${truncate((error as Error).message, 300)}_`;
      }
    }
    const lastRound = review.round >= review.maxRounds;
    const escalate = args.verdict === "request_changes" && lastRound;
    const next = args.verdict === "approve" || escalate ? review.passState : review.failState;
    const outcome = args.verdict === "approve" ? "approved"
      : escalate ? `changes requested; that was the last round, so a human decides` : "changes requested";
    const body = [
      `**AI review · round ${review.round} of ${review.maxRounds} · ${outcome}**`,
      args.summary,
      blocking.length > 0 ? `**Blocking issues**\n\n${blocking.map((b, i) => `${i + 1}. ${b}`).join("\n")}` : "",
      images,
    ].filter(Boolean).join("\n\n");
    // GitHub does not let the PR's author approve or request changes, so the verdict lives in the card state.
    const posted: any = await this.graphql(
      `mutation($pr: ID!, $body: String!) { addPullRequestReview(input: { pullRequestId: $pr, event: COMMENT, body: $body }) { pullRequestReview { url } } }`,
      { pr: pr.id, body },
    );
    const reviewUrl = posted?.addPullRequestReview?.pullRequestReview?.url ?? pr.url;
    await this.addComment(this.issueNodeId(issue), `${body}\n\n[Review on PR #${pr.number}](${reviewUrl})`);
    await this.setStatus(issue, next);
    review.onVerdict(args.verdict);
    context.log.info("review submitted", { verdict: args.verdict, round: review.round, status: next, pull_request: pr.url });
    return { verdict: args.verdict, status: next, pull_request: pr.url, round: review.round };
  }

  private issueNodeId(issue: Issue): string {
    const id = issue.nativeRef?.issue_id;
    if (typeof id !== "string") throw new TrackerError("tracker_response", `issue ${issue.identifier} has no issue node id`);
    return id;
  }

  private async issueContext(issue: Issue): Promise<unknown> {
    const query = `query($id: ID!, $owner: String!, $name: String!, $branch: String!) {
      issue: node(id: $id) { ... on Issue { number title body state url
        labels(first: 50) { nodes { name } }
        comments(last: 30) { nodes { author { login } body createdAt } } } }
      repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $branch, states: [OPEN], first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes {
          number url title mergeable baseRefName
          reviews(last: 20) { nodes { author { login } state body submittedAt } }
          reviewThreads(first: 50) { nodes { isResolved path line comments(first: 20) { nodes { author { login } body } } } }
          comments(last: 20) { nodes { author { login } body createdAt } }
        } } } }`;
    const data: any = await this.graphql(query, {
      id: this.issueNodeId(issue), owner: this.settings.repoOwner, name: this.settings.repoName, branch: issue.branchName ?? "",
    });
    const [fresh] = await this.fetchIssuesByIds([issue.id]);
    const text = (value: unknown, max: number) => (typeof value === "string" ? truncate(value, max) : null);
    const pr = data?.repository?.pullRequests?.nodes?.[0] ?? null;
    return {
      identifier: issue.identifier,
      status: fresh?.state ?? null,
      title: data?.issue?.title ?? issue.title,
      url: data?.issue?.url ?? issue.url,
      body: text(data?.issue?.body, 8000),
      labels: (data?.issue?.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean),
      comments: (data?.issue?.comments?.nodes ?? []).map((c: any) => ({ author: c?.author?.login ?? null, at: c?.createdAt, body: text(c?.body, 2000) })),
      pull_request: pr && {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        mergeable: pr.mergeable ?? null,
        base_branch: pr.baseRefName ?? null,
        reviews: (pr.reviews?.nodes ?? []).map((r: any) => ({ author: r?.author?.login ?? null, state: r?.state, body: text(r?.body, 2000) })),
        review_threads: (pr.reviewThreads?.nodes ?? []).map((t: any) => ({
          resolved: t?.isResolved, path: t?.path, line: t?.line,
          comments: (t?.comments?.nodes ?? []).map((c: any) => ({ author: c?.author?.login ?? null, body: text(c?.body, 2000) })),
        })),
        comments: (pr.comments?.nodes ?? []).map((c: any) => ({ author: c?.author?.login ?? null, at: c?.createdAt, body: text(c?.body, 2000) })),
      },
    };
  }

  private async addComment(subjectId: string, body: string): Promise<string | null> {
    const data: any = await this.graphql(
      `mutation($id: ID!, $body: String!) { addComment(input: { subjectId: $id, body: $body }) { commentEdge { node { url } } } }`,
      { id: subjectId, body },
    );
    return data?.addComment?.commentEdge?.node?.url ?? null;
  }

  private async setStatus(issue: Issue, statusName: string): Promise<void> {
    const meta = await this.projectMeta();
    await this.setOption(issue.id, meta.statusFieldId, meta.statusOptions, statusName);
  }

  private async setOption(itemId: string, fieldId: string, options: Array<{ id: string; name: string }>, optionName: string): Promise<void> {
    const meta = await this.projectMeta();
    const option = options.find((o) => normalizeState(o.name) === normalizeState(optionName));
    if (!option) throw new TrackerError("invalid_tracker_config", `"${optionName}" is not an option of that project field`);
    await this.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
      { project: meta.projectId, item: itemId, field: fieldId, option: option.id },
    );
  }

  private async submitForReview(context: AgentToolContext, args: { title: string; summary: string; attachments?: string[] }): Promise<unknown> {
    const { issue, workspacePath } = context;
    if (typeof args.title !== "string" || args.title.trim() === "") return { failure: "title must be a non-empty string" };
    if (typeof args.summary !== "string" || args.summary.trim() === "") return { failure: "summary must be a non-empty string" };
    const branch = issue.branchName;
    if (!branch) return { failure: "issue has no branch name" };
    const attachments = readAttachments(workspacePath, args.attachments);
    if ("failure" in attachments) return attachments;
    const git = (gitArgs: string[]) => run("git", gitArgs, { cwd: workspacePath, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => r.stdout.trim());

    const dirty = await git(["status", "--porcelain"]);
    if (dirty) return { failure: `the workspace has uncommitted changes; commit them first:\n${truncate(dirty, 1500)}` };
    const repo = await this.repository();
    await git(["fetch", "--quiet", "origin", repo.defaultBranch]);
    const ahead = Number(await git(["rev-list", "--count", `origin/${repo.defaultBranch}..HEAD`]));
    if (!ahead) return { failure: `HEAD has no commits beyond origin/${repo.defaultBranch}; nothing to review` };
    const conflicts = await conflictingFiles(workspacePath, `origin/${repo.defaultBranch}`, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
    if (conflicts.length > 0) {
      return { failure: `HEAD conflicts with origin/${repo.defaultBranch} in: ${truncate(conflicts.join(", "), 1000)}. Run \`git merge origin/${repo.defaultBranch}\`, resolve the conflicts keeping the intent of both sides, rerun the checks, commit, and submit again.` };
    }
    try {
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    } catch (error) {
      const detail = error instanceof ExecError ? error.stderr : (error as Error).message;
      return { failure: `git push to ${branch} failed (if the branch was rewritten, rebase onto the remote branch instead of force-pushing):\n${truncate(detail, 1500)}` };
    }

    const number = issue.nativeRef?.issue_number;
    let images = "";
    let imageNote = "";
    if (attachments.files.length > 0) {
      try {
        const uploaded = await this.uploadEvidence(issue, attachments.files);
        images = uploaded.map((u) => `![${u.name}](${u.url})`).join("\n");
      } catch (error) {
        imageNote = `_Screenshots could not be attached: ${truncate((error as Error).message, 300)}_`;
        context.log.warn("attachment upload failed", { error: (error as Error).message });
      }
    }
    const body = [args.summary, images, imageNote].filter(Boolean).join("\n\n");
    const found: any = await this.graphql(
      `query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $branch, states: [OPEN], first: 1) { nodes { id number url } } } }`,
      { owner: this.settings.repoOwner, name: this.settings.repoName, branch },
    );
    let prUrl: string | null;
    let prNumber: number | null;
    const existing = found?.repository?.pullRequests?.nodes?.[0];
    if (existing) {
      await this.addComment(existing.id, `**Updated for review**\n\n${body}`);
      prUrl = existing.url;
      prNumber = existing.number ?? null;
    } else {
      const created: any = await this.graphql(
        `mutation($repo: ID!, $base: String!, $head: String!, $title: String!, $body: String!) {
          createPullRequest(input: { repositoryId: $repo, baseRefName: $base, headRefName: $head, title: $title, body: $body }) { pullRequest { number url } } }`,
        { repo: repo.id, base: repo.defaultBranch, head: branch, title: args.title, body: `${body}\n\nCloses #${number}` },
      );
      prUrl = created?.createPullRequest?.pullRequest?.url ?? null;
      prNumber = created?.createPullRequest?.pullRequest?.number ?? null;
    }
    const link = prUrl ? `[PR #${prNumber ?? "?"}](${prUrl})` : "the pull request";
    await this.addComment(this.issueNodeId(issue), `**Submitted for review** (${existing ? "updated" : "new"} ${link})\n\n${body}`);
    if (this.settings.handoffState) await this.setStatus(issue, this.settings.handoffState);
    context.log.info("submitted for review", { pull_request: prUrl, branch, commits: ahead, attachments: attachments.files.length });
    return { pull_request: prUrl, branch, commits_ahead_of_base: ahead, attachments: attachments.files.length, status: this.settings.handoffState ?? issue.state };
  }

  /** Commits images to the evidence branch and returns links that render for people with repository access. */
  async uploadEvidence(issue: Issue, files: Attachment[]): Promise<Array<{ name: string; url: string }>> {
    const repoPath = `/repos/${this.settings.repoOwner}/${this.settings.repoName}`;
    const ref = `heads/${this.settings.evidenceBranch}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const paths = files.map((f, i) => `${issue.identifier}/${stamp}-${i + 1}-${f.name}`);
    const blobs: string[] = [];
    for (const file of files) {
      const blob: any = await this.rest("POST", `${repoPath}/git/blobs`, { content: file.data.toString("base64"), encoding: "base64" });
      blobs.push(blob.sha);
    }
    for (let attempt = 0; ; attempt++) {
      const head: any = await this.rest("GET", `${repoPath}/git/ref/${ref}`, undefined, true);
      const parent: string | null = head?.object?.sha ?? null;
      const baseTree: string | undefined = parent ? (await this.rest("GET", `${repoPath}/git/commits/${parent}`) as any).tree.sha : undefined;
      const tree: any = await this.rest("POST", `${repoPath}/git/trees`, {
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: paths.map((path, i) => ({ path, mode: "100644", type: "blob", sha: blobs[i] })),
      });
      const commit: any = await this.rest("POST", `${repoPath}/git/commits`, {
        message: `evidence: ${issue.identifier}`, tree: tree.sha, parents: parent ? [parent] : [],
      });
      try {
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
