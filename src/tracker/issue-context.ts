import type { Issue } from "../types.ts";
import { TrackerError } from "./types.ts";

export const CONTEXT_PAGE_SIZE = 5;
export const CONTEXT_SECTIONS = ["overview", "issue_comments", "reviews", "review_threads", "thread_comments", "pull_request_comments"] as const;
type Section = typeof CONTEXT_SECTIONS[number];

interface ContextRequest {
  section: Section;
  cursor?: string;
  thread_id?: string;
}

interface ContextSource {
  issue: Issue;
  issueId: string;
  repoOwner: string;
  repoName: string;
  graphql: (query: string, variables: Record<string, unknown>) => Promise<any>;
  readStatus: () => Promise<string | null>;
}

interface Page {
  total_count: number | null;
  has_more: boolean;
  next: ContextRequest | null;
}

const COMMENT_FIELDS = "id url author { login } body createdAt";
const REVIEW_FIELDS = "id url author { login } state body submittedAt commit { oid }";
const BACKWARD_PAGE = "totalCount pageInfo { hasPreviousPage startCursor }";
const FORWARD_PAGE = "totalCount pageInfo { hasNextPage endCursor }";
const THREAD_FIELDS = `id isResolved isOutdated path line comments(first: ${CONTEXT_PAGE_SIZE}) { ${FORWARD_PAGE} nodes { ${COMMENT_FIELDS} } }`;
const PR_FIELDS = "id number url title mergeable baseRefName headRefOid";

function parseRequest(raw: unknown): ContextRequest {
  if (raw === undefined) return { section: "overview" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("tracker_get_issue arguments must be an object");
  const args = raw as Record<string, unknown>;
  if (Object.keys(args).some((key) => !["section", "cursor", "thread_id"].includes(key))) throw new Error("unknown tracker_get_issue argument");
  const section = args.section ?? "overview";
  if (!CONTEXT_SECTIONS.includes(section as Section)) throw new Error("invalid context section");
  for (const key of ["cursor", "thread_id"] as const) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].trim() === "" || args[key].length > 2048)) {
      throw new Error(`${key} must be a non-empty string of at most 2048 characters`);
    }
  }
  if (section === "overview" && args.cursor !== undefined) throw new Error("use a paginated section with cursor, not overview");
  if ((section === "thread_comments") !== (args.thread_id !== undefined)) throw new Error("thread_id is required only for thread_comments");
  return { section: section as Section, cursor: args.cursor as string | undefined, thread_id: args.thread_id as string | undefined };
}

function page(connection: any, section: Section, cursor?: string, threadId?: string): Page {
  const forward = section === "review_threads" || section === "thread_comments";
  const hasMore = connection?.pageInfo?.[forward ? "hasNextPage" : "hasPreviousPage"];
  if (!Array.isArray(connection?.nodes) || typeof hasMore !== "boolean") {
    throw new TrackerError("tracker_response", `missing ${section} pagination metadata; context is incomplete`);
  }
  const nextCursor = connection.pageInfo[forward ? "endCursor" : "startCursor"];
  if (hasMore && (typeof nextCursor !== "string" || nextCursor === "" || nextCursor === cursor)) {
    throw new TrackerError("tracker_pagination", `${section} has more context without an advancing cursor`);
  }
  return {
    total_count: typeof connection.totalCount === "number" ? connection.totalCount : null,
    has_more: hasMore,
    next: hasMore ? { section, cursor: nextCursor, ...(threadId ? { thread_id: threadId } : {}) } : null,
  };
}

const nodes = (connection: any): any[] => connection.nodes.filter((node: unknown) => node !== null);
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

function comment(raw: any) {
  return { id: raw.id, url: raw.url, author: raw.author?.login ?? null, at: raw.createdAt, body: text(raw.body) };
}

function review(raw: any) {
  const body = text(raw.body);
  // Old Symphony reviews put blockers after a long summary. Keep that section independently visible,
  // as full Markdown, as well as the original body; never try to infer a verdict from GitHub COMMENT.
  const marker = body?.match(/^\*\*Blocking issues\*\*[\t ]*\r?$/m);
  return {
    id: raw.id, url: raw.url, author: raw.author?.login ?? null, at: raw.submittedAt,
    state: raw.state, commit: raw.commit?.oid ?? null,
    blocking_feedback: marker ? body!.slice(marker.index! + marker[0].length).trim() : null,
    body,
  };
}

function thread(raw: any) {
  const pagination = page(raw.comments, "thread_comments", undefined, raw.id);
  if (typeof raw.id !== "string" || raw.id === "") throw new TrackerError("tracker_response", "review thread is missing its id");
  return {
    id: raw.id, resolved: raw.isResolved, outdated: raw.isOutdated, path: raw.path, line: raw.line,
    comments: nodes(raw.comments).map(comment), pagination,
  };
}

/** Omit an exact mirrored review only when its full source is present in this same response. */
function mirroredReview(raw: any, reviews: ReturnType<typeof review>[]): boolean {
  if (typeof raw.body !== "string") return false;
  const link = raw.body.match(/\n\n\[Review on PR #\d+\]\(([^)]+)\)\s*$/);
  if (!link) return false;
  return reviews.some((r) => r.url === link[1] && r.author === (raw.author?.login ?? null)
    && r.body === raw.body.slice(0, link.index));
}

/** Bounded connection pages, unabridged text, and explicit continuation arguments, scoped to one card. */
export async function readIssueContext(source: ContextSource, rawArgs: unknown = {}): Promise<unknown> {
  const args = parseRequest(rawArgs);
  const overview = args.section === "overview";
  const window = `(last: ${CONTEXT_PAGE_SIZE}${overview ? "" : ", before: $cursor"})`;
  const issueComments = overview || args.section === "issue_comments" ? `comments${window} { ${BACKWARD_PAGE} nodes { ${COMMENT_FIELDS} } }` : "";
  const reviews = overview || args.section === "reviews" ? `reviews${window} { ${BACKWARD_PAGE} nodes { ${REVIEW_FIELDS} } }` : "";
  const prComments = overview || args.section === "pull_request_comments" ? `comments${window} { ${BACKWARD_PAGE} nodes { ${COMMENT_FIELDS} } }` : "";
  const threads = overview || args.section === "review_threads"
    ? `reviewThreads(first: ${CONTEXT_PAGE_SIZE}${overview ? "" : ", after: $cursor"}) { ${FORWARD_PAGE} nodes { ${THREAD_FIELDS} } }` : "";
  const threadComments = args.section === "thread_comments"
    ? `thread: node(id: $thread) { ... on PullRequestReviewThread { id pullRequest { id } comments(first: ${CONTEXT_PAGE_SIZE}, after: $cursor) { ${FORWARD_PAGE} nodes { ${COMMENT_FIELDS} } } } }` : "";
  const query = `query($id: ID!, $owner: String!, $name: String!, $branch: String!${overview ? "" : ", $cursor: String"}${args.thread_id ? ", $thread: ID!" : ""}) {
    issue: node(id: $id) { ... on Issue { id ${overview ? "number title body state url labels(first: 50) { nodes { name } }" : ""} ${issueComments} } }
    repository(owner: $owner, name: $name) {
      pullRequests(headRefName: $branch, states: [OPEN], first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ${PR_FIELDS} ${overview ? "body" : ""} ${reviews} ${prComments} ${threads} }
      }
    }
    ${threadComments}
  }`;
  const data = await source.graphql(query, {
    id: source.issueId, owner: source.repoOwner, name: source.repoName, branch: source.issue.branchName ?? "",
    ...(!overview ? { cursor: args.cursor ?? null } : {}), ...(args.thread_id ? { thread: args.thread_id } : {}),
  });
  if (data?.issue?.id !== source.issueId) throw new TrackerError("tracker_response", "current issue not accessible; context is incomplete");
  const pr = data?.repository?.pullRequests?.nodes?.[0] ?? null;
  if (!data.repository?.pullRequests) throw new TrackerError("tracker_response", "pull request lookup missing; context is incomplete");

  if (!overview) {
    let connection: any;
    if (args.section === "issue_comments") connection = data.issue.comments;
    else {
      if (!pr) throw new Error("no open pull request for the current issue's branch");
      if (args.section === "thread_comments") {
        if (data.thread?.id !== args.thread_id || data.thread?.pullRequest?.id !== pr.id) {
          throw new Error("review thread does not belong to the current issue's open pull request");
        }
        connection = data.thread.comments;
      } else connection = pr[args.section === "reviews" ? "reviews" : args.section === "review_threads" ? "reviewThreads" : "comments"];
    }
    const pagination = page(connection, args.section, args.cursor, args.thread_id);
    const map = args.section === "reviews" ? review : args.section === "review_threads" ? thread : comment;
    return { identifier: source.issue.identifier, section: args.section, text_truncated: false, items: nodes(connection).map((raw) => map(raw)), pagination };
  }

  const pagination = {
    issue_comments: page(data.issue.comments, "issue_comments"),
    ...(pr ? {
      reviews: page(pr.reviews, "reviews"),
      pull_request_comments: page(pr.comments, "pull_request_comments"),
      review_threads: page(pr.reviewThreads, "review_threads"),
    } : {}),
  };
  const fullReviews = pr ? nodes(pr.reviews).map(review) : [];
  const fullThreads = pr ? nodes(pr.reviewThreads).map(thread) : [];
  const issueNodes = nodes(data.issue.comments);
  const comments = issueNodes.filter((c) => !mirroredReview(c, fullReviews)).map(comment);
  return {
    identifier: source.issue.identifier, status: await source.readStatus(),
    title: data.issue.title, url: data.issue.url, body: text(data.issue.body), state: data.issue.state,
    labels: (data.issue.labels?.nodes ?? []).map((label: any) => label?.name).filter(Boolean),
    text_truncated: false,
    history_complete: Object.values(pagination).every((p) => !p.has_more) && fullThreads.every((t) => !t.pagination.has_more),
    pagination, mirrored_reviews_omitted: issueNodes.length - comments.length,
    comments,
    pull_request: pr && {
      number: pr.number, url: pr.url, title: pr.title, body: text(pr.body),
      mergeable: pr.mergeable ?? null, base_branch: pr.baseRefName ?? null, head_commit: pr.headRefOid ?? null,
      reviews: fullReviews, review_threads: fullThreads, comments: nodes(pr.comments).map(comment),
    },
  };
}