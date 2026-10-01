import assert from "node:assert/strict";
import { test } from "node:test";
import { readIssueContext, CONTEXT_PAGE_SIZE } from "../src/tracker/issue-context.ts";
import { makeIssue } from "./helpers.ts";

function connection(nodes: unknown[] = [], hasMore = false, cursor: string | null = null) {
  return {
    nodes, totalCount: nodes.length + Number(hasMore),
    pageInfo: { hasPreviousPage: hasMore, hasNextPage: hasMore, startCursor: cursor, endCursor: cursor },
  };
}

const comment = (id: string, body: string) => ({ id, body, url: `https://github.com/me/app/issues/12#${id}`, author: { login: "me" }, createdAt: "2026-09-29T09:00:00Z" });
const review = (id: string, body: string) => ({ ...comment(id, body), url: `https://github.com/me/app/pull/10#${id}`, state: "COMMENT", submittedAt: "2026-09-29T09:00:00Z", commit: { oid: "head1" } });

function response() {
  return {
    issue: { id: "I_1", title: "Task", body: "Acceptance criteria", state: "OPEN", url: "https://github.com/me/app/issues/12", labels: { nodes: [{ name: "agent" }] }, comments: connection() },
    repository: { pullRequests: { nodes: [{
      id: "PR_1", number: 10, url: "https://github.com/me/app/pull/10", title: "Implementation", body: "PR description",
      mergeable: "MERGEABLE", baseRefName: "main", headRefOid: "head1",
      reviews: connection(), reviewThreads: connection(), comments: connection(),
    }] } },
  };
}

function setup(responses: unknown[]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let statusReads = 0;
  const source = {
    issue: makeIssue({ identifier: "GH-12", branchName: "agent/12" }), issueId: "I_1", repoOwner: "me", repoName: "app",
    graphql: async (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      assert.ok(responses.length, "unexpected context request");
      return responses.shift();
    },
    readStatus: async () => { statusReads++; return "AI Review"; },
  };
  return { calls, statusReads: () => statusReads, read: (args?: unknown) => readIssueContext(source, args) as Promise<any> };
}

test("overview preserves long issue/PR text, long blockers, and deduplicates only exact mirrored reviews", async () => {
  const data = response();
  data.issue.body = "a".repeat(9000) + "Final acceptance criterion";
  const blocker = "1. " + "Important evidence ".repeat(180) + "BLOCKER END";
  const body = `**AI review · round 1 of 3 · changes requested**\n\n${"Summary ".repeat(400)}\n\n**Blocking issues**\n\n${blocker}`;
  const sourceReview = review("review-1", body);
  const pr = data.repository.pullRequests.nodes[0]!;
  pr.body = "p".repeat(9000) + "PR END";
  pr.reviews = connection([sourceReview]);
  data.issue.comments = connection([
    comment("mirror", `${body}\n\n[Review on PR #10](${sourceReview.url})`),
    comment("other-author", "Not a duplicate"),
    { ...comment("different-author", `${body}\n\n[Review on PR #10](${sourceReview.url})`), author: { login: "someone" } },
    comment("changed-copy", `Additional evidence: ${body}\n\n[Review on PR #10](${sourceReview.url})`),
  ]);
  const s = setup([data]);
  const result = await s.read();
  assert.equal(result.status, "AI Review");
  assert.equal(result.body, data.issue.body);
  assert.equal(result.pull_request.body, pr.body);
  assert.equal(result.pull_request.head_commit, "head1");
  assert.equal(result.pull_request.reviews[0].body, body);
  assert.equal(result.pull_request.reviews[0].blocking_feedback, blocker);
  assert.equal(result.mirrored_reviews_omitted, 1);
  assert.deepEqual(result.comments.map((c: any) => c.id), ["other-author", "different-author", "changed-copy"]);
  assert.equal(result.history_complete, true);
  assert.equal(result.text_truncated, false);
  assert.equal(s.statusReads(), 1);
  assert.deepEqual(s.calls[0]!.variables, { id: "I_1", owner: "me", name: "app", branch: "agent/12" });
  assert.match(s.calls[0]!.query, new RegExp(`reviews\\(last: ${CONTEXT_PAGE_SIZE}\\)`));
});

for (const section of ["issue_comments", "reviews", "pull_request_comments"] as const) {
  test(`${section} exposes older pages and unabridged feedback via scoped cursors`, async () => {
    const first = response();
    const pr = first.repository.pullRequests.nodes[0]!;
    const key = section === "reviews" ? "reviews" : "comments";
    const parent = section === "issue_comments" ? first.issue : pr;
    (parent as any)[key] = connection([], true, "older-1");
    const second = response();
    const older = section === "reviews" ? review("old", "x".repeat(5000) + "Last blocker") : comment("old", "x".repeat(5000) + "Last comment");
    (section === "issue_comments" ? second.issue : second.repository.pullRequests.nodes[0] as any)[key] = connection([older]);
    const s = setup([first, second]);
    const overview = await s.read();
    assert.equal(overview.history_complete, false);
    assert.deepEqual(overview.pagination[section].next, { section, cursor: "older-1" });
    const result = await s.read(overview.pagination[section].next);
    assert.equal(result.items[0].body, older.body);
    assert.equal(result.pagination.has_more, false);
    assert.equal(result.pagination.next, null);
    assert.equal(result.text_truncated, false);
    assert.equal(s.calls[1]!.variables.cursor, "older-1");
    assert.equal(s.calls[1]!.variables.branch, "agent/12");
    assert.match(s.calls[1]!.query, /before: \$cursor/);
    assert.equal(s.statusReads(), 1, "paging history does not reread the board unnecessarily");
  });
}

test("threads and their individual comments paginate independently without losing unresolved feedback", async () => {
  const initial = response();
  initial.repository.pullRequests.nodes[0]!.reviewThreads = connection([
    { id: "T_1", isResolved: false, isOutdated: true, path: "src/workspace.ts", line: 42, comments: connection([comment("c1", "first")], true, "thread-comments-2") },
  ], true, "threads-2");
  const next = response();
  next.repository.pullRequests.nodes[0]!.reviewThreads = connection([
    { id: "T_2", isResolved: true, path: "src/workspace.ts", line: 43, comments: connection([comment("c2", "second")]) },
  ]);
  const comments = { ...response(), thread: { id: "T_1", pullRequest: { id: "PR_1" }, comments: connection([comment("c3", "Final nested comment " + "x".repeat(2500))]) } };
  const s = setup([initial, next, comments]);
  const overview = await s.read();
  assert.equal(overview.history_complete, false);
  assert.deepEqual(overview.pagination.review_threads.next, { section: "review_threads", cursor: "threads-2" });
  const nested = overview.pull_request.review_threads[0];
  assert.equal(nested.outdated, true);
  assert.deepEqual(nested.pagination.next, { section: "thread_comments", thread_id: "T_1", cursor: "thread-comments-2" });
  const moreThreads = await s.read(overview.pagination.review_threads.next);
  assert.equal(moreThreads.items[0].id, "T_2");
  assert.equal(moreThreads.items[0].resolved, true);
  const moreComments = await s.read(nested.pagination.next);
  assert.equal(moreComments.items[0].body, (comments.thread.comments.nodes[0] as any).body);
  assert.match(s.calls[2]!.query, /pullRequest \{ id \}/);
  assert.equal(s.calls[2]!.variables.thread, "T_1");
  assert.equal(s.calls[2]!.variables.cursor, "thread-comments-2");
});

test("a thread's unfinished comment page makes the overview incomplete even without more threads", async () => {
  const data = response();
  data.repository.pullRequests.nodes[0]!.reviewThreads = connection([
    { id: "T_1", isResolved: false, comments: connection([], true, "more") },
  ]);
  assert.equal((await setup([data]).read()).history_complete, false);
});

test("review copies remain accessible when their source is outside the current review page", async () => {
  const data = response();
  const body = "**AI review · round 1 of 3 · changes requested**\n\nFull feedback\n\n[Review on PR #10](https://github.com/me/app/pull/10#old)";
  data.issue.comments = connection([comment("copy", body)]);
  data.repository.pullRequests.nodes[0]!.reviews = connection([], true, "older-review");
  const result = await setup([data]).read();
  assert.equal(result.comments[0].body, body);
  assert.equal(result.mirrored_reviews_omitted, 0);
  assert.equal(result.history_complete, false);
});

test("missing or repeating pagination metadata cannot be reported as complete", async () => {
  for (const broken of [{ nodes: [] }, { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: null } }]) {
    const data = response();
    data.issue.comments = broken as any;
    await assert.rejects(setup([data]).read(), /pagination|cursor/);
  }
  const data = response();
  data.issue.comments = connection([], true, "unchanged");
  await assert.rejects(setup([data]).read({ section: "issue_comments", cursor: "unchanged" }), /advancing cursor/);
});

test("empty history and an issue without an open PR remain a complete usable overview", async () => {
  const data = response();
  data.repository.pullRequests.nodes = [];
  const result = await setup([data]).read();
  assert.equal(result.pull_request, null);
  assert.equal(result.history_complete, true);
  assert.deepEqual(result.comments, []);
  await assert.rejects(setup([data]).read({ section: "reviews" }), /no open pull request/);
});

test("an older implementation plan remains retrievable through scoped issue history without an open PR", async () => {
  const recent = response(), older = response();
  recent.repository.pullRequests.nodes = [];
  older.repository.pullRequests.nodes = [];
  const plan = comment("original-plan", "## Implementation plan\n\nGoal and non-goals.\nEvidence and assumptions.\nDecisions, counterexamples and verification.\nORIGINAL PLAN END");
  const revision = comment("revision", "## Implementation plan — revision\n\nFailure class: stale work reuse. Check current content before replacing it. Preserve the original plan.");
  recent.issue.comments = connection([
    revision, ...Array.from({ length: CONTEXT_PAGE_SIZE - 1 }, (_, i) => comment(`later-${i}`, `Later handoff ${i}`)),
  ], true, "before-revision");
  older.issue.comments = connection([plan]);
  older.issue.comments.totalCount = CONTEXT_PAGE_SIZE + 1;
  const s = setup([recent, older]);
  const overview = await s.read();
  assert.equal(overview.pull_request, null);
  assert.equal(overview.history_complete, false);
  assert.equal(overview.text_truncated, false);
  assert.equal(overview.comments[0].body, revision.body);
  assert.ok(!overview.comments.some((c: any) => c.id === plan.id), "the recent page alone is insufficient evidence");
  assert.deepEqual(overview.pagination, {
    issue_comments: { total_count: CONTEXT_PAGE_SIZE + 1, has_more: true, next: { section: "issue_comments", cursor: "before-revision" } },
  });
  const page = await s.read(overview.pagination.issue_comments.next);
  assert.equal(page.identifier, "GH-12"); assert.equal(page.section, "issue_comments");
  assert.equal(page.items[0].id, plan.id); assert.equal(page.items[0].body, plan.body);
  assert.equal(page.text_truncated, false);
  assert.deepEqual(page.pagination, { total_count: CONTEXT_PAGE_SIZE + 1, has_more: false, next: null });
  assert.deepEqual(s.calls[1]!.variables, { id: "I_1", owner: "me", name: "app", branch: "agent/12", cursor: "before-revision" });
  assert.match(s.calls[1]!.query, new RegExp(`comments\\(last: ${CONTEXT_PAGE_SIZE}, before: \\$cursor\\)`));
  assert.equal(s.statusReads(), 1);
  assert.equal(s.calls.length, 2, "the issue history requires no PR-specific history request");
});

test("long implementation plans and revisions are unabridged in both overview and issue-comment pages", async () => {
  const data = response(); data.repository.pullRequests.nodes = [];
  data.issue.body = "Acceptance criteria. ".repeat(500) + "FINAL ACCEPTANCE CRITERION";
  const plan = comment("long-plan", "## Implementation plan\n\n" + "Evidence, material assumptions, alternatives and counterexamples. ".repeat(1000)
    + "\nFINAL INVARIANT: plan text cannot waive acceptance criteria.");
  const revision = comment("long-revision", "## Implementation plan — revision\n\n" + "Failure class, changed approach and verification. ".repeat(150)
    + "\nFINAL VERIFICATION: check shared ownership and cleanup, not only the latest example.");
  data.issue.comments = connection([plan, revision]);
  const s = setup([data, data]);
  const overview = await s.read();
  assert.equal(overview.body, data.issue.body);
  assert.equal(overview.pull_request, null);
  assert.equal(overview.history_complete, true); assert.equal(overview.text_truncated, false);
  assert.equal(overview.mirrored_reviews_omitted, 0);
  assert.deepEqual(overview.comments.map((c: any) => c.body), [plan.body, revision.body]);
  const page = await s.read({ section: "issue_comments" });
  assert.deepEqual(page.items, overview.comments, "bounded record counts must not clip individual plans or revisions");
  assert.equal(page.text_truncated, false); assert.equal(page.pagination.next, null);
  assert.equal(s.calls[1]!.variables.cursor, null);
  assert.equal(s.statusReads(), 1);
});

test("canonical result records and usage footers remain fully readable after the PR closes", async () => {
  const data = response(); data.repository.pullRequests.nodes = [];
  const evidence = "verified evidence ".repeat(1000) + "FINAL COUNTEREXAMPLE";
  const body = `**AI review · request_changes**\n\nReviewed HEAD: head1\n\n${evidence}\n\n**Progress: no_progress**\n\nPrior failure reproduced.\n\n**Next action: continue**\n\nTry a different boundary condition.\n\n**Blocking issues**\n\n1. Full unresolved blocker\n\n<!-- symphony-result:result-1 -->\n\n<!-- symphony-invocation:invocation-1 -->\n\n<!-- symphony-usage:invocation-1:start -->\n用量（本轮）：12.34 · 轮次 6/20 · 模型：actual\n<!-- symphony-usage:invocation-1:end -->`;
  data.issue.comments = connection([comment("canonical", body)]);
  const result = await setup([data]).read();
  assert.equal(result.pull_request, null);
  assert.equal(result.comments[0].body, body);
  assert.match(result.comments[0].body, /FINAL COUNTEREXAMPLE[\s\S]*Try a different boundary condition[\s\S]*Full unresolved blocker/);
  assert.equal(result.history_complete, true); assert.equal(result.text_truncated, false);
});

test("foreign review threads and missing issue/PR lookups fail without returning their content", async () => {
  const data = { ...response(), thread: { id: "FOREIGN", pullRequest: { id: "PR_OTHER" }, comments: connection([comment("secret", "other issue content")]) } };
  await assert.rejects(setup([data]).read({ section: "thread_comments", thread_id: "FOREIGN" }), /does not belong/);
  await assert.rejects(setup([{ ...response(), issue: null }]).read(), /issue not accessible/);
  await assert.rejects(setup([{ ...response(), repository: null }]).read(), /pull request lookup missing/);
});

test("invalid context selectors and arbitrary issue identifiers make no API requests", async () => {
  const s = setup([]);
  for (const args of [null, [], "x", { issue_id: "other" }, { section: "arbitrary" }, { cursor: "x" }, { section: "reviews", cursor: "" }, { section: "reviews", cursor: "x".repeat(2049) }, { thread_id: "T_1" }, { section: "thread_comments" }]) {
    await assert.rejects(s.read(args));
  }
  assert.deepEqual(s.calls, []);
});
