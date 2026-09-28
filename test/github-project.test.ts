import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubProjectTracker, normalizeItem, parseSettings, type RawItem } from "../src/tracker/github-project.ts";
import { TrackerError } from "../src/tracker/index.ts";
import { quietLog } from "./helpers.ts";

const provider = { owner: "me", project_number: 1, repo: "me/app", status_field: "Status", priority_field: "优先级" };
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
