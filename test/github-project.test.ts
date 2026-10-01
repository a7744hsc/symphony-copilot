import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { run } from "../src/exec.ts";
import { GitHubProjectTracker, MAX_ATTACHMENT_BYTES, conflictingFiles, normalizeItem, parseSettings, readAttachments, type RawItem } from "../src/tracker/github-project.ts";
import { TrackerError } from "../src/tracker/index.ts";
import type { AgentResult, IssueMessageRef, PendingHandoff } from "../src/iteration.ts";
import type { AgentControl } from "../src/tracker/types.ts";
import type { Issue } from "../src/types.ts";
import { quietLog } from "./helpers.ts";

const provider = { owner: "me", project_number: 1, repo: "me/app", status_field: "Status", priority_field: "优先级", start_state: "待开始", working_state: "进行中", blocked_state: "受阻" };
const env = { SYMPHONY_GITHUB_TOKEN: "t0ken" };
const settings = parseSettings(provider, env);

function item(overrides: Partial<RawItem> = {}, content: Record<string, unknown> = {}): RawItem {
  return {
    __typename: "ProjectV2Item",
    id: "PVTI_1",
    isArchived: false,
    project: { id: "PVT_1" },
    status: { name: "待开始" },
    priority: { name: "P2" },
    content: {
      __typename: "Issue", id: "I_1", number: 12, title: "Title", body: "Body", url: "https://github.com/me/app/issues/12", state: "OPEN",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
      repository: { nameWithOwner: "me/app" },
      assignees: { nodes: [{ login: "me" }] },
      labels: { nodes: [{ name: " Agent " }, { name: "agent" }, { name: "" }, null] },
      blockedBy: { nodes: [] },
      ...content,
    },
    ...overrides,
  };
}

test("settings require a token and a well-formed repo", () => {
  assert.throws(() => parseSettings(provider, {}), (e: TrackerError) => e.category === "missing_tracker_secret");
  assert.throws(() => parseSettings({ ...provider, repo: "app" }, env), (e: TrackerError) => e.category === "invalid_tracker_config");
  assert.throws(() => parseSettings({ ...provider, project_number: "x" }, env), (e: TrackerError) => e.category === "invalid_tracker_config");
  assert.equal(settings.token, "t0ken");
  assert.equal(settings.tokenEnvName, "SYMPHONY_GITHUB_TOKEN");
});

test("project items normalize into issues", () => {
  const result = normalizeItem(item(), settings);
  assert.equal(result.kind, "issue");
  if (result.kind !== "issue") return;
  const issue = result.issue;
  assert.equal(issue.id, "PVTI_1");
  assert.equal(issue.identifier, "GH-12");
  assert.equal(issue.state, "待开始");
  assert.equal(issue.contentState, "OPEN");
  assert.equal(issue.priority, 2);
  assert.equal(issue.branchName, "agent/12");
  assert.deepEqual(issue.labels, ["agent"]);
  assert.equal(issue.assigneeId, "me");
  assert.equal(issue.dispatchable, true);
  assert.deepEqual(issue.nativeRef, { project_item_id: "PVTI_1", issue_id: "I_1", issue_number: 12, repository: "me/app" });
  assert.equal(issue.createdAt?.toISOString(), "2026-09-01T00:00:00.000Z");
});

test("open blockers, closed issues and archived items are not dispatchable", () => {
  const blocked = normalizeItem(item({}, { blockedBy: { nodes: [{ id: "I_2", number: 3, state: "OPEN", repository: { nameWithOwner: "me/app" } }] } }), settings);
  assert.ok(blocked.kind === "issue" && !blocked.issue.dispatchable);
  assert.ok(blocked.kind === "issue" && blocked.issue.blockedBy[0]?.identifier === "GH-3");
  const unblocked = normalizeItem(item({}, { blockedBy: { nodes: [{ id: "I_2", number: 3, state: "CLOSED" }] } }), settings);
  assert.ok(unblocked.kind === "issue" && unblocked.issue.dispatchable);
  const closed = normalizeItem(item({}, { state: "CLOSED" }), settings);
  assert.ok(closed.kind === "issue" && !closed.issue.dispatchable);
  assert.equal(closed.issue.contentState, "CLOSED");
  assert.equal(closed.issue.state, "待开始", "native closure is independent of the board column");
  const archived = normalizeItem(item({ isArchived: true }), settings);
  assert.ok(archived.kind === "issue" && !archived.issue.dispatchable);
});

test("unusable optional values fall back; scope and required fields are enforced", () => {
  const loose = normalizeItem(item({ status: null, priority: { name: "High" } }, { body: "", createdAt: "not a date", assignees: undefined }), settings);
  assert.ok(loose.kind === "issue");
  if (loose.kind === "issue") {
    assert.equal(loose.issue.state, "No Status");
    assert.equal(loose.issue.priority, null);
    assert.equal(loose.issue.description, null);
    assert.equal(loose.issue.createdAt, null);
    assert.equal(loose.issue.assigneeId, null);
  }
  assert.equal(normalizeItem(item({}, { __typename: "PullRequest" }), settings).kind, "out_of_scope");
  assert.equal(normalizeItem(item({}, { repository: { nameWithOwner: "other/repo" } }), settings).kind, "out_of_scope");
  assert.equal(normalizeItem(item({}, { title: "" }), settings).kind, "malformed");
  assert.equal(normalizeItem(item({}, { state: undefined }), settings).kind, "malformed");
  assert.equal(normalizeItem(item({}, { state: "UNKNOWN" }), settings).kind, "malformed");
  assert.equal(normalizeItem(item({ id: "" }), settings).kind, "malformed");
});

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const impl = async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const next = responses.shift();
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

test("empty state or id lists make no request", async () => {
  const { impl, calls } = fakeFetch([]);
  const tracker = new GitHubProjectTracker(provider, env, quietLog, impl);
  assert.deepEqual(await tracker.fetchIssuesByStates([]), []);
  assert.deepEqual(await tracker.fetchIssuesByIds([]), []);
  assert.equal(calls.length, 0);
});

test("state fetch paginates, filters by state, and omits malformed items", async () => {
  const page = (nodes: RawItem[], hasNextPage: boolean, endCursor: string | null) =>
    ({ data: { owner: { projectV2: { items: { pageInfo: { hasNextPage, endCursor }, nodes } } } } });
  const { impl, calls } = fakeFetch([
    page([item({ id: "A" }, { number: 1 }), item({ id: "B", status: { name: "已完成" } }, { number: 2 })], true, "c1"),
    page([item({ id: "C" }, { number: 3, title: "" }), item({ id: "D", status: { name: "进行中" } }, { number: 4 })], false, null),
  ]);
  const tracker = new GitHubProjectTracker(provider, env, quietLog, impl);
  const issues = await tracker.fetchIssuesByStates(["待开始", "进行中"]);
  assert.deepEqual(issues.map((i) => i.identifier), ["GH-1", "GH-4"]);
  assert.equal(calls[1]?.variables.after, "c1");
});

test("id refresh omits other projects and fails on malformed requested items", async () => {
  const meta = { data: { owner: { projectV2: { id: "PVT_1", field: { id: "F", options: [] } } } } };
  const { impl } = fakeFetch([meta, { data: { nodes: [item({ id: "A" }), item({ id: "B", project: { id: "PVT_other" } }), null] } }]);
  const tracker = new GitHubProjectTracker(provider, env, quietLog, impl);
  assert.deepEqual((await tracker.fetchIssuesByIds(["A", "B", "Z"])).map((i) => i.id), ["A"]);

  const bad = fakeFetch([meta, { data: { nodes: [item({ id: "A" }, { title: "" })] } }]);
  await assert.rejects(new GitHubProjectTracker(provider, env, quietLog, bad.impl).fetchIssuesByIds(["A"]), (e: TrackerError) => e.category === "tracker_response");
});

test("transport, status and GraphQL errors map to portable categories", async () => {
  const check = async (response: unknown, category: string) => {
    const { impl } = fakeFetch([response]);
    await assert.rejects(new GitHubProjectTracker(provider, env, quietLog, impl).fetchIssuesByStates(["待开始"]), (e: TrackerError) => e.category === category);
  };
  await check(new Response("oops", { status: 502 }), "tracker_status");
  await check(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), "tracker_rate_limited");
  await check({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }, "tracker_rate_limited");
  await check({ errors: [{ message: "bad field" }] }, "tracker_response");
  await check({ data: { owner: { projectV2: null } } }, "invalid_tracker_config");
  await check({ data: { owner: { projectV2: { items: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } } } }, "tracker_pagination");
  const failing = new GitHubProjectTracker(provider, env, quietLog, async () => { throw new Error("ECONNRESET"); });
  await assert.rejects(failing.fetchIssuesByStates(["待开始"]), (e: TrackerError) => e.category === "tracker_request");
});

test("secret names include the configured token variable", () => {
  const tracker = new GitHubProjectTracker({ ...provider, token: "$MY_TOKEN" }, { MY_TOKEN: "x" }, quietLog, async () => new Response());
  assert.ok(tracker.secretEnvironmentNames().includes("MY_TOKEN"));
  assert.ok(tracker.secretEnvironmentNames().includes("GH_TOKEN"));
});

test("agent tools are scoped to one issue and status changes are limited", () => {
  const withStates = new GitHubProjectTracker({ ...provider, agent_states: ["进行中", "受阻"] }, env, quietLog, async () => new Response());
  const without = new GitHubProjectTracker(provider, env, quietLog, async () => new Response());
  const ctx = { issue: (normalizeItem(item(), settings) as { issue: any }).issue, workspacePath: "/tmp", log: quietLog };
  assert.deepEqual(withStates.agentTools(ctx).map((t) => t.name).sort(), ["tracker_comment", "tracker_get_issue", "tracker_set_status", "tracker_submit_for_review"]);
  assert.ok(!without.agentTools(ctx).some((t) => t.name === "tracker_set_status"));
});

test("tracker_get_issue passes pagination arguments through its permission-scoped tool", async () => {
  const body = "Summary ".repeat(400) + "\n\n**Blocking issues**\n\n1. Entire final blocker";
  const { impl, calls } = fakeFetch([{ data: {
    issue: { id: "I_1" }, repository: { pullRequests: { nodes: [{ id: "PR_1", reviews: {
      nodes: [{ id: "R_1", body, state: "COMMENT", author: { login: "me" } }],
      pageInfo: { hasPreviousPage: false, startCursor: null }, totalCount: 1,
    } }] } },
  } }]);
  const tracker = new GitHubProjectTracker(provider, env, quietLog, impl);
  const ctx = { issue: (normalizeItem(item(), settings) as { issue: any }).issue, workspacePath: "/tmp", log: quietLog };
  const tool = tracker.agentTools(ctx).find((t) => t.name === "tracker_get_issue")!;
  const result: any = await tool.handler!({ section: "reviews", cursor: "older" }, {} as any);
  assert.equal(result.items[0].body, body);
  assert.equal(result.items[0].blocking_feedback, "1. Entire final blocker");
  assert.equal(calls[0]!.variables.cursor, "older");
  assert.equal(calls[0]!.variables.branch, "agent/12");
  const failure: any = await tool.handler!({ section: "reviews", issue_id: "foreign" }, {} as any);
  assert.equal(failure.resultType, "failure");
  assert.match(failure.textResultForLlm, /unknown tracker_get_issue argument/);
  assert.equal(calls.length, 1);
});

test("attachments must be images inside the workspace and under the size limit", () => {
  const ws = mkdtempSync(join(tmpdir(), "attach-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "attach-out-"));
  writeFileSync(join(ws, "a.png"), "png");
  writeFileSync(join(ws, "notes.txt"), "text");
  writeFileSync(join(ws, "big.png"), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  writeFileSync(join(outside, "secret.png"), "png");
  symlinkSync(join(outside, "secret.png"), join(ws, "link.png"));

  assert.deepEqual(readAttachments(ws, undefined), { files: [] });
  const ok = readAttachments(ws, ["a.png", join(ws, "a.png")]);
  assert.ok("files" in ok && ok.files.length === 2 && ok.files[0]!.name === "a.png" && ok.files[0]!.data.toString() === "png");
  const failure = (paths: unknown) => { const r = readAttachments(ws, paths); return "failure" in r ? r.failure : null; };
  assert.match(failure([join(outside, "secret.png")]) ?? "", /outside the workspace/);
  assert.match(failure(["link.png"]) ?? "", /outside the workspace/);
  assert.match(failure(["notes.txt"]) ?? "", /not a PNG/);
  assert.match(failure(["missing.png"]) ?? "", /does not exist/);
  assert.match(failure(["big.png"]) ?? "", /larger than 5 MB/);
  assert.match(failure("a.png") ?? "", /list of file paths/);
});

function restFetch(handler: (method: string, path: string, body: any) => unknown) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const impl = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const result = handler(method, path, body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

test("evidence goes to its own branch and links point at the exact commit", async () => {
  const issue = (normalizeItem(item(), settings) as { issue: any }).issue;
  const files = [{ name: "before after.png", data: Buffer.from("img") }];

  const first = restFetch((method, path) => {
    if (path.endsWith("/git/blobs")) return { sha: "b1" };
    if (method === "GET" && path.endsWith("/git/ref/heads/symphony-evidence")) return new Response("", { status: 404 });
    if (path.endsWith("/git/trees")) return { sha: "t1" };
    if (path.endsWith("/git/commits")) return { sha: "c1" };
    if (method === "POST" && path.endsWith("/git/refs")) return { ref: "refs/heads/symphony-evidence" };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const [link] = await new GitHubProjectTracker(provider, env, quietLog, first.impl).uploadEvidence(issue, files);
  assert.equal(first.calls[0]!.body.content, Buffer.from("img").toString("base64"));
  assert.equal(first.calls.find((c) => c.path.endsWith("/git/trees"))!.body.base_tree, undefined);
  assert.deepEqual(first.calls.find((c) => c.path.endsWith("/git/commits"))!.body.parents, []);
  assert.match(link!.url, /^https:\/\/github\.com\/me\/app\/blob\/c1\/GH-12\/\d{8}T\d{6}-1-before%20after\.png\?raw=true$/);

  const next = restFetch((method, path) => {
    if (path.endsWith("/git/blobs")) return { sha: "b2" };
    if (method === "GET" && path.endsWith("/git/ref/heads/symphony-evidence")) return { object: { sha: "p1" } };
    if (method === "GET" && path.endsWith("/git/commits/p1")) return { tree: { sha: "pt" } };
    if (path.endsWith("/git/trees")) return { sha: "t2" };
    if (path.endsWith("/git/commits")) return { sha: "c2" };
    if (method === "PATCH" && path.endsWith("/git/refs/heads/symphony-evidence")) return { object: { sha: "c2" } };
    throw new Error(`unexpected ${method} ${path}`);
  });
  await new GitHubProjectTracker(provider, env, quietLog, next.impl).uploadEvidence(issue, files);
  assert.equal(next.calls.find((c) => c.path.endsWith("/git/trees"))!.body.base_tree, "pt");
  assert.deepEqual(next.calls.find((c) => c.method === "PATCH")!.body, { sha: "c2", force: false });
});

/** Stateful fake API records server effects before optional response loss. Never contacts GitHub. */
function publicationFetch() {
  const calls: Array<{ query: string; variables: Record<string, any> }> = [];
  const comments = new Map<string, { id: string; url: string; body: string; issue?: { id: string }; commit?: { oid: string } }>();
  const prComments: string[] = [], reviews: string[] = [];
  let nextComment = 1;
  const state = {
    status: "AI Review", open: true, itemId: "PVTI_1", pr: { id: "PR_1", number: 10, url: "https://github.com/me/app/pull/10", headRefOid: "head1", body: "" } as null | { id: string; number: number; url: string; headRefOid: string; body: string },
    fail: "", lose: "", after: undefined as undefined | ((q: string) => void), pageSize: 100,
  };
  const connection = (nodes: unknown[], after: unknown) => {
    const offset = Number(after ?? 0), page = nodes.slice(offset, offset + state.pageSize);
    const hasNextPage = offset + page.length < nodes.length;
    return { nodes: page, pageInfo: { hasNextPage, endCursor: hasNextPage ? String(offset + page.length) : null } };
  };
  const impl = async (_url: string, init: RequestInit) => {
    const { query: q, variables: v } = JSON.parse(String(init.body));
    calls.push({ query: q, variables: v });
    if (state.fail && q.includes(state.fail)) { state.fail = ""; throw new Error("injected request failure"); }
    let data: any;
    if (q.includes("projectV2(number")) data = { owner: { projectV2: { id: "PVT_1", field: { id: "F", options: ["AI Review", "进行中", "返工", "待验证", "受阻"].map((name) => ({ id: name, name })) } } } };
    else if (q.includes("projectItems(first")) data = { node: { id: "I_1", state: state.open ? "OPEN" : "CLOSED", repository: { nameWithOwner: "me/app" }, projectItems: connection([item({ id: state.itemId, status: { name: state.status } }, { state: state.open ? "OPEN" : "CLOSED" })], v.after) } };
    else if (q.includes("pullRequests(headRefName")) data = { repository: { pullRequests: { nodes: state.pr ? [state.pr] : [] } } };
    else if (q.includes("defaultBranchRef")) data = { repository: { id: "R_1", defaultBranchRef: { name: "main" } } };
    else if (q.includes("updateIssueComment")) {
      const comment = comments.get(v.id);
      assert.ok(comment); comment.body = v.body;
      data = { updateIssueComment: { issueComment: { id: v.id } } };
    } else if (q.includes("addComment") || q.includes("addPullRequestReview")) {
      const id = `C_${nextComment++}`, review = q.includes("addPullRequestReview");
      const node = { id, url: `https://github.com/me/app/issues/12#${id}`, body: v.body,
        ...(review ? { commit: { oid: v.head } } : v.id === "I_1" ? { issue: { id: "I_1" } } : {}) };
      comments.set(id, node);
      if (review) reviews.push(id); else if (v.id !== "I_1") prComments.push(id);
      data = review ? { addPullRequestReview: { pullRequestReview: node } } : { addComment: { commentEdge: { node } } };
    } else if (q.includes("createPullRequest")) {
      state.pr = { id: "PR_1", number: 10, url: "https://github.com/me/app/pull/10", headRefOid: "head1", body: v.body };
      data = { createPullRequest: { pullRequest: state.pr } };
    } else if (q.includes("updateProjectV2ItemFieldValue")) {
      assert.equal(v.item, state.itemId); state.status = v.option;
      data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: v.item } } };
    } else if (q.includes("... on IssueComment")) data = { node: comments.get(v.id) ?? null };
    else if (q.includes("reviews(first")) data = { node: { id: v.id, reviews: connection(reviews.map((id) => comments.get(id)), v.after) } };
    else if (q.includes("comments(first")) data = { node: { id: v.id, comments: connection(v.id === "I_1" ? [...comments.values()].filter((c) => c.issue?.id === "I_1") : prComments.map((id) => comments.get(id)), v.after) } };
    else throw new Error(`unexpected query: ${q}`);
    state.after?.(q);
    if (state.lose && q.includes(state.lose)) { state.lose = ""; throw new Error("injected response loss"); }
    return new Response(JSON.stringify({ data }));
  };
  return { impl, calls, comments, prComments, reviews, state };
}

function fakeControl(sourceState = "AI Review", targetState = "返工", initialReview = true) {
  const saved = { pending: null as PendingHandoff | null, accepted: false, finishes: [] as boolean[], refs: [] as IssueMessageRef[], checkpoints: 0, active: true };
  const control: AgentControl = {
    id: "invocation-1", initialReview, async onSessionCreated() { return 1; },
    assertActive() { if (!saved.active) throw new Error("inactive invocation"); }, accepted: () => saved.accepted,
    async accept(result: AgentResult, workspacePath: string) {
      control.assertActive(); assert.equal(saved.accepted, false); saved.accepted = true;
      return saved.pending = { id: "result-1", invocationId: control.id, sourceState, targetState, workspacePath, result: structuredClone(result),
        issueMessage: null, pr: null, prPublished: false, pushed: false, statusApplied: false, stale: false,
        haltReason: targetState === "受阻" ? "human_required" : null, nextNoProgress: 0, reworkId: null, waitingState: null };
    },
    checkpoint() { saved.checkpoints++; assert.ok(!saved.pending?.prPublished || saved.pending.pr); },
    finish(stale = false) { saved.finishes.push(stale); }, onIssueMessage(ref) { saved.refs.push(ref); },
  };
  return { control, saved };
}

function publicationSetup(options: { review?: boolean; initialReview?: boolean; target?: string; round?: number; workspacePath?: string; localHead?: string | Error } = {}) {
  const api = publicationFetch();
  const review = options.review !== false;
  api.state.status = review ? "AI Review" : "进行中";
  const host = fakeControl(api.state.status, options.target ?? "返工", options.initialReview ?? true);
  const tracker = new GitHubProjectTracker({ ...provider, agent_states: ["进行中", "受阻"], handoff_state: "AI Review" }, env, quietLog, api.impl);
  const workspacePath = options.workspacePath ?? "/nonexistent/review-checkout";
  if (review) {
    const localHead = options.localHead ?? "head1";
    Object.assign(tracker, { git: async (cwd: string, args: string[]) => {
      assert.equal(cwd, workspacePath);
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      if (localHead instanceof Error) throw localHead;
      return localHead;
    } });
  }
  const issue = (normalizeItem(item({ status: { name: api.state.status } }), settings) as { issue: Issue }).issue;
  const tools = tracker.agentTools({ issue, workspacePath, log: quietLog, control: host.control,
    ...(review ? { review: { round: options.round ?? 1, passState: "待验证", failState: "返工" } } : {}) });
  return { ...api, ...host, tracker, issue, tools,
    call: (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.handler!(args, {} as any) as Promise<any>,
    resume: () => tracker.publishHandoff(issue, host.saved.pending!, () => host.control.checkpoint(), () => host.control.assertActive()),
  };
}

const changes = { verdict: "request_changes", reviewed_head: "head1", progress: "initial", progress_reason: "Initial independent verification.", next_action: "continue", next_step: "Reproduce and fix the counterexample.", summary: "Checked A01-A03.", blocking_issues: ["Full blocker and evidence."] };
const approval = { ...changes, verdict: "approve", blocking_issues: [], next_action: null, next_step: null };

test("review protocol publishes the complete issue record FIRST and binds the mirrored review to its checked SHA", async () => {
  const s = publicationSetup();
  const result = await s.call("tracker_submit_review", { ...changes, summary: "evidence ".repeat(2000) + "FINAL EVIDENCE" });
  assert.equal(result.status, "返工");
  assert.deepEqual(s.tools.map((t) => t.name).sort(), ["tracker_comment", "tracker_get_issue", "tracker_submit_review"]);
  const issueCall = s.calls.findIndex((c) => c.query.includes("addComment") && c.variables.id === "I_1");
  const reviewCall = s.calls.findIndex((c) => c.query.includes("addPullRequestReview"));
  assert.ok(issueCall < reviewCall);
  assert.match(s.calls[issueCall]!.variables.body, /FINAL EVIDENCE[\s\S]*Full blocker and evidence/);
  assert.match(s.calls[issueCall]!.variables.body, /Publication pending/);
  assert.match(s.calls[reviewCall]!.query, /commitOID: \$head, event: COMMENT/);
  assert.equal(s.calls[reviewCall]!.variables.head, "head1");
  assert.deepEqual(s.saved.finishes, [false]);
  assert.match(s.comments.get(s.saved.pending!.issueMessage!.id)!.body, /Handoff completed: 返工/);
});

test("review number does not decide policy; even a later no-progress result uses the host's persisted target", async () => {
  const s = publicationSetup({ round: 12, initialReview: false });
  assert.equal((await s.call("tracker_submit_review", { ...changes, progress: "no_progress" })).status, "返工");
  assert.equal(s.saved.pending!.result.kind, "review");
  assert.ok(!s.calls.some((c) => String(c.variables.body).includes("last round")));
});

test("invalid and contradictory review results have no API or acceptance effects", async () => {
  for (const args of [{ ...approval, blocking_issues: ["x"] }, { ...changes, blocking_issues: [] }, { ...changes, verdict: "maybe" },
    { ...changes, reviewed_head: null }, { ...changes, next_step: "" }, { ...changes, progress: "no_progress" },
    { ...approval, next_action: "human_required" }, { ...changes, progress_reason: "" }]) {
    const s = publicationSetup();
    const result = await s.call("tracker_submit_review", args);
    assert.equal(result.resultType, "failure");
    assert.equal(s.saved.accepted, false); assert.equal(s.calls.length, 0);
  }
  const s = publicationSetup(); s.state.pr = null;
  assert.match((await s.call("tracker_submit_review", approval)).textResultForLlm, /no open pull request/);
  assert.equal(s.saved.accepted, false);
});

for (const args of [approval, changes]) {
  test(`quality review ${args.verdict} rejects a missing repository before acceptance or API mutation`, async (t) => {
    const s = publicationSetup({ localHead: new Error("fatal: not a git repository") });
    const git = t.mock.method(s.tracker as any, "git");
    const result = await s.call("tracker_submit_review", args);
    assert.equal(result.resultType, "failure");
    assert.match(result.textResultForLlm, /not a git repository/);
    assert.equal(git.mock.callCount(), 1);
    assert.equal(s.saved.accepted, false); assert.equal(s.saved.pending, null);
    assert.equal(s.saved.checkpoints, 0); assert.deepEqual(s.saved.finishes, []);
    assert.ok(!s.calls.some((c) => /^\s*mutation\b/.test(c.query)));
    assert.equal(s.comments.size, 0); assert.equal(s.reviews.length, 0);
    assert.equal(s.state.status, "AI Review");
  });
}

test("reviewer unable_to_verify needs no repository, PR or SHA and exits to Blocked with full source evidence", async (t) => {
  const s = publicationSetup({ target: "受阻", localHead: new Error("fatal: not a git repository") }); s.state.pr = null;
  const git = t.mock.method(s.tracker as any, "git");
  const args = { ...changes, verdict: "unable_to_verify", reviewed_head: null, progress: "not_assessed", next_action: "human_required", next_step: "Grant repository access", summary: "Tried lookup; access denied", blocking_issues: [] };
  assert.equal((await s.call("tracker_submit_review", args)).status, "受阻");
  assert.equal(git.mock.callCount(), 0);
  assert.ok(!s.calls.some((c) => /pullRequests|addPullRequestReview/.test(c.query)));
  assert.equal(s.saved.pending!.prPublished, false);
  assert.equal(s.saved.pending!.pr, null);
  assert.match([...s.comments.values()][0]!.body, /Tried lookup; access denied[\s\S]*Grant repository access/);
});

for (const lost of ["addComment", "addPullRequestReview", "updateProjectV2ItemFieldValue", "updateIssueComment"]) {
  test(`core resume after ${lost} response loss does not duplicate results or redo semantic acceptance`, async () => {
    const s = publicationSetup({ target: "待验证" }); s.state.lose = lost;
    const result = await s.call("tracker_submit_review", approval);
    assert.equal(result.resultType, "failure");
    assert.equal(s.saved.accepted, true); assert.deepEqual(s.saved.finishes, []);
    const pending = structuredClone(s.saved.pending!);
    // A new adapter represents a process restart; no tool-local state is reused.
    const restarted = new GitHubProjectTracker(provider, env, quietLog, s.impl);
    assert.deepEqual(await restarted.publishHandoff(s.issue, pending, () => {}, () => {}), { stale: false });
    assert.equal([...s.comments.values()].filter((c) => c.issue).length, 1);
    assert.equal(s.reviews.length, 1);
    assert.equal(s.state.status, "待验证");
    assert.match(s.comments.get(pending.issueMessage!.id)!.body, /Handoff completed/);
    assert.equal(s.calls.filter((c) => c.query.includes("updateProjectV2ItemFieldValue")).length, 1);
    assert.deepEqual(await restarted.publishHandoff(s.issue, pending, () => {}, () => {}), { stale: false });
    assert.equal(s.reviews.length, 1);
  });
}

test("canonical issue record survives a PR publication failure and response-loss lookup pages full marker bodies", async () => {
  const s = publicationSetup(); s.state.fail = "addPullRequestReview";
  assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
  const record = s.comments.get(s.saved.pending!.issueMessage!.id)!;
  assert.match(record.body, /Full blocker and evidence/);
  assert.match(record.body, /Reproduce and fix the counterexample/);
  assert.equal(s.state.status, "AI Review");
  // Lose the local message reference as if addComment's response had been lost on a prior process.
  s.saved.pending!.issueMessage = null;
  s.comments.delete(record.id);
  for (let i = 0; i < 3; i++) s.comments.set(`human-${i}`, { id: `human-${i}`, url: "human", body: "x".repeat(6000), issue: { id: "I_1" } });
  record.body = "human preface ".repeat(1000) + record.body;
  s.comments.set(record.id, record); s.state.pageSize = 1;
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.calls.filter((c) => c.query.includes("addComment") && c.variables.id === "I_1").length, 1);
  assert.ok(s.calls.some((c) => c.query.includes("comments(first") && c.variables.after === "3"));
});

for (const damage of ["deleted", "result-removed", "invocation-removed", "duplicate-result", "duplicate-invocation", "status-removed", "foreign-issue"]) {
  test(`persisted ${damage} issue result is replaced with full evidence before PR publication and status`, async () => {
    const s = publicationSetup(); s.state.fail = "addPullRequestReview";
    assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
    const p = structuredClone(s.saved.pending!), old = s.comments.get(p.issueMessage!.id)!;
    const oldId = old.id;
    if (damage === "deleted") s.comments.delete(oldId);
    if (damage === "result-removed") old.body = old.body.replace("<!-- symphony-result:result-1 -->", "Human replacement marker");
    if (damage === "invocation-removed") old.body = old.body.replace("<!-- symphony-invocation:invocation-1 -->", "Human replacement marker");
    if (damage === "duplicate-result") old.body += "\n<!-- symphony-result:result-1 -->";
    if (damage === "duplicate-invocation") old.body += "\n<!-- symphony-invocation:invocation-1 -->";
    if (damage === "status-removed") old.body = old.body.replace("<!-- symphony-handoff:result-1:end -->", "Human replacement marker");
    if (damage === "foreign-issue") old.issue = { id: "I_other" };
    const preserved = old.body, start = s.calls.length, refs: Array<string | undefined> = [];
    const restarted = new GitHubProjectTracker(provider, env, quietLog, s.impl);
    assert.deepEqual(await restarted.publishHandoff(s.issue, p, () => refs.push(p.issueMessage?.id), () => {}), { stale: false });
    assert.notEqual(p.issueMessage!.id, oldId);
    assert.ok(refs.includes(p.issueMessage!.id), "the replacement reference is checkpointed");
    const body = s.comments.get(p.issueMessage!.id)!.body;
    for (const text of [changes.summary, changes.progress_reason, changes.next_step, changes.blocking_issues[0]!, "Reviewed HEAD: head1", "Handoff completed: 返工"])
      assert.ok(body.includes(text), `missing full issue evidence: ${text}`);
    assert.equal(old.body, preserved, "never rewrite the human-edited/foreign comment");
    const calls = s.calls.slice(start);
    const created = calls.findIndex((c) => c.query.includes("addComment") && c.variables.id === "I_1");
    assert.ok(created >= 0 && created < calls.findIndex((c) => c.query.includes("addPullRequestReview")));
    assert.ok(created < calls.findIndex((c) => c.query.includes("updateProjectV2ItemFieldValue")));
    assert.ok(!calls.some((c) => c.query.includes("updateIssueComment") && c.variables.id === oldId));
    assert.equal(s.state.status, "返工");
  });
}

test("inconsistent canonical node identity fails closed until the response can be reconciled", async () => {
  const s = publicationSetup(); s.state.fail = "addPullRequestReview";
  await s.call("tracker_submit_review", changes);
  const p = s.saved.pending!, ref = p.issueMessage!, node = s.comments.get(ref.id)!;
  node.id = "unexpected-node";
  await assert.rejects(s.resume(), /canonical issue result unavailable/);
  assert.equal(p.statusApplied, false); assert.equal(s.state.status, "AI Review");
  assert.deepEqual(s.saved.finishes, []); assert.equal(s.reviews.length, 0);
  node.id = ref.id;
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(p.issueMessage!.id, ref.id);
  assert.equal([...s.comments.values()].filter((c) => c.issue).length, 1);
});

test("a damaged persisted reference recovers an existing canonical marker on the same issue without duplication", async () => {
  const s = publicationSetup(); s.state.fail = "addPullRequestReview";
  await s.call("tracker_submit_review", changes);
  const p = s.saved.pending!, old = s.comments.get(p.issueMessage!.id)!;
  const canonical = { ...old, id: "recovered", url: "recovered-url" };
  old.body = "Human replaced the original comment.";
  s.comments.set("foreign", { ...canonical, id: "foreign", issue: { id: "I_other" } });
  s.comments.set(canonical.id, canonical); s.state.pageSize = 1;
  assert.deepEqual(await s.resume(), { stale: false });
  assert.deepEqual(p.issueMessage, { id: canonical.id, url: canonical.url });
  assert.equal(old.body, "Human replaced the original comment.");
  assert.equal(s.calls.filter((c) => c.query.includes("addComment") && c.variables.id === "I_1").length, 1);
});

for (const failure of ["... on IssueComment", "comments(first", "addComment"]) {
  test(`canonical replacement ${failure} failure leaves the accepted handoff pending without status`, async () => {
    const s = publicationSetup(); s.state.fail = "addPullRequestReview";
    await s.call("tracker_submit_review", changes);
    const p = s.saved.pending!, ref = p.issueMessage!;
    s.comments.delete(ref.id); s.state.fail = failure;
    await assert.rejects(s.resume(), /injected request failure/);
    assert.equal(s.saved.pending, p); assert.deepEqual(s.saved.finishes, []);
    assert.equal(p.statusApplied, false); assert.equal(p.stale, false);
    assert.equal(p.prPublished, false); assert.equal(s.reviews.length, 0);
    assert.equal(s.state.status, "AI Review");
    assert.ok(!s.calls.some((c) => c.query.includes("updateProjectV2ItemFieldValue")));
    assert.deepEqual(await s.resume(), { stale: false });
    assert.notEqual(p.issueMessage!.id, ref.id);
    assert.equal(s.reviews.length, 1); assert.equal(s.state.status, "返工");
  });
}

for (const phase of ["PR lookup", "PR publication", "status publication"]) {
  test(`canonical issue result is rechecked after ${phase}; human edits outside the host block survive`, async () => {
    const s = publicationSetup();
    let damaged: { id: string; body: string } | undefined;
    s.state.after = (q) => {
      const ref = s.saved.pending?.issueMessage;
      const trigger = phase === "PR lookup" ? "pullRequests(headRefName" : phase === "PR publication" ? "addPullRequestReview" : "updateProjectV2ItemFieldValue";
      if (!damaged && ref && q.includes(trigger)) {
        const node = s.comments.get(ref.id)!;
        node.body = "Human replacement during publication.";
        damaged = { id: ref.id, body: node.body };
      }
    };
    assert.equal((await s.call("tracker_submit_review", changes)).status, "返工");
    assert.ok(damaged);
    const p = s.saved.pending!;
    assert.notEqual(p.issueMessage!.id, damaged.id);
    assert.equal(s.comments.get(damaged.id)!.body, damaged.body);
    assert.match(s.comments.get(p.issueMessage!.id)!.body, /Full blocker and evidence[\s\S]*Handoff completed/);
    const creation = s.calls.findLastIndex((c) => c.query.includes("addComment") && c.variables.id === "I_1");
    const boundary = phase === "PR lookup" ? "addPullRequestReview" : "updateProjectV2ItemFieldValue";
    if (phase !== "status publication") assert.ok(creation >= 0 && creation < s.calls.findIndex((c) => c.query.includes(boundary)));
  });
}

test("canonical read failure after PR publication blocks status; finalization read failure also remains pending", async () => {
  for (const phase of ["addPullRequestReview", "updateProjectV2ItemFieldValue"]) {
    const s = publicationSetup();
    s.state.after = (q) => { if (q.includes(phase)) s.state.fail = "... on IssueComment"; };
    assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
    assert.deepEqual(s.saved.finishes, []);
    assert.equal(s.saved.pending!.prPublished, true);
    assert.equal(s.saved.pending!.statusApplied, phase === "updateProjectV2ItemFieldValue");
    assert.equal(s.state.status, phase === "updateProjectV2ItemFieldValue" ? "返工" : "AI Review");
    s.state.after = undefined;
    assert.deepEqual(await s.resume(), { stale: false });
    assert.equal(s.reviews.length, 1);
    assert.equal(s.calls.filter((c) => c.query.includes("updateProjectV2ItemFieldValue")).length, 1);
  }
});

test("replacement creation failure after PR publication leaves status pending and retries without another review", async () => {
  const s = publicationSetup();
  s.state.after = (q) => {
    if (q.includes("addPullRequestReview")) {
      s.comments.delete(s.saved.pending!.issueMessage!.id);
      s.state.fail = "addComment";
    }
  };
  assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
  assert.equal(s.saved.pending!.statusApplied, false); assert.equal(s.saved.pending!.prPublished, true);
  assert.equal(s.state.status, "AI Review"); assert.deepEqual(s.saved.finishes, []);
  s.state.after = undefined;
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.reviews.length, 1); assert.equal(s.state.status, "返工");
  assert.match(s.comments.get(s.saved.pending!.issueMessage!.id)!.body, /Full blocker and evidence[\s\S]*Handoff completed/);
});

test("a lost status response with a deleted canonical comment is repaired in the target column without replaying status", async () => {
  const s = publicationSetup(); s.state.lose = "updateProjectV2ItemFieldValue";
  assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
  const p = s.saved.pending!, oldId = p.issueMessage!.id;
  assert.equal(s.state.status, "返工"); assert.equal(p.statusApplied, false);
  s.comments.delete(oldId); s.state.fail = "addComment";
  await assert.rejects(s.resume(), /injected request failure/);
  assert.equal(p.stale, false); assert.deepEqual(s.saved.finishes, []);
  assert.deepEqual(await s.resume(), { stale: false });
  assert.notEqual(p.issueMessage!.id, oldId); assert.equal(p.statusApplied, true);
  assert.equal(s.calls.filter((c) => c.query.includes("updateProjectV2ItemFieldValue")).length, 1);
  assert.equal(s.reviews.length, 1);
});

test("handoff finalization edits only its host status block and does not require the cosmetic usage block", async () => {
  const s = publicationSetup(); s.state.fail = "addPullRequestReview";
  await s.call("tracker_submit_review", changes);
  const ref = s.saved.pending!.issueMessage!, node = s.comments.get(ref.id)!;
  node.body = `Human preface\n${node.body.replace(/<!-- symphony-usage:[\s\S]*?<!-- symphony-usage:invocation-1:end -->/, "Human replacement footer")}\nHuman afterword`;
  const stripStatus = (body: string) => body.replace(/<!-- symphony-handoff:result-1:start -->[\s\S]*?<!-- symphony-handoff:result-1:end -->/, "HOST STATUS");
  const preserved = stripStatus(node.body);
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.saved.pending!.issueMessage!.id, ref.id);
  assert.equal(stripStatus(node.body), preserved);
  assert.equal([...s.comments.values()].filter((c) => c.issue).length, 1);
});

test("incomplete result pagination fails closed instead of assuming a marker is absent", async (t) => {
  const s = publicationSetup(), original = (s.tracker as any).graphql.bind(s.tracker);
  t.mock.method(s.tracker as any, "graphql", async (q: string, v: Record<string, unknown>) => {
    const data = await original(q, v);
    if (q.includes("comments(first")) data.node.comments.pageInfo = {};
    return data;
  });
  assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
  assert.equal(s.saved.accepted, true); assert.equal(s.comments.size, 0);
  assert.equal(s.saved.pending!.issueMessage, null);
});

test("an unconfirmed status response cannot set statusApplied; resume reconciles the actual remote target", async (t) => {
  const s = publicationSetup(), original = (s.tracker as any).graphql.bind(s.tracker);
  t.mock.method(s.tracker as any, "graphql", async (q: string, v: Record<string, unknown>) => {
    const data = await original(q, v);
    return q.includes("updateProjectV2ItemFieldValue") ? { updateProjectV2ItemFieldValue: null } : data;
  });
  assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
  assert.equal(s.saved.pending!.statusApplied, false); assert.equal(s.state.status, "返工");
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.saved.pending!.statusApplied, true);
  assert.equal(s.calls.filter((c) => c.query.includes("updateProjectV2ItemFieldValue")).length, 1);
});

test("acceptance immediately disables direct mutations while read-only tool calls remain available", async () => {
  const s = publicationSetup(); s.state.fail = "addPullRequestReview";
  await s.call("tracker_submit_review", changes);
  const before = s.calls.length;
  assert.match((await s.call("tracker_submit_review", changes)).textResultForLlm, /already been accepted/);
  assert.match((await s.call("tracker_comment", { body: "late mutation" })).textResultForLlm, /already been accepted/);
  assert.equal(s.calls.length, before);
  // An invalid read selector reaches the reader's validation, rather than the accepted-mutation guard.
  assert.match((await s.call("tracker_get_issue", { section: "invalid" })).textResultForLlm, /section/);
});

test("quality review rejects a mismatched head before acceptance", async () => {
  const s = publicationSetup(); s.state.pr!.headRefOid = "new-head";
  assert.match((await s.call("tracker_submit_review", approval)).textResultForLlm, /current PR head/);
  assert.equal(s.saved.accepted, false); assert.equal(s.comments.size, 0);
});

for (const phase of ["accepted", "mirrored", "resume"]) {
  test(`head changed at ${phase}: retain source evidence, cancel target/status and do not settle progress`, async () => {
    const s = publicationSetup({ target: "待验证" });
    if (phase === "accepted") {
      const accept = s.control.accept;
      s.control.accept = async (...args) => { const p = await accept(...args); s.state.pr!.headRefOid = "head2"; return p; };
    } else if (phase === "mirrored") s.state.after = (q) => { if (q.includes("addPullRequestReview")) s.state.pr!.headRefOid = "head2"; };
    else s.state.fail = "addPullRequestReview";
    const result = await s.call("tracker_submit_review", approval);
    if (phase === "resume") {
      assert.equal(result.resultType, "failure"); s.state.pr!.headRefOid = "head2";
      assert.deepEqual(await s.resume(), { stale: true });
    } else assert.equal(result.stale, true);
    assert.equal(s.state.status, "AI Review"); assert.equal(s.saved.pending!.statusApplied, false);
    assert.ok(!s.calls.some((c) => c.query.includes("updateProjectV2ItemFieldValue")));
    const body = s.comments.get(s.saved.pending!.issueMessage!.id)!.body;
    assert.match(body, /Reviewed HEAD: head1/); assert.match(body, /Stale result: source evidence only/);
    assert.ok(s.saved.finishes.every(Boolean));
  });
}

test("stale-head source evidence is still recoverable if its initial publication fails", async () => {
  const s = publicationSetup(); const accept = s.control.accept;
  s.control.accept = async (...args) => { const p = await accept(...args); s.state.pr!.headRefOid = "head2"; return p; };
  s.state.fail = "addComment";
  assert.equal((await s.call("tracker_submit_review", changes)).resultType, "failure");
  assert.equal(s.saved.pending!.stale, true); assert.equal(s.comments.size, 0);
  assert.deepEqual(await s.resume(), { stale: true });
  assert.equal(s.comments.size, 1); assert.equal(s.state.status, "AI Review");
});

for (const remote of ["closed", "Done", "Rework", "待验证"]) {
  test(`pending publication does not overwrite unexpected remote ${remote}`, async () => {
    const s = publicationSetup({ target: "待验证" });
    const accept = s.control.accept;
    s.control.accept = async (...args) => {
      const p = await accept(...args);
      if (remote === "closed") s.state.open = false; else s.state.status = remote;
      return p;
    };
    assert.equal((await s.call("tracker_submit_review", approval)).stale, true);
    assert.equal(s.comments.size, 0); assert.equal(s.saved.pending!.statusApplied, false);
    assert.deepEqual(s.saved.finishes, [true]);
  });
}

test("native closure during canonical validation prevents the remaining PR and board publications", async () => {
  const s = publicationSetup();
  let mirrorLookup = false;
  s.state.after = (q) => {
    if (q.includes("reviews(first")) mirrorLookup = true;
    if (mirrorLookup && q.includes("... on IssueComment")) s.state.open = false;
  };
  assert.equal((await s.call("tracker_submit_review", changes)).stale, true);
  assert.equal(s.reviews.length, 0); assert.equal(s.saved.pending!.statusApplied, false);
  assert.equal(s.state.status, "AI Review");
  assert.ok(!s.calls.some((c) => c.query.includes("updateProjectV2ItemFieldValue")));
});

test("publication refreshes the project item from native issue identity", async () => {
  const s = publicationSetup(); s.state.itemId = "PVTI_readded";
  assert.equal((await s.call("tracker_submit_review", changes)).status, "返工");
  assert.equal(s.calls.find((c) => c.query.includes("updateProjectV2ItemFieldValue"))!.variables.item, "PVTI_readded");
});

test("planning/progress comments cannot become a blocking handoff without an explicit blocking reason", async () => {
  const s = publicationSetup({ review: false, target: "受阻" });
  for (const body of ["## Implementation plan\nInvestigate and verify before coding.", "Progress: checked the existing code."]) {
    const plan = await s.call("tracker_comment", { body });
    const savedBody = s.comments.get(plan.comment_id)!.body;
    assert.match((await s.call("tracker_set_status", { status: "受阻" })).textResultForLlm, /blocking=true/);
    assert.equal(s.saved.accepted, false);
    assert.equal(s.saved.pending, null);
    assert.equal(s.comments.get(plan.comment_id)!.body, savedBody, "never upgrade a plan/progress note to a blocker");
    assert.ok(!s.calls.some((c) => c.query.includes("updateProjectV2ItemFieldValue")));
  }
  const before = s.calls.length;
  assert.equal((await s.call("tracker_comment", { body: "Need access", blocking: "true" })).resultType, "failure");
  assert.equal(s.calls.length, before, "invalid flags cannot publish or enable a blocking handoff");
  await s.call("tracker_comment", { body: "Previously needed access.", blocking: true });
  await s.call("tracker_comment", { body: "Access restored; continue the plan.", blocking: false });
  assert.match((await s.call("tracker_set_status", { status: "受阻" })).textResultForLlm, /blocking=true/);
  assert.equal(s.saved.accepted, false, "a later progress note must clear the previous comment's blocking flag");
});

test("blocked handoff requires this invocation's explicit blocking comment and upgrades that exact message without duplication", async () => {
  const s = publicationSetup({ review: false, target: "受阻" });
  assert.match((await s.call("tracker_set_status", { status: "受阻" })).textResultForLlm, /tracker_comment/);
  assert.equal(s.saved.accepted, false);
  const plan = await s.call("tracker_comment", { body: "## Implementation plan\nVerify credentials before repair." });
  const planBody = s.comments.get(plan.comment_id)!.body;
  const posted = await s.call("tracker_comment", { body: "Tried the allowed repair. Need credentials from a human.", blocking: true });
  s.comments.set("human", { id: "human", url: "human", body: "unrelated latest comment", issue: { id: "I_1" } });
  assert.equal((await s.call("tracker_set_status", { status: "受阻" })).status, "受阻");
  assert.equal(s.saved.pending!.issueMessage!.id, posted.comment_id);
  assert.equal(s.comments.size, 3);
  assert.equal(s.comments.get(plan.comment_id)!.body, planBody);
  assert.match(s.comments.get(posted.comment_id)!.body, /symphony-result:result-1/);
  assert.equal(s.comments.get("human")!.body, "unrelated latest comment");
  assert.equal(s.saved.pending!.result.summary, "Tried the allowed repair. Need credentials from a human.");
});

test("blocked comment upgrade response loss is reconciled without duplicating the semantic message", async () => {
  const s = publicationSetup({ review: false, target: "受阻" });
  await s.call("tracker_comment", { body: "Need access; attempts and requested action recorded here.", blocking: true });
  s.state.lose = "updateIssueComment";
  assert.equal((await s.call("tracker_set_status", { status: "受阻" })).resultType, "failure");
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.comments.size, 1); assert.equal(s.state.status, "受阻");
});

test("handoff without control and mutations by an inactive invocation fail closed", async () => {
  const s = publicationSetup({ review: false });
  s.saved.active = false;
  assert.match((await s.call("tracker_set_status", { status: "进行中" })).textResultForLlm, /inactive/);
  assert.equal(s.calls.length, 0);
  const tools = s.tracker.agentTools({ issue: s.issue, workspacePath: "/tmp", log: quietLog });
  const result: any = await tools.find((t) => t.name === "tracker_submit_for_review")!.handler!({ title: "x", summary: "x" }, {} as any);
  assert.match(result.textResultForLlm, /requires an invocation control/);
});

test("revocation during an awaited board lookup prevents ordinary status mutation", async () => {
  const s = publicationSetup({ review: false });
  s.state.after = (q) => { if (q.includes("projectV2(number")) s.saved.active = false; };
  assert.match((await s.call("tracker_set_status", { status: "进行中" })).textResultForLlm, /inactive/);
  assert.ok(!s.calls.some((c) => c.query.includes("updateProjectV2ItemFieldValue")));
});

test("state changes during marker pagination cancel the issue write, not just the final status", async () => {
  const s = publicationSetup();
  s.state.after = (q) => { if (q.includes("comments(first")) s.state.status = "Done"; };
  assert.equal((await s.call("tracker_submit_review", changes)).stale, true);
  assert.equal(s.comments.size, 0); assert.equal(s.reviews.length, 0);
});

test("blocked upgrade does not rewrite the prior comment after an unexpected remote transition", async () => {
  const s = publicationSetup({ review: false, target: "受阻" });
  const ref = await s.call("tracker_comment", { body: "Need human input.", blocking: true });
  const body = s.comments.get(ref.comment_id)!.body;
  s.state.status = "Done";
  assert.equal((await s.call("tracker_set_status", { status: "受阻" })).stale, true);
  assert.equal(s.comments.get(ref.comment_id)!.body, body);
  assert.equal(s.comments.size, 1);
});

test("a human-edited blocking note is preserved and a separate complete result is used", async () => {
  const s = publicationSetup({ review: false, target: "受阻" });
  const ref = await s.call("tracker_comment", { body: "Need human input.", blocking: true });
  const original = s.comments.get(ref.comment_id)!; original.body += "\nHuman clarification";
  const body = original.body;
  assert.equal((await s.call("tracker_set_status", { status: "受阻" })).status, "受阻");
  assert.equal(original.body, body); assert.equal(s.comments.size, 2);
  assert.notEqual(s.saved.pending!.issueMessage!.id, ref.comment_id);
});

test("real checkout HEAD must match the claimed reviewed SHA", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-checkout-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".git"), "fixture");
  const s = publicationSetup({ workspacePath: root });
  t.mock.method(s.tracker as any, "git", async () => "different-local-head");
  assert.match((await s.call("tracker_submit_review", approval)).textResultForLlm, /local checkout HEAD/);
  assert.equal(s.saved.accepted, false); assert.equal(s.comments.size, 0);
});

test("the canonical issue reference is delivered before host finish can retire the invocation", async () => {
  const s = publicationSetup();
  s.control.finish = () => {
    assert.deepEqual(s.saved.refs, [s.saved.pending!.issueMessage]);
    s.saved.active = false;
  };
  assert.equal((await s.call("tracker_submit_review", changes)).status, "返工");
});

function mockImplementationGit(t: TestContext, s: ReturnType<typeof publicationSetup>, options: { dirty?: boolean; ahead?: string; failPush?: boolean } = {}) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  t.mock.method(s.tracker as any, "git", async (cwd: string, args: string[]) => {
    calls.push({ cwd, args });
    if (args[0] === "status") return options.dirty ? " M source.ts" : "";
    if (args[0] === "rev-parse") return "head1";
    if (args[0] === "rev-list") return options.ahead ?? "1";
    if (args[0] === "push") {
      if (options.failPush) { options.failPush = false; throw new Error("push failed"); }
      if (s.state.pr) s.state.pr.headRefOid = "head1";
    }
    return "";
  });
  return calls;
}

test("implementation validates locally before acceptance and accepts a genuine same-HEAD existing-PR handoff", async (t) => {
  const s = publicationSetup({ review: false, target: "AI Review" });
  const options = { dirty: true, ahead: "0" };
  const git = mockImplementationGit(t, s, options);
  assert.match((await s.call("tracker_submit_for_review", { title: "Repair", summary: "Tried a new approach; counterexample remains." })).textResultForLlm, /uncommitted/);
  assert.equal(s.saved.accepted, false); assert.equal(s.comments.size, 0);
  options.dirty = false;
  assert.equal((await s.call("tracker_submit_for_review", { title: "Repair", summary: "Tried a new approach; counterexample remains." })).status, "AI Review");
  assert.deepEqual(s.saved.pending!.result, { kind: "implement", head: "head1", title: "Repair", summary: "Tried a new approach; counterexample remains." });
  assert.ok(git.some((c) => c.args.join(" ") === "push --quiet origin head1:refs/heads/agent/12"));
  assert.ok(git.every((c) => c.cwd === s.saved.pending!.workspacePath));
  assert.ok(!git.some((c) => c.args.some((a) => a.includes("force"))));
});

test("failed push keeps a complete pending issue record; resume uses saved workspace/result and does not accept again", async (t) => {
  const s = publicationSetup({ review: false, target: "AI Review" });
  const git = mockImplementationGit(t, s, { failPush: true });
  assert.equal((await s.call("tracker_submit_for_review", { title: "Repair", summary: "Full tests and failed approaches." })).resultType, "failure");
  assert.equal(s.saved.accepted, true); assert.equal(s.saved.pending!.pushed, false);
  assert.match(s.comments.get(s.saved.pending!.issueMessage!.id)!.body, /Full tests and failed approaches[\s\S]*Publication pending/);
  assert.equal(s.state.status, "进行中");
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.comments.size, 2); assert.equal(s.prComments.length, 1);
  assert.equal(git.filter((c) => c.args[0] === "push").length, 2);
});

test("new PR create response loss resumes from stable branch and result marker without duplicate PR/comment", async (t) => {
  const s = publicationSetup({ review: false, target: "AI Review" });
  mockImplementationGit(t, s); s.state.pr = null; s.state.lose = "createPullRequest";
  assert.equal((await s.call("tracker_submit_for_review", { title: "Repair", summary: "Complete implementation evidence" })).resultType, "failure");
  assert.equal(s.saved.pending!.pushed, true); assert.equal(s.saved.pending!.prPublished, false);
  assert.equal(s.state.status, "进行中");
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.calls.filter((c) => c.query.includes("createPullRequest")).length, 1);
  assert.equal(s.prComments.length, 0); assert.equal(s.comments.size, 1);
});

test("existing-PR comment response loss is reconciled by marker, not mirrored a second time", async (t) => {
  const s = publicationSetup({ review: false, target: "AI Review" }); mockImplementationGit(t, s);
  s.state.after = (q) => {
    if (q.includes("addComment") && [...s.comments.values()].some((c) => c.issue) && !s.prComments.length) s.state.lose = "comments(first";
  };
  // First stop before the PR mirror, then lose that mirror's response on the resumed host path.
  await s.call("tracker_submit_for_review", { title: "Repair", summary: "Full result" });
  s.state.after = undefined; s.state.lose = "addComment";
  await assert.rejects(s.resume(), /response loss/);
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.prComments.length, 1); assert.equal(s.comments.size, 2);
});

async function delayedImplementation(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-30T00:00:00Z") });
  const s = publicationSetup({ review: false, target: "AI Review" });
  const result: AgentResult = { kind: "implement", title: "Repair", head: "head1",
    summary: `Full implementation criteria, checks and human constraints.\n${"Complete evidence. ".repeat(400)}\nEND IMPLEMENTATION EVIDENCE` };
  await s.control.accept(result, "/nonexistent/implementation-checkout");
  s.state.pr!.headRefOid = "head0";
  const gitCalls: string[][] = [], checkpoints: PendingHandoff[] = [];
  const git = async (cwd: string, args: string[]) => {
    assert.equal(cwd, s.saved.pending!.workspacePath);
    gitCalls.push(args);
    if (args[0] === "rev-parse") { assert.deepEqual(args, ["rev-parse", "HEAD"]); return "head1"; }
    if (args[0] === "status") { assert.deepEqual(args, ["status", "--porcelain"]); return ""; }
    assert.deepEqual(args, ["push", "--quiet", "origin", "head1:refs/heads/agent/12"]);
    assert.ok(s.saved.pending!.issueMessage, "full issue evidence must precede push");
    return ""; // Push succeeds; only GraphQL PR metadata is delayed. Never run real Git.
  };
  let tracker = s.tracker;
  Object.assign(tracker, { git });
  return { ...s, gitCalls, checkpoints, result,
    get pending() { return s.saved.pending!; },
    resume: () => tracker.publishHandoff(s.issue, s.saved.pending!, () => {
      s.control.checkpoint(); checkpoints.push(structuredClone(s.saved.pending!));
    }, () => s.control.assertActive()),
    restart() {
      s.saved.pending = structuredClone(s.saved.pending!);
      tracker = new GitHubProjectTracker({ ...provider, handoff_state: "AI Review" }, env, quietLog, s.impl);
      Object.assign(tracker, { git });
    },
  };
}

function mismatchError(expected: string, actual: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error, "a host retry must reject, not complete a stale handoff");
    assert.match(error.message, /expected/i);
    assert.match(error.message, /actual/i);
    assert.ok(error.message.includes(expected), "diagnostic must name the accepted SHA");
    assert.ok(error.message.includes(actual), "diagnostic must name the observed PR SHA");
    return true;
  };
}

function handoffStatus(body: string, p: PendingHandoff) {
  const start = `<!-- symphony-handoff:${p.id}:start -->`, end = `<!-- symphony-handoff:${p.id}:end -->`;
  assert.equal(body.split(`<!-- symphony-result:${p.id} -->`).length, 2);
  assert.equal(body.split(`<!-- symphony-invocation:${p.invocationId} -->`).length, 2);
  assert.equal(body.split(start).length, 2); assert.equal(body.split(end).length, 2);
  assert.ok(body.indexOf(start) < body.indexOf(end));
  return body.slice(body.indexOf(start) + start.length, body.indexOf(end));
}

test("implementation post-push metadata lag stays pending; immediate tool/host retries have no effects before 60 seconds", async (t) => {
  const s = await delayedImplementation(t), p = s.pending, now = Date.now();
  assert.equal(p.headMismatch, undefined, "legacy pending results need no retry field");
  await assert.rejects(s.resume(), mismatchError("head1", "head0"));
  assert.equal(s.saved.pending, p); assert.equal(p.stale, false); assert.equal(p.pushed, true);
  assert.equal(p.targetState, "AI Review"); assert.equal(p.statusApplied, false); assert.equal(p.haltReason, null);
  assert.deepEqual(p.headMismatch, { attempts: 1, actualHead: "head0", retryAt: now + 60_000 });
  assert.deepEqual(s.checkpoints.at(-1)!.headMismatch, p.headMismatch, "retry gate must be checkpointed before rejecting");
  const ref = p.issueMessage!, record = s.comments.get(ref.id)!;
  assert.ok(record.body.includes(s.result.summary));
  assert.match(handoffStatus(record.body, p), /Publication pending/);
  assert.doesNotMatch(record.body, /Stale result/);
  assert.equal(s.state.status, "进行中"); assert.deepEqual(s.saved.finishes, []);
  const effects = [s.calls.length, s.gitCalls.length, s.saved.checkpoints];
  assert.match((await s.call("tracker_submit_for_review", { title: s.result.title, summary: s.result.summary })).textResultForLlm, /already been accepted/);
  await assert.rejects(s.resume(), Error);
  t.mock.timers.tick(59_999);
  s.state.pr!.headRefOid = "head1"; // Even already-correct metadata must wait for the durable gate.
  await assert.rejects(s.resume(), Error);
  assert.deepEqual([s.calls.length, s.gitCalls.length, s.saved.checkpoints], effects, "no API, Git or checkpoint before retryAt");
  assert.deepEqual(p.headMismatch, { attempts: 1, actualHead: "head0", retryAt: now + 60_000 });
  t.mock.timers.tick(1);
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.saved.pending, p); assert.deepEqual(p.issueMessage, ref);
  assert.equal(s.state.status, "AI Review"); assert.equal(p.statusApplied, true); assert.equal(p.haltReason, null);
  assert.equal(s.gitCalls.filter((args) => args[0] === "push").length, 1);
  assert.equal([...s.comments.values()].filter((c) => c.issue).length, 1);
  assert.equal(s.prComments.length, 1); assert.equal(s.reviews.length, 0);
  assert.deepEqual(p.result, s.result);
  assert.match(handoffStatus(record.body, p), /Handoff completed: AI Review/);
});

test("three separated implementation head checks survive new adapters and halt in configured Blocked without semantic review", async (t) => {
  const s = await delayedImplementation(t), started = Date.now();
  s.pending.nextNoProgress = 1; s.pending.reworkId = "existing-rework";
  await assert.rejects(s.resume(), mismatchError("head1", "head0"));
  const ref = s.pending.issueMessage!, id = s.pending.id;
  const record = s.comments.get(ref.id)!;
  record.body = `Human preface\n${record.body}\nHuman afterword`;
  const outsideStatus = (body: string) => body.replace(/<!-- symphony-handoff:result-1:start -->[\s\S]*?<!-- symphony-handoff:result-1:end -->/, "HOST STATUS");
  const preserved = outsideStatus(record.body);
  s.restart();
  const before = [s.calls.length, s.gitCalls.length];
  await assert.rejects(s.resume(), Error);
  assert.deepEqual([s.calls.length, s.gitCalls.length], before, "fresh adapter honors persisted retryAt before even loading project metadata");
  assert.deepEqual(s.pending.headMismatch, { attempts: 1, actualHead: "head0", retryAt: started + 60_000 });
  t.mock.timers.tick(60_000);
  s.state.pr!.headRefOid = "head2"; // A different unexpected head does not restart the three-check allowance.
  await assert.rejects(s.resume(), mismatchError("head1", "head2"));
  assert.deepEqual(s.pending.headMismatch, { attempts: 2, actualHead: "head2", retryAt: started + 120_000 });
  assert.deepEqual(s.checkpoints.at(-1)!.headMismatch, s.pending.headMismatch);
  assert.equal(s.pending.stale, false); assert.equal(s.pending.targetState, "AI Review");
  assert.equal(s.pending.haltReason, null); assert.equal(s.pending.waitingState, null);
  s.restart();
  t.mock.timers.tick(59_999);
  const gated = [s.calls.length, s.gitCalls.length];
  await assert.rejects(s.resume(), Error);
  assert.deepEqual([s.calls.length, s.gitCalls.length], gated);
  assert.equal(s.pending.headMismatch!.attempts, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(await s.resume(), { stale: false });
  const p = s.pending;
  assert.equal(p.id, id); assert.deepEqual(p.issueMessage, ref); assert.deepEqual(p.result, s.result);
  assert.equal(p.headMismatch!.attempts, 3); assert.equal(p.headMismatch!.actualHead, "head2");
  assert.equal(p.stale, false); assert.equal(p.statusApplied, true);
  assert.equal(p.targetState, "受阻"); assert.equal(p.haltReason, "head_mismatch"); assert.equal(p.waitingState, "受阻");
  assert.equal(p.nextNoProgress, 1); assert.equal(p.reworkId, "existing-rework");
  assert.equal(s.state.status, "受阻"); assert.equal(s.reviews.length, 0);
  assert.equal(s.gitCalls.filter((args) => args[0] === "push").length, 1);
  assert.equal([...s.comments.values()].filter((c) => c.issue).length, 1);
  assert.equal(outsideStatus(record.body), preserved, "only the original host status block changes");
  const status = handoffStatus(record.body, p);
  assert.match(status, /受阻/);
  assert.match(status, /expected/i); assert.match(status, /actual/i);
  assert.ok(status.includes("head1") && status.includes("head2"));
  assert.match(status, /3/); assert.match(status, /attempt|check/i);
  assert.doesNotMatch(record.body, /Stale result|\*\*Progress:|Reviewed HEAD:/);
});

test("closing an issue during a head retry prevents both review handoff and the fallback Blocked mutation", async (t) => {
  const s = await delayedImplementation(t);
  await assert.rejects(s.resume(), mismatchError("head1", "head0"));
  s.state.open = false;
  t.mock.timers.tick(60_000);
  const before = s.calls.length;
  assert.deepEqual(await s.resume(), { stale: true });
  assert.equal(s.pending.headMismatch!.attempts, 1, "closed issue is not another head mismatch");
  assert.ok(!s.calls.slice(before).some(c => c.query.startsWith("mutation")));
  assert.equal(s.state.status, "进行中");
  assert.equal(s.pending.statusApplied, false);
});

test("a PR lookup transport failure is not a successful inconsistent-head observation", async (t) => {
  const s = await delayedImplementation(t);
  await assert.rejects(s.resume(), mismatchError("head1", "head0"));
  t.mock.timers.tick(60_000);
  const before = structuredClone(s.pending.headMismatch);
  s.state.fail = "pullRequests(headRefName";
  await assert.rejects(s.resume(), /injected request failure/);
  assert.deepEqual(s.pending.headMismatch, before);
  assert.equal(s.pending.stale, false);
  s.state.pr!.headRefOid = "head1";
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.state.status, "AI Review");
  assert.equal(s.gitCalls.filter(args => args[0] === "push").length, 1);
});

test("a board move to the intended review state cannot bypass a pending implementation SHA fence", async (t) => {
  const s = await delayedImplementation(t);
  await assert.rejects(s.resume(), mismatchError("head1", "head0"));
  s.state.status = "AI Review";
  t.mock.timers.tick(60_000);
  await assert.rejects(s.resume(), mismatchError("head1", "head0"));
  assert.equal(s.pending.headMismatch!.attempts, 2);
  assert.equal(s.pending.stale, false);
  assert.equal(s.pending.statusApplied, false);
  assert.equal(s.prComments.length, 0);
  t.mock.timers.tick(60_000);
  assert.deepEqual(await s.resume(), { stale: false });
  assert.equal(s.pending.targetState, "受阻");
  assert.equal(s.state.status, "受阻");
  assert.equal(s.pending.haltReason, "head_mismatch");
  assert.equal(s.reviews.length, 0);
});

for (const recovery of ["matching", "still divergent"]) {
  test(`implementation mismatch after PR mirror is ${recovery}: use the same timed host recovery, not stale`, async (t) => {
    const s = await delayedImplementation(t);
    s.state.pr!.headRefOid = "head1";
    s.state.after = (q) => { if (q.includes("addComment") && s.prComments.length === 1) s.state.pr!.headRefOid = "head0"; };
    await assert.rejects(s.resume(), mismatchError("head1", "head0"));
    assert.equal(s.pending.prPublished, true); assert.equal(s.pending.pushed, true); assert.equal(s.pending.stale, false);
    assert.equal(s.pending.headMismatch!.attempts, 1); assert.equal(s.state.status, "进行中");
    const ref = s.pending.issueMessage!;
    s.state.after = undefined; s.restart();
    const before = [s.calls.length, s.gitCalls.length];
    await assert.rejects(s.resume(), Error);
    assert.deepEqual([s.calls.length, s.gitCalls.length], before);
    t.mock.timers.tick(60_000);
    if (recovery === "matching") s.state.pr!.headRefOid = "head1";
    else {
      await assert.rejects(s.resume(), mismatchError("head1", "head0"));
      assert.equal(s.pending.headMismatch!.attempts, 2);
      s.restart(); t.mock.timers.tick(60_000);
    }
    assert.deepEqual(await s.resume(), { stale: false });
    assert.deepEqual(s.pending.issueMessage, ref);
    assert.equal(s.pending.stale, false); assert.equal(s.pending.statusApplied, true);
    assert.equal(s.state.status, recovery === "matching" ? "AI Review" : "受阻");
    assert.equal(s.pending.haltReason, recovery === "matching" ? null : "head_mismatch");
    assert.equal([...s.comments.values()].filter((c) => c.issue).length, 1);
    assert.equal(s.prComments.length, 1); assert.equal(s.reviews.length, 0);
    assert.equal(s.gitCalls.filter((args) => args[0] === "push").length, 1);
    assert.deepEqual(s.pending.result, s.result);
  });
}

for (const lost of ["updateProjectV2ItemFieldValue", "updateIssueComment"]) {
  test(`final implementation head-mismatch Blocked ${lost} response loss resumes without a fourth check or duplicate comment`, async (t) => {
    const s = await delayedImplementation(t);
    await assert.rejects(s.resume(), mismatchError("head1", "head0"));
    const ref = s.pending.issueMessage!;
    t.mock.timers.tick(60_000);
    await assert.rejects(s.resume(), mismatchError("head1", "head0"));
    t.mock.timers.tick(60_000); s.state.lose = lost;
    await assert.rejects(s.resume(), /injected response loss/);
    assert.equal(s.pending.headMismatch!.attempts, 3); assert.equal(s.pending.haltReason, "head_mismatch");
    assert.equal(s.pending.targetState, "受阻"); assert.equal(s.pending.waitingState, "受阻"); assert.equal(s.pending.stale, false);
    const headLookups = () => s.calls.filter((c) => c.query.includes("pullRequests(headRefName")).length;
    const checked = headLookups();
    s.restart();
    assert.deepEqual(await s.resume(), { stale: false }, "the final host decision can be republished immediately");
    t.mock.timers.tick(60_000);
    assert.deepEqual(await s.resume(), { stale: false }, "completed publication is idempotent too");
    assert.equal(s.pending.headMismatch!.attempts, 3); assert.equal(headLookups(), checked, "do not recheck SHA after the final Blocked decision");
    assert.deepEqual(s.pending.issueMessage, ref); assert.equal(s.pending.statusApplied, true);
    assert.equal(s.state.status, "受阻"); assert.equal(s.reviews.length, 0);
    assert.equal(s.calls.filter((c) => c.query.includes("updateProjectV2ItemFieldValue")).length, 1);
    assert.equal(s.calls.filter((c) => c.query.includes("addComment") && c.variables.id === "I_1").length, 1);
    assert.equal(s.gitCalls.filter((args) => args[0] === "push").length, 1);
    const record = s.comments.get(ref.id)!;
    assert.ok(record.body.includes(s.result.summary));
    const status = handoffStatus(record.body, s.pending);
    for (const text of ["受阻", "head1", "head0", "3"]) assert.ok(status.includes(text));
    assert.doesNotMatch(record.body, /Stale result/);
  });
}

test("uploaded attachments are persisted in the result before core publication retries", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "review-image-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "evidence.png"), "image");
  const s = publicationSetup({ workspacePath: root });
  let uploads = 0;
  t.mock.method(s.tracker, "uploadEvidence", async () => { uploads++; return [{ name: "evidence.png", url: "https://github.com/me/app/blob/sha/evidence.png" }]; });
  s.state.fail = "addComment";
  await s.call("tracker_submit_review", { ...changes, attachments: ["evidence.png"] });
  assert.match(s.saved.pending!.result.summary, /!\[evidence.png\]/);
  await s.resume(); assert.equal(uploads, 1);
  assert.match(s.comments.get(s.saved.pending!.issueMessage!.id)!.body, /!\[evidence.png\]/);
});

test("usage footer updates only its typed invocation-owned issue block and preserves manual edits", async () => {
  const s = publicationSetup(); await s.call("tracker_submit_review", changes);
  const p = s.saved.pending!, ref = p.issueMessage!, node = s.comments.get(ref.id)!;
  node.body = `Human preface\n${node.body}\nHuman afterword`;
  const footer = "用量（本轮）：12.34 · 轮次 6/20 · 模型：actual-a, actual-b";
  await s.tracker.updateUsageFooter(s.issue, ref, s.control.id, footer);
  await s.tracker.updateUsageFooter(s.issue, ref, s.control.id, footer);
  assert.equal(node.body.split(footer).length, 2);
  assert.ok(node.body.startsWith("Human preface\n") && node.body.endsWith("\nHuman afterword"));
  assert.ok(!s.comments.get(s.reviews[0]!)!.body.includes(footer));
  assert.equal(s.comments.size, 2, "never create a standalone usage message");
  const edits = s.calls.filter((c) => c.query.includes("updateIssueComment"));
  assert.equal(edits.filter((c) => c.variables.body.includes(footer)).length, 1);
});

test("unsafe/deleted footer targets are skipped; real read/update errors propagate without extra comments", async () => {
  for (const unsafe of ["deleted", "foreign-issue", "marker-removed", "duplicate-marker", "wrong-invocation", "pr-review"]) {
    const s = publicationSetup(); await s.call("tracker_submit_review", changes);
    const ref = s.saved.pending!.issueMessage!, node = s.comments.get(ref.id)!;
    if (unsafe === "deleted") s.comments.delete(ref.id);
    if (unsafe === "foreign-issue") node.issue = { id: "I_other" };
    if (unsafe === "marker-removed") node.body = "human replacement";
    if (unsafe === "duplicate-marker") node.body += "<!-- symphony-invocation:invocation-1 -->";
    const start = s.calls.length;
    await s.tracker.updateUsageFooter(s.issue, unsafe === "pr-review" ? { id: s.reviews[0]!, url: null } : ref,
      unsafe === "wrong-invocation" ? "other" : s.control.id, "用量（本轮）：0.00 · 轮次 1/20 · 模型：actual");
    assert.ok(!s.calls.slice(start).some((c) => c.query.startsWith("mutation")));
  }
  const s = publicationSetup(); await s.call("tracker_submit_review", changes);
  s.state.fail = "updateIssueComment";
  await assert.rejects(s.tracker.updateUsageFooter(s.issue, s.saved.pending!.issueMessage!, s.control.id, "用量（本轮）：1.00 · 轮次 1/20 · 模型：actual"), /injected/);
  s.state.fail = "... on IssueComment";
  await assert.rejects(s.tracker.updateUsageFooter(s.issue, s.saved.pending!.issueMessage!, s.control.id, "用量（本轮）：1.00 · 轮次 1/20 · 模型：actual"), /injected/);
  assert.equal(s.comments.size, 2); assert.equal(s.saved.pending!.statusApplied, true);
});

function followupFetch(openTitles: string[] = []) {
  const calls: Array<{ query: string; variables: Record<string, any> }> = [];
  const impl = async (_url: string, init: RequestInit) => {
    const call = JSON.parse(String(init.body));
    calls.push(call);
    const q: string = call.query;
    const data =
      q.includes("search(") ? { search: { nodes: openTitles.map((title, i) => ({ number: 90 + i, title, url: `https://github.com/me/app/issues/${90 + i}` })) } }
      : q.includes("defaultBranchRef") ? { repository: { id: "R_1", defaultBranchRef: { name: "main" } } }
      : q.includes("labels(first") ? { repository: { labels: { nodes: [{ id: "L_agent", name: "agent" }, { id: "L_td", name: "tech-debt" }] } } }
      : q.includes("createIssue") ? { createIssue: { issue: { id: "I_new", number: 13, url: "https://github.com/me/app/issues/13" } } }
      : q.includes("projectV2(number") ? { owner: { projectV2: {
        id: "PVT_1",
        field: { id: "F_status", options: [{ id: "o-todo", name: "待开始" }] },
        priority: { id: "F_prio", options: [{ id: "o-p1", name: "P1" }, { id: "o-p4", name: "P4" }] },
      } } }
      : q.includes("addProjectV2ItemById") ? { addProjectV2ItemById: { item: { id: "PVTI_new" } } }
      : q.includes("updateProjectV2ItemFieldValue") ? { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_new" } } }
      : null;
    if (!data) throw new Error(`unexpected query: ${q.slice(0, 80)}`);
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

const followups = { labels: ["tech-debt"], state: "待开始", priority: "P4", max_per_session: 2 };

function followupTool(impl: any, extra: Record<string, unknown> = {}, review = false) {
  const tracker = new GitHubProjectTracker({ ...provider, followups, ...extra }, env, quietLog, impl);
  const issue = (normalizeItem(item(), settings) as { issue: any }).issue;
  const tools = tracker.agentTools({
    issue, workspacePath: "/tmp", log: quietLog,
    ...(review ? { review: { round: 1, passState: "待验证", failState: "返工" } } : {}),
  });
  return { tools, call: (args: Record<string, unknown>) => tools.find((t) => t.name === "tracker_create_followup")!.handler!(args as any, {} as any) as Promise<any> };
}

test("follow-ups become low-priority board issues without the agent label", async () => {
  const { impl, calls } = followupFetch();
  const { call } = followupTool(impl);
  const result = await call({ title: "Bubbles cover the floor sign", body: "Seen at `ElevatorSceneView.swift:120` with three guests." });
  assert.equal(result.issue_url, "https://github.com/me/app/issues/13");
  const create = calls.find((c) => c.query.includes("createIssue"))!;
  assert.deepEqual(create.variables.labels, ["L_td"], "only the configured labels, never agent");
  assert.match(create.variables.body, /Filed by symphony-copilot's implementer while working on #12/);
  const updates = calls.filter((c) => c.query.includes("updateProjectV2ItemFieldValue")).map((c) => [c.variables.field, c.variables.option]);
  assert.deepEqual(updates, [["F_status", "o-todo"], ["F_prio", "o-p4"]]);
});

test("follow-ups reuse an open issue with the same title and are capped per session", async () => {
  const dup = followupFetch(["bubbles cover the floor sign"]);
  const result = await followupTool(dup.impl).call({ title: "Bubbles cover the floor sign", body: "x" });
  assert.equal(result.duplicate_of, "https://github.com/me/app/issues/90");
  assert.ok(!dup.calls.some((c) => c.query.includes("createIssue")));

  const capped = followupFetch();
  const { call } = followupTool(capped.impl);
  await call({ title: "One", body: "x" });
  await call({ title: "Two", body: "x" });
  const third = await call({ title: "Three", body: "x" });
  assert.match(String(third.textResultForLlm), /already filed 2 issues/);
});

test("the follow-up tool is offered to both roles only when configured", () => {
  const none = new GitHubProjectTracker(provider, env, quietLog, async () => new Response());
  const issue = (normalizeItem(item(), settings) as { issue: any }).issue;
  assert.ok(!none.agentTools({ issue, workspacePath: "/tmp", log: quietLog }).some((t) => t.name === "tracker_create_followup"));
  const { tools } = followupTool(async () => new Response(), {}, true);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["tracker_comment", "tracker_create_followup", "tracker_get_issue", "tracker_submit_review"]);
  assert.throws(() => parseSettings({ ...provider, followups: { labels: "tech-debt" } }, env), (e: TrackerError) => e.category === "invalid_tracker_config");
});

test("merge conflicts come from one aliased query; undecided and clean pull requests are left out", async () => {
  const pr = (number: number, mergeable: string) => ({ nodes: [{ number, url: `https://github.com/me/app/pull/${number}`, mergeable, baseRefName: "main" }] });
  const { impl, calls } = fakeFetch([{ data: { repository: { pr0: pr(22, "CONFLICTING"), pr1: pr(25, "UNKNOWN"), pr2: pr(26, "MERGEABLE"), pr3: { nodes: [] } } } }]);
  const tracker = new GitHubProjectTracker(provider, env, quietLog, impl);
  const issues = [12, 18, 19, 20].map((number) => (normalizeItem(item({ id: `PVTI_${number}` }, { number }), settings) as { issue: any }).issue);
  const conflicts = await tracker.findMergeConflicts(issues);
  assert.deepEqual(conflicts.map((c) => [c.issue.identifier, c.pullRequest]), [["GH-12", { number: 22, url: "https://github.com/me/app/pull/22", baseBranch: "main" }]]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.query, /pr3: pullRequests\(headRefName: \$b3, states: \[OPEN\]/);
  assert.deepEqual([calls[0]!.variables.b0, calls[0]!.variables.b3], ["agent/12", "agent/20"]);
});

test("the pre-submission check names the files that would conflict with the base branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conflict-"));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...args: string[]) => run("git", args, { cwd: dir, env: gitEnv });
  const commit = async (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    await git("add", file);
    await git("commit", "-q", "-m", file);
  };
  await git("init", "-q", "-b", "main");
  await commit("VERIFICATION.md", "base\n");
  await git("switch", "-q", "-c", "agent/13");
  await commit("VERIFICATION.md", "base\nicon record\n");
  await git("switch", "-q", "main");
  await commit("VERIFICATION.md", "base\nci record\n");
  await git("switch", "-q", "agent/13");
  assert.deepEqual(await conflictingFiles(dir, "main", gitEnv), ["VERIFICATION.md"]);
  await git("merge", "-q", "-X", "ours", "-m", "merge main", "main");
  assert.deepEqual(await conflictingFiles(dir, "main", gitEnv), [], "resolved after merging main");
  assert.deepEqual(await conflictingFiles(dir, "no-such-branch", gitEnv), [], "git errors do not block submission");
});
