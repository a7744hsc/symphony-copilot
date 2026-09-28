import { defineTool, type Tool, type ToolResultObject } from "@github/copilot-sdk";
import { resolveEnvRef } from "../config.ts";
import { ExecError, run } from "../exec.ts";
import { truncate, type Logger } from "../log.ts";
import { normalizeState, type BlockerRef, type Issue } from "../types.ts";
import { TrackerError, type AgentToolContext, type TrackerAdapter } from "./types.ts";

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
}

const NO_STATUS = "No Status";

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
  };
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

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface ProjectMeta {
  projectId: string;
  statusFieldId: string;
  statusOptions: Array<{ id: string; name: string }>;
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
        description: "Read the current issue: live board status, body, labels, recent comments, and the open pull request for this issue's branch with its reviews and review threads. Use it at the start of a retry or rework.",
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
      defineTool("tracker_submit_for_review", {
        description: `Hand the work to a human: requires all changes committed in the workspace. Pushes HEAD to branch ${context.issue.branchName}, opens (or updates) the pull request that closes this issue${this.settings.handoffState ? `, and moves the card to "${this.settings.handoffState}"` : ""}. Do not push yourself.`,
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Pull request title" },
            summary: { type: "string", description: "Markdown: what changed, how it was verified (commands and results), and what still needs human or device verification" },
          },
          required: ["title", "summary"],
          additionalProperties: false,
        },
        skipPermission: true,
        handler: wrap("tracker_submit_for_review", (args: { title: string; summary: string }) => this.submitForReview(context, args)),
      }),
    ];
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
          number url title
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
    const option = meta.statusOptions.find((o) => normalizeState(o.name) === normalizeState(statusName));
    if (!option) throw new TrackerError("invalid_tracker_config", `status "${statusName}" is not an option of field ${this.settings.statusField}`);
    await this.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } } }`,
      { project: meta.projectId, item: issue.id, field: meta.statusFieldId, option: option.id },
    );
  }

  private async submitForReview(context: AgentToolContext, args: { title: string; summary: string }): Promise<unknown> {
    const { issue, workspacePath } = context;
    if (typeof args.title !== "string" || args.title.trim() === "") return { failure: "title must be a non-empty string" };
    if (typeof args.summary !== "string" || args.summary.trim() === "") return { failure: "summary must be a non-empty string" };
    const branch = issue.branchName;
    if (!branch) return { failure: "issue has no branch name" };
    const git = (gitArgs: string[]) => run("git", gitArgs, { cwd: workspacePath, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).then((r) => r.stdout.trim());

    const dirty = await git(["status", "--porcelain"]);
    if (dirty) return { failure: `the workspace has uncommitted changes; commit them first:\n${truncate(dirty, 1500)}` };
    const repo = await this.repository();
    await git(["fetch", "--quiet", "origin", repo.defaultBranch]);
    const ahead = Number(await git(["rev-list", "--count", `origin/${repo.defaultBranch}..HEAD`]));
    if (!ahead) return { failure: `HEAD has no commits beyond origin/${repo.defaultBranch}; nothing to review` };
    try {
      await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    } catch (error) {
      const detail = error instanceof ExecError ? error.stderr : (error as Error).message;
      return { failure: `git push to ${branch} failed (if the branch was rewritten, rebase onto the remote branch instead of force-pushing):\n${truncate(detail, 1500)}` };
    }

    const number = issue.nativeRef?.issue_number;
    const found: any = await this.graphql(
      `query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) {
        pullRequests(headRefName: $branch, states: [OPEN], first: 1) { nodes { id url } } } }`,
      { owner: this.settings.repoOwner, name: this.settings.repoName, branch },
    );
    let prUrl: string | null;
    const existing = found?.repository?.pullRequests?.nodes?.[0];
    if (existing) {
      await this.addComment(existing.id, `**Updated for review**\n\n${args.summary}`);
      prUrl = existing.url;
    } else {
      const created: any = await this.graphql(
        `mutation($repo: ID!, $base: String!, $head: String!, $title: String!, $body: String!) {
          createPullRequest(input: { repositoryId: $repo, baseRefName: $base, headRefName: $head, title: $title, body: $body }) { pullRequest { url } } }`,
        { repo: repo.id, base: repo.defaultBranch, head: branch, title: args.title, body: `${args.summary}\n\nCloses #${number}` },
      );
      prUrl = created?.createPullRequest?.pullRequest?.url ?? null;
    }
    if (this.settings.handoffState) await this.setStatus(issue, this.settings.handoffState);
    context.log.info("submitted for review", { pull_request: prUrl, branch, commits: ahead });
    return { pull_request: prUrl, branch, commits_ahead_of_base: ahead, status: this.settings.handoffState ?? issue.state };
  }

  // ---- plumbing ----

  private vars() {
    return { login: this.settings.owner, number: this.settings.projectNumber, statusField: this.settings.statusField, priorityField: this.settings.priorityField };
  }

  private projectMeta(): Promise<ProjectMeta> {
    this.meta ??= (async () => {
      const ownerField = this.settings.ownerType === "user" ? "user" : "organization";
      const data: any = await this.graphql(
        `query($login: String!, $number: Int!, $statusField: String!) { owner: ${ownerField}(login: $login) { projectV2(number: $number) {
          id field(name: $statusField) { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`,
        { login: this.settings.owner, number: this.settings.projectNumber, statusField: this.settings.statusField },
      );
      const project = data?.owner?.projectV2;
      if (!project?.id) throw new TrackerError("invalid_tracker_config", `project ${this.settings.owner}#${this.settings.projectNumber} not found or not accessible`);
      if (!project.field?.id) throw new TrackerError("invalid_tracker_config", `single-select field "${this.settings.statusField}" not found`);
      return { projectId: project.id, statusFieldId: project.field.id, statusOptions: project.field.options ?? [] };
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

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.settings.endpoint, {
        method: "POST",
        headers: { authorization: `bearer ${this.settings.token}`, "content-type": "application/json", "user-agent": "symphony-copilot" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new TrackerError("tracker_request", (error as Error).message);
    }
    if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
      throw new TrackerError("tracker_rate_limited", `HTTP ${response.status}`);
    }
    if (!response.ok) throw new TrackerError("tracker_status", `HTTP ${response.status}`);
    let payload: { data?: unknown; errors?: Array<{ type?: string; message?: string }> };
    try {
      payload = await response.json() as typeof payload;
    } catch (error) {
      throw new TrackerError("tracker_response", `invalid JSON: ${(error as Error).message}`);
    }
    if (payload.errors?.length) {
      const limited = payload.errors.some((e) => e.type === "RATE_LIMITED");
      throw new TrackerError(limited ? "tracker_rate_limited" : "tracker_response", payload.errors.map((e) => e.message).join("; "));
    }
    if (payload.data === undefined || payload.data === null) throw new TrackerError("tracker_response", "response without data");
    return payload.data;
  }
}
