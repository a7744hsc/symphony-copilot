import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { CopilotClient, type CopilotSession, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import type { Role } from "../src/config.ts";
import type { PendingHandoff } from "../src/iteration.ts";
import { RunLedger } from "../src/ledger.ts";
import { Orchestrator, type WorkerParams } from "../src/orchestrator.ts";
import type { FetchLike } from "../src/tracker/github-api.ts";
import type { RawItem } from "../src/tracker/github-project.ts";
import { WorkspaceManager, type Workspace } from "../src/workspace.ts";
import { captureLog, flush, makeConfig, makeWorkflow } from "./helpers.ts";

const repo = "offline/iteration", issueId = "I_iteration_12", itemId = "PVTI_iteration_12";
const controlKey = `${repo}:${issueId}`;
const states = ["Todo", "In Progress", "Rework", "AI Review", "Human Review", "Blocked", "Done"];
const provider = {
  owner: "offline", repo, project_number: 1, endpoint: "https://github.invalid/graphql",
  start_state: "Todo", working_state: "In Progress", blocked_state: "Blocked",
  handoff_state: "AI Review", agent_states: ["In Progress", "Blocked"],
};

interface Message {
  id: string;
  url: string;
  body: string;
  issue?: { id: string };
  commit?: { oid: string };
}

/** Stateful GraphQL server, including native identity, exact comment edits and history pagination. */
function publicationFetch() {
  const calls: Array<{ query: string; variables: Record<string, any> }> = [];
  const messages = new Map<string, Message>();
  const reviews: Message[] = [], prComments: Message[] = [];
  const transitions: string[] = [];
  const headReads: Array<{ at: number; head: string | null; remoteHead: string }> = [];
  const state = {
    status: "Todo", localHead: "", remoteHead: "", delayPrHead: false,
    loseNextIssueCommentResponse: false,
    pr: null as null | { id: string; number: number; url: string; headRefOid: string; body: string },
  };
  const issueMessages = () => [...messages.values()].filter((m) => m.issue?.id === issueId);
  const item = (): RawItem => ({
    __typename: "ProjectV2Item", id: itemId, isArchived: false, project: { id: "PVT_1" },
    status: { name: state.status }, priority: { name: "P2" },
    content: {
      __typename: "Issue", id: issueId, number: 12, title: "Offline iteration", body: "Verify the complete handoff loop.",
      state: "OPEN", url: `https://github.invalid/${repo}/issues/12`, repository: { nameWithOwner: repo },
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      labels: { nodes: [{ name: "agent" }] }, assignees: { nodes: [] }, blockedBy: { nodes: [] },
    },
  });
  const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null } });
  const impl: FetchLike = async (url, init) => {
    assert.equal(url, provider.endpoint);
    assert.equal(init.method, "POST");
    const { query: q, variables: v } = JSON.parse(String(init.body));
    calls.push({ query: q, variables: v });
    let data: unknown;
    if (q.includes("issue: node")) {
      assert.equal(v.id, issueId);
      assert.equal(v.owner + "/" + v.name, repo);
      assert.equal(v.branch, "agent/12");
      assert.ok(q.includes("comments(last: 5"));
      const all = issueMessages(), end = v.cursor == null ? all.length : Number(v.cursor);
      const start = Math.max(0, end - 5);
      data = { issue: { ...item().content, comments: {
        nodes: all.slice(start, end), totalCount: all.length,
        pageInfo: { hasPreviousPage: start > 0, startCursor: start > 0 ? String(start) : null },
      } }, repository: { pullRequests: { nodes: state.pr ? [{
        ...state.pr, reviews: connection(reviews), comments: connection(prComments), reviewThreads: connection([]),
      }] : [] } } };
    } else if (q.includes("items(first: 100")) {
      data = { owner: { projectV2: { items: connection([item()]) } } };
    } else if (q.includes("projectV2(number")) {
      data = { owner: { projectV2: { id: "PVT_1", field: {
        id: "F_status", options: states.map((name) => ({ id: name, name })),
      } } } };
    } else if (q.includes("nodes(ids:")) {
      assert.deepEqual(v.ids, [itemId]);
      data = { nodes: [item()] };
    } else if (q.includes("projectItems(first")) {
      assert.equal(v.id, issueId);
      data = { node: { id: issueId, state: "OPEN", repository: { nameWithOwner: repo }, projectItems: connection([item()]) } };
    } else if (q.includes("pullRequests(headRefName")) {
      assert.equal(v.branch, "agent/12");
      headReads.push({ at: Date.now(), head: state.pr?.headRefOid ?? null, remoteHead: state.remoteHead });
      data = { repository: { pullRequests: { nodes: state.pr ? [state.pr] : [] } } };
    } else if (q.includes("defaultBranchRef")) {
      data = { repository: { id: "R_1", defaultBranchRef: { name: "main" } } };
    } else if (q.includes("updateIssueComment")) {
      const message = messages.get(v.id);
      assert.equal(message?.issue?.id, issueId);
      message!.body = v.body;
      data = { updateIssueComment: { issueComment: { id: v.id } } };
    } else if (q.includes("addComment") || q.includes("addPullRequestReview")) {
      const review = q.includes("addPullRequestReview");
      if (review) {
        assert.equal(v.pr, state.pr?.id);
        assert.equal(v.head, state.pr?.headRefOid);
        assert.ok(q.includes("commitOID: $head, event: COMMENT"));
      } else assert.ok(v.id === issueId || v.id === state.pr?.id);
      const id = `C_${messages.size + 1}`;
      const message: Message = { id, url: `https://github.invalid/${repo}/issues/12#${id}`, body: v.body,
        ...(review ? { commit: { oid: v.head } } : v.id === issueId ? { issue: { id: issueId } } : {}) };
      messages.set(id, message);
      if (review) reviews.push(message);
      else if (v.id !== issueId) prComments.push(message);
      if (!review && v.id === issueId && state.loseNextIssueCommentResponse) {
        state.loseNextIssueCommentResponse = false;
        throw new Error("offline plan comment persisted; response lost");
      }
      data = review ? { addPullRequestReview: { pullRequestReview: message } } : { addComment: { commentEdge: { node: message } } };
    } else if (q.includes("createPullRequest")) {
      assert.equal(state.pr, null);
      assert.equal(v.repo, "R_1");
      assert.equal(v.head, "agent/12");
      assert.equal(v.base, "main");
      assert.ok(state.remoteHead, "publication must push before creating the PR");
      state.pr = { id: "PR_1", number: 13, url: `https://github.invalid/${repo}/pull/13`, headRefOid: state.remoteHead, body: v.body };
      data = { createPullRequest: { pullRequest: state.pr } };
    } else if (q.includes("updateProjectV2ItemFieldValue")) {
      assert.equal(v.project, "PVT_1");
      assert.equal(v.item, itemId);
      assert.equal(v.field, "F_status");
      assert.ok(states.includes(v.option));
      transitions.push(state.status = v.option);
      data = { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId } } };
    } else if (q.includes("... on IssueComment")) {
      data = { node: messages.get(v.id) ?? null };
    } else if (q.includes("reviews(first")) {
      assert.equal(v.id, state.pr?.id);
      data = { node: { id: v.id, reviews: connection(reviews) } };
    } else if (q.includes("comments(first")) {
      assert.ok(v.id === issueId || v.id === state.pr?.id);
      data = { node: { id: v.id, comments: connection(v.id === issueId ? issueMessages() : prComments) } };
    } else assert.fail(`unexpected offline GraphQL request: ${q}`);
    return new Response(JSON.stringify({ data }));
  };
  return { impl, calls, messages, reviews, prComments, transitions, headReads, state, issueMessages };
}

interface GitCall { cwd: string; args: string[] }

/** Import exec.ts only AFTER replacing execFile: its promisified function is captured at module load. */
async function offlineRuntime(t: TestContext) {
  let git: (call: GitCall) => string = () => assert.fail("Git used outside an active fixture");
  const original = childProcess.execFile;
  // execFile's original promisify.custom is non-configurable; a method mock inherits it and
  // would still launch real Git. Replace the function, including its custom promise entry point.
  childProcess.execFile = Object.assign(() => assert.fail("unexpected callback-style execFile"), {
    [promisify.custom]: async (file: string, args: string[], options: { cwd: string }) => {
      assert.equal(file, "git", "no non-Git subprocess is permitted");
      return { stdout: git({ cwd: options.cwd, args }), stderr: "" };
    },
  }) as unknown as typeof original;
  t.mock.method(childProcess, "spawn", () => assert.fail("no runtime or hook subprocess is permitted"));
  t.mock.method(globalThis, "fetch", () => assert.fail("no real network request is permitted"));
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = original;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { runAgentAttempt } = await import("../src/runner.ts");
  const { GitHubProjectTracker } = await import("../src/tracker/github-project.ts");
  return { runAgentAttempt, GitHubProjectTracker, setGit(handler: typeof git) { git = handler; } };
}

interface Plan {
  role: Role; progress?: "initial" | "no_progress"; hold?: boolean; failCreate?: boolean; pendingHeadMismatch?: boolean;
  issuePlan?: { body: string; product: string; loseResponse?: boolean };
}

function setup(t: TestContext, runtime: Awaited<ReturnType<typeof offlineRuntime>>, plans: Plan[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "iteration-integration-")));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-09-30T00:00:00Z") });
  const promptFile = join(root, "REVIEW.md");
  writeFileSync(promptFile, "Review {{ issue.identifier }}; review sequence {{ review_round }}.");
  const config = makeConfig({
    tracker: { kind: "github_project", provider, active_states: states.slice(0, 4), terminal_states: ["Done"], required_labels: ["agent"] },
    polling: { interval_ms: 3_600_000 }, workspace: { root: join(root, "workspaces") },
    agent: { max_concurrent_agents: 1, max_turns: 1, max_sessions: 20, usage_comments: true },
    copilot: { model: "auto", stall_timeout_ms: 0 },
    review: { states: ["AI Review"], prompt_file: promptFile, model: "auto", pass_state: "Human Review", fail_state: "Rework" },
  });
  const api = publicationFetch(), { log, lines } = captureLog();
  const ledger = new RunLedger(join(root, "ledger.json"));
  const tracker = new runtime.GitHubProjectTracker(provider, { SYMPHONY_GITHUB_TOKEN: "offline-not-a-secret" }, log, api.impl);
  const workspaces = new WorkspaceManager(log, {});
  const prepared = new Set<string>(), hooks: string[] = [], gitCalls: GitCall[] = [], errors: unknown[] = [];
  const workers: Array<{ params: WorkerParams; done: Promise<void> }> = [];
  const steps = plans.map((plan, index) => ({
    ...plan, index, sent: Promise.withResolvers<void>(), started: Promise.withResolvers<void>(),
    summary: `Session ${index + 1}: criteria, independent evidence and relevant human constraints.\n${"Complete evidence. ".repeat(200)}\nEND EVIDENCE ${index + 1}`,
    reason: `Evidence for review ${index + 1}: the same invariant still fails.`,
    nextStep: `Changed approach ${index + 1}: isolate the failing invariant with a minimal counterexample.`,
    blocker: `Blocker ${index + 1}: complete reproduction and observed versus expected results.`,
    head: (index + 1).toString(16).padStart(40, "0"), credits: index + 1.25,
    model: `offline-actual-${plan.role}`, session: undefined as SessionConfig | undefined,
    history: [] as string[], actions: [] as string[], prompt: "", metricsRead: false,
    submittedPending: null as PendingHandoff | null,
  }));
  const scriptedPlanning = plans.some((p) => p.issuePlan);
  const counts = { start: 0, create: 0, created: 0, send: 0, metrics: 0, disconnect: 0, stop: 0, forceStop: 0, abort: 0 };
  t.mock.method(workspaces, "hook", async (_config: unknown, name: string, workspace: Workspace) => {
    hooks.push(`${workspace.role}:${name}`);
    if (name === "after_create") {
      prepared.add(workspace.path);
      // Marker only: exercise the reviewer's local HEAD check without initializing a repository.
      mkdirSync(join(workspace.path, ".git"));
    }
  });
  const git = (call: GitCall): string => {
    gitCalls.push(call);
    assert.ok(prepared.has(call.cwd), "Git must stay in this fixture's own workspace");
    const args = call.args;
    if (args[0] === "status") { assert.deepEqual(args, ["status", "--porcelain"]); return ""; }
    if (args[0] === "fetch") { assert.deepEqual(args, ["fetch", "--quiet", "origin", "main"]); return ""; }
    if (args[0] === "rev-parse") { assert.deepEqual(args, ["rev-parse", "HEAD"]); return api.state.localHead; }
    if (args[0] === "rev-list") { assert.deepEqual(args, ["rev-list", "--count", "origin/main..HEAD"]); return "1"; }
    if (args[0] === "merge-tree") {
      assert.deepEqual(args, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "origin/main", "HEAD"]);
      return `${"f".repeat(40)}\n`; // Successful, conflict-free Git response, not the error/unknown path.
    }
    if (args[0] === "push") {
      assert.deepEqual(args, ["push", "--quiet", "origin", `${api.state.localHead}:refs/heads/agent/12`]);
      const pending = ledger.get(controlKey)!.pending!;
      assert.equal(pending.result.kind, "implement");
      assert.ok(pending.issueMessage && api.messages.has(pending.issueMessage.id), "full issue record precedes push");
      api.state.remoteHead = api.state.localHead;
      if (api.state.pr && !api.state.delayPrHead) api.state.pr.headRefOid = api.state.remoteHead;
      return "";
    }
    return assert.fail(`unexpected Git operation: ${args.join(" ")}`);
  };
  runtime.setGit((call) => {
    try { return git(call); }
    catch (error) {
      // conflictingFiles deliberately ignores unknown Git errors; a mock assertion must not be ignored.
      errors.push(error);
      throw error;
    }
  });
  t.mock.method(CopilotClient.prototype, "start", async () => { counts.start++; });
  t.mock.getter(CopilotClient.prototype, "rpc", () => ({ account: { getQuota: async () => ({ quotaSnapshots: {} }) } }));
  t.mock.method(CopilotClient.prototype, "createSession", async (session: SessionConfig) => {
    const step = steps[counts.create++];
    assert.ok(step, "no extra SDK attempt may start");
    step.session = session;
    assert.equal(session.model, "auto");
    assert.equal(session.sessionId, workers[step.index]!.params.control.id);
    if (step.failCreate) throw new Error("offline createSession rejection");
    counts.created++;
    const listeners = new Set<(event: SessionEvent) => void>();
    const emit = (type: SessionEvent["type"], data: object = {}) => {
      for (const listener of listeners) listener({ type, data } as SessionEvent);
    };
    const tool = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const handler = session.tools?.find((tool) => tool.name === name)?.handler;
      assert.ok(handler, `real tracker must expose ${name}`);
      step.actions.push(name);
      const result: any = await handler(args, { sessionId: session.sessionId!, toolCallId: `${step.index}:${name}`, toolName: name, arguments: args });
      if (step.issuePlan?.loseResponse && name === "tracker_comment") {
        assert.equal(result?.resultType, "failure");
        assert.match(result.textResultForLlm, /offline plan comment persisted; response lost/);
      } else if (step.pendingHeadMismatch && name === "tracker_submit_for_review") {
        assert.equal(result?.resultType, "failure", "post-push metadata lag must be a retryable publication error, not accepted stale completion");
        assert.equal(workers[step.index]!.params.control.accepted(), true);
        const pending = ledger.get(controlKey)!.pending;
        assert.ok(pending, "only an already accepted, still-pending result may return this expected tool error");
        assert.equal(pending.result.kind, "implement"); assert.equal(pending.stale, false);
        assert.equal(pending.headMismatch?.attempts, 1);
        assert.ok(result.textResultForLlm.includes(step.head) && result.textResultForLlm.includes(api.state.pr!.headRefOid));
        assert.match(result.textResultForLlm, /expected/i); assert.match(result.textResultForLlm, /actual/i);
        step.submittedPending = structuredClone(pending);
      } else assert.notEqual(result?.resultType, "failure", JSON.stringify(result));
      return result;
    };
    return {
      sessionId: session.sessionId!,
      on(listener: (event: SessionEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async send({ prompt }: { prompt: string }) {
        counts.send++;
        try {
          step.prompt = prompt;
          const cycle = ledger.get(controlKey)!;
          assert.equal(cycle.invocation!.sessionId, session.sessionId, "host confirms the actual session before the first prompt");
          assert.equal(cycle.invocation!.phase, "running");
          if (scriptedPlanning) {
            const issue = await tool("tracker_get_issue", {});
            assert.equal(issue.identifier, "GH-12");
            assert.equal(issue.body, workers[step.index]!.params.issue.description);
            assert.equal(issue.text_truncated, false);
            if (step.index === 0) assert.equal(issue.pull_request, null);
          }
          const readHistory = async (): Promise<Message[]> => {
            const messages: Message[] = [];
            let args: Record<string, unknown> | null = { section: "issue_comments" };
            while (args) {
              const history = await tool("tracker_get_issue", args);
              assert.equal(history.text_truncated, false);
              messages.unshift(...history.items);
              args = history.pagination.next;
            }
            assert.deepEqual(messages.map((m) => m.body), api.issueMessages().map((m) => m.body));
            return messages;
          };
          step.history = (await readHistory()).map((m) => m.body);
          const priorPlans = steps.slice(0, step.index).filter((s) => s.issuePlan);
          assert.equal(step.history.length, step.index + priorPlans.length);
          if (step.hold) { step.sent.resolve(); return "held-message"; }
          // Scripted model behavior through real tools, not a host write gate or proof of LLM quality.
          if (step.issuePlan) {
            assert.equal(step.role, "implement");
            assert.match(prompt, /## Autonomous planning/);
            assert.match(prompt, /tracker_comment before product edits/);
            const work = join(session.workingDirectory!, "work"), product = join(work, "product.txt");
            const previous = priorPlans.at(-1);
            if (previous) assert.equal(readFileSync(product, "utf8"), previous.issuePlan!.product);
            else assert.equal(existsSync(product), false, "first plan precedes any fixture product write");
            const authorization = cycle.authorizationId, stateBeforePlan = api.state.status;
            api.state.loseNextIssueCommentResponse = step.issuePlan.loseResponse === true;
            const posted = await tool("tracker_comment", { body: step.issuePlan.body });
            if (step.issuePlan.loseResponse) {
              // The fake server persisted the comment before losing its reply. The script chooses
              // to reread scoped history and reuse it; tracker_comment has no exactly-once recovery.
              assert.equal(existsSync(product), false, "no product write before recovering the uncertain plan publication");
              const reread = await readHistory();
              const matching = reread.filter((m) => m.body.startsWith(`${step.issuePlan!.body}\n\n`));
              assert.equal(matching.length, 1, "reuse the matching persisted plan without posting again");
            } else assert.ok(api.messages.get(posted.comment_id)?.body.startsWith(`${step.issuePlan.body}\n\n`));
            assert.equal(cycle.authorizationId, authorization);
            assert.equal(cycle.sessions, step.index + 1);
            assert.equal(counts.created, step.index + 1);
            assert.equal(Object.keys(cycle.allocations).length, step.index + 1);
            assert.equal(cycle.allocations[session.sessionId!]!.resultId, null, "a plan is not a formal handoff");
            assert.equal(cycle.pending, null);
            assert.equal(workers[step.index]!.params.control.accepted(), false);
            assert.equal(api.state.status, stateBeforePlan, "planning needs no approval lane");
            mkdirSync(work, { recursive: true });
            writeFileSync(product, step.issuePlan.product);
            step.actions.push("product_write");
            writeFileSync(join(work, "handoff.md"), step.summary);
            step.actions.push("handoff_write");
          } else if (scriptedPlanning && step.role === "review") {
            assert.match(prompt, /## Independent plan assessment/);
            assert.match(prompt, /Independently check the requirements, code/);
            const implementation = priorPlans.at(-1)!;
            assert.notEqual(session.workingDirectory, implementation.session!.workingDirectory);
            assert.ok(!session.tools?.some((tool) => tool.name === "tracker_submit_for_review"));
            const work = join(implementation.session!.workingDirectory!, "work");
            assert.equal(readFileSync(join(work, "product.txt"), "utf8"), implementation.issuePlan!.product);
            assert.equal(readFileSync(join(work, "handoff.md"), "utf8"), implementation.summary);
            step.actions.push("review_fixture_work");
          }
          api.state.localHead = step.role === "implement" ? step.head : api.state.remoteHead;
          const result = step.role === "implement"
            ? await tool("tracker_submit_for_review", { title: `Implementation ${step.index + 1}`, summary: step.summary })
            : await tool("tracker_submit_review", {
              verdict: "request_changes", reviewed_head: api.state.remoteHead, progress: step.progress,
              progress_reason: step.reason, next_action: "continue", next_step: step.nextStep,
              summary: step.summary, blocking_issues: [step.blocker],
            });
          if (!step.pendingHeadMismatch) {
            assert.equal(result.accepted, true);
            assert.equal(result.stale, false);
          }
          assert.equal(workers[step.index]!.params.control.accepted(), true);
          assert.doesNotMatch(api.issueMessages().at(-1)!.body, /用量（本轮）/, "footer waits for final runner metrics");
          emit("assistant.usage", { model: step.model, inputTokens: 100, outputTokens: 10, copilotUsage: { totalNanoAiu: 125_000_000 } });
          if (step.pendingHeadMismatch) emit("session.error", { message: "offline turn ended after accepted publication error" });
          else emit("session.idle");
          step.sent.resolve();
          return "submitted-message";
        } catch (error) {
          errors.push(error); // Accepted-result cleanup can swallow send errors; keep assertions observable.
          step.sent.resolve();
          throw error;
        }
      },
      async abort() { counts.abort++; },
      async disconnect() { counts.disconnect++; },
      rpc: {
        usage: { getMetrics: async () => {
          counts.metrics++; step.metricsRead = true;
          return { totalNanoAiu: step.credits * 1e9, totalPremiumRequestCost: 1,
            modelMetrics: { [step.model]: { requests: { count: 1 }, totalNanoAiu: step.credits * 1e9 } } };
        } },
        ui: { handlePendingSessionLimitsExhausted: async () => assert.fail("no provider limits expected") },
      },
    } as unknown as CopilotSession;
  });
  t.mock.method(CopilotClient.prototype, "stop", async () => { counts.stop++; return []; });
  t.mock.method(CopilotClient.prototype, "forceStop", async () => { counts.forceStop++; });
  const workflow = makeWorkflow(config);
  const orchestrator = new Orchestrator({
    log, ledger, refreshWorkflow: () => workflow, workflowError: () => null, createTracker: () => tracker,
    removeWorkspace: async () => assert.fail("waiting cards must retain both workspaces"),
    runWorker(params) {
      const step = steps[workers.length];
      assert.ok(step, "no extra worker may dispatch");
      assert.equal(params.role, step.role);
      assert.equal(params.tracker, tracker);
      assert.equal(params.issue.nativeRef?.issue_id, issueId);
      assert.equal(params.issue.nativeRef?.repository, repo);
      const done = runtime.runAgentAttempt({
        ...params, config: params.workflow.config, promptTemplate: params.workflow.definition.promptTemplate, workspaces, childEnv: {},
      });
      workers.push({ params, done });
      step.started.resolve();
      return done;
    },
  });
  t.after(async () => {
    // Drain while SDK stubs and fake timers still exist; never reset timers underneath a worker.
    await orchestrator.stop();
    for (const step of steps) if (step.session?.largeOutput?.outputDirectory) rmSync(step.session.largeOutput.outputDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const finish = async (index: number, failure = false) => {
    await steps[index]!.started.promise;
    const done = workers[index]!.done;
    if (failure) await assert.rejects(done, /startup_failed: offline createSession rejection/);
    else await done;
    // One real event-loop barrier lets the worker's exit enqueue; tick then awaits that serial queue.
    // No bounded polling, sleeps, or advancing startup/turn timeouts to guess at completion.
    await flush(1);
    await orchestrator.tick();
    assert.deepEqual(errors, []);
    assert.equal(orchestrator.snapshot().counts.running, 0);
    assert.equal(orchestrator.snapshot().ledger_error, null);
  };
  return { api, ledger, orchestrator, steps, workers, counts, gitCalls, hooks, prepared, lines, errors, finish };
}

test("offline iteration integration: real scheduler, runner, ledger and GitHub tracker", { timeout: 15_000 }, async (t) => {
  const runtime = await offlineRuntime(t);
  await t.test("scripted plan publication/reuse, independent review and revision share the existing session allowance", async (t) => {
    const plan = "## Implementation plan\n\n"
      + "Goal: preserve fixture work across implementation/review handoffs; no new role or board lane.\n"
      + "Evidence: each role has its own workspace. Assumption: the existing work file is reusable.\n"
      + "Approach: retain the work file, rather than create another planning session.\n"
      + "Verify: check replacement and cleanup ownership, then write work and publish the complete handoff.\n"
      + "PLAN END: acceptance criteria still apply independently of this plan.";
    const revision = "## Implementation plan — revision\n\n"
      + "The first review found stale work reuse: file existence does not establish current content.\n"
      + "Change the shared reuse check to validate content before replacement; keep the original plan as history.\n"
      + "Verify both initial work and replacement in the same implementation workspace. REVISION END.";
    const s = setup(t, runtime, [
      { role: "implement", issuePlan: { body: plan, product: "initial fixture work\n", loseResponse: true } },
      { role: "review", progress: "initial" },
      { role: "implement", issuePlan: { body: revision, product: "revised fixture work\n" } },
      { role: "review", progress: "no_progress" },
    ]);
    s.steps[1]!.reason = "Independent counterexample: an existing work file can contain stale content.";
    s.steps[1]!.nextStep = "Validate content, not existence alone, before reusing or replacing work.";
    s.steps[1]!.blocker = "The same workspace can retain an earlier version; verify the replacement path.";
    await s.orchestrator.start();
    await s.orchestrator.tick();
    const targets = ["AI Review", "Rework", "AI Review", "Rework"];
    let authorization = "";
    const preservedPlans: Message[] = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) t.mock.timers.tick(1_000);
      await s.finish(i);
      const cycle = s.ledger.get(controlKey)!, step = s.steps[i]!;
      authorization ||= cycle.authorizationId;
      assert.equal(cycle.authorizationId, authorization, "neither planning nor automatic rework reauthorizes");
      assert.equal(cycle.limit, 20);
      assert.equal(cycle.sessions, i + 1, "one allocation per actual implementation/review SDK session");
      assert.equal(s.counts.create, i + 1); assert.equal(s.counts.created, i + 1); assert.equal(s.counts.send, i + 1);
      assert.equal(s.workers.length, i + 1); assert.equal(Object.keys(cycle.allocations).length, i + 1);
      assert.equal(cycle.invocation!.ordinal, i + 1); assert.equal(cycle.invocation!.phase, "finished");
      assert.equal(cycle.reviewRounds, Math.floor((i + 1) / 2));
      assert.equal(cycle.noProgress, i === 3 ? 1 : 0);
      assert.equal(cycle.reworkReady, i === 2);
      assert.equal(cycle.pending, null); assert.equal(cycle.halted, null);
      assert.equal(cycle.lastState, targets[i]); assert.equal(s.api.state.status, targets[i]);
      const allocation = cycle.allocations[step.session!.sessionId!]!;
      assert.equal(allocation.authorizationId, authorization); assert.equal(allocation.ordinal, i + 1);
      assert.ok(allocation.resultId);
      const record = s.api.issueMessages().at(-1)!;
      assert.ok(record.body.includes(step.summary), "the complete final handoff stays on the issue");
      assert.ok(record.body.includes(`<!-- symphony-result:${allocation.resultId} -->`));
      assert.deepEqual(record.body.match(/^用量（本轮）：.*$/gm), [
        `用量（本轮）：${step.credits.toFixed(2)} · 轮次 ${i + 1}/20 · 模型：${step.model}`,
      ]);
      if (step.issuePlan) {
        const comments = s.api.issueMessages().filter((m) => m.body.startsWith(`${step.issuePlan!.body}\n\n`));
        assert.equal(comments.length, 1, "the scripted reread/reuse does not duplicate a persisted plan");
        const message = comments[0]!;
        assert.ok(message.body.includes(`<!-- symphony-invocation:${step.session!.sessionId} -->`));
        assert.doesNotMatch(message.body, /symphony-result:|用量（本轮）/, "formal handoff, not the earlier plan, receives final usage");
        preservedPlans.push(structuredClone(message));
        assert.deepEqual(step.actions, [
          "tracker_get_issue", "tracker_get_issue", "tracker_comment",
          ...(step.issuePlan.loseResponse ? ["tracker_get_issue"] : []),
          "product_write", "handoff_write", "tracker_submit_for_review",
        ]);
      } else {
        for (const message of preservedPlans) assert.ok(step.history.includes(message.body), "independent reviewer receives the full plan/revision");
        assert.deepEqual(step.actions, ["tracker_get_issue", "tracker_get_issue", "review_fixture_work", "tracker_submit_review"]);
      }
      for (const message of preservedPlans) assert.deepEqual(s.api.messages.get(message.id), message, "later usage and revisions never overwrite earlier plans");
      assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle);
    }
    assert.ok(s.steps[2]!.history.some((body) => body.includes(s.steps[1]!.reason) && body.includes(s.steps[1]!.nextStep) && body.includes(s.steps[1]!.blocker)));
    assert.ok(s.steps[2]!.history.includes(preservedPlans[0]!.body), "rework retains its original full plan alongside the review");
    assert.equal(s.steps[2]!.session!.workingDirectory, s.steps[0]!.session!.workingDirectory);
    assert.notEqual(s.steps[1]!.session!.sessionId, s.steps[0]!.session!.sessionId);
    assert.match(s.steps[3]!.prompt, /formally handed-off rework/);
    assert.deepEqual(s.workers.map((w) => w.params.role), ["implement", "review", "implement", "review"]);
    assert.deepEqual(s.api.transitions, ["In Progress", ...targets]);
    assert.equal(s.api.issueMessages().length, 6, "two plans plus four full results; no extra usage-only comments");
    assert.equal(s.api.calls.filter((c) => c.query.includes("addComment") && c.variables.id === issueId && c.variables.body.startsWith("## Implementation plan")).length, 2);
    assert.equal(s.api.calls.filter((c) => c.query.includes("updateIssueComment") && c.variables.body.includes("用量（本轮）")).length, 4);
    assert.equal(s.gitCalls.filter((c) => c.args[0] === "push").length, 2);
    assert.equal(s.api.reviews.length, 2);
    assert.equal(s.ledger.get(controlKey)!.aiCredits, 11);
    assert.equal(s.ledger.get(controlKey)!.totalAiCredits, 11);
    await s.orchestrator.stop();
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.counts, { start: 4, create: 4, created: 4, send: 4, metrics: 4, disconnect: 4, stop: 4, forceStop: 0, abort: 0 });
    t.diagnostic("Scripted SDK behavior only: plan -> fixture write -> handoff; persisted/lost comment reply -> scoped reread/reuse. Not host exactly-once recovery, an enforced write barrier or LLM planning-quality evidence.");
  });

  await t.test("formal implementation/review chain pauses after two no-progress reworks, then Todo grants one new session", async (t) => {
    const s = setup(t, runtime, [
      { role: "implement" }, { role: "review", progress: "initial" },
      { role: "implement" }, { role: "review", progress: "no_progress" },
      { role: "implement" }, { role: "review", progress: "no_progress" },
      { role: "implement", hold: true },
    ]);
    await s.orchestrator.start();
    await s.orchestrator.tick();
    const targets = ["AI Review", "Rework", "AI Review", "Rework", "AI Review", "Blocked"];
    const streaks = [0, 0, 0, 1, 1, 2];
    let authorization = "";
    for (let i = 0; i < 6; i++) {
      if (i > 0) {
        const retry = s.orchestrator.snapshot().retrying[0]!;
        assert.equal(Date.parse(retry.due_at!) - Date.now(), 1_000);
        t.mock.timers.tick(1_000);
      }
      await s.finish(i);
      const cycle = s.ledger.get(controlKey)!;
      authorization ||= cycle.authorizationId;
      assert.equal(cycle.authorizationId, authorization, "automatic role changes must not reauthorize");
      assert.equal(cycle.sessions, i + 1);
      assert.equal(cycle.reviewRounds, Math.floor((i + 1) / 2));
      assert.equal(cycle.noProgress, streaks[i]);
      assert.equal(cycle.reworkReady, i === 2 || i === 4, "only a formal implementation handoff readies rework");
      assert.equal(cycle.lastState, targets[i]);
      assert.equal(s.api.state.status, targets[i]);
      assert.equal(cycle.pending, null);
      assert.equal(cycle.invocation!.phase, "finished");
      assert.equal(cycle.halted?.reason ?? null, i === 5 ? "no_progress" : null);
      assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle, "real persisted ledger matches completed effects");
      const step = s.steps[i]!, record = s.api.issueMessages()[i]!;
      assert.ok(step.metricsRead);
      assert.ok(record.body.includes(step.summary), "complete, untruncated source evidence lives on the issue");
      assert.ok(record.body.includes(`Handoff completed: ${targets[i]}.`));
      const allocation = cycle.allocations[step.session!.sessionId!]!;
      assert.ok(record.body.includes(`<!-- symphony-result:${allocation.resultId} -->`));
      assert.ok(record.body.includes(`<!-- symphony-invocation:${step.session!.sessionId} -->`));
      const footer = `用量（本轮）：${step.credits.toFixed(2)} · 轮次 ${i + 1}/20 · 模型：${step.model}`;
      assert.deepEqual(record.body.match(/^用量（本轮）：.*$/gm), [footer]);
      assert.ok(record.body.replace(/<!--.*?-->/g, "").trimEnd().endsWith(footer));
      if (step.role === "review") {
        for (const text of [step.reason, step.nextStep, step.blocker, `**Progress: ${step.progress}**`]) assert.ok(record.body.includes(text));
        assert.match(step.prompt, step.progress === "initial" ? /initial review; use progress=initial/ : /formally handed-off rework/);
        const review = s.api.reviews[Math.floor(i / 2)]!;
        assert.ok(record.body.includes(`Reviewed HEAD: ${review.commit!.oid}`));
        const source = s.api.calls.findIndex((c) => c.query.includes("addComment") && c.variables.id === issueId && c.variables.body.includes(step.summary));
        const mirror = s.api.calls.findIndex((c) => c.query.includes("addPullRequestReview") && c.variables.body.includes(step.summary));
        assert.ok(source >= 0 && source < mirror, "issue record is published before its review mirror");
      }
      assert.equal(s.api.issueMessages().length, i + 1, "no separate usage-only comments");
    }
    const paused = structuredClone(s.ledger.get(controlKey)!);
    assert.equal(paused.waitingState, "Blocked");
    assert.equal(paused.aiCredits, 22.5);
    assert.equal(paused.totalAiCredits, 22.5);
    assert.deepEqual(s.api.transitions, ["In Progress", ...targets]);
    assert.equal(s.counts.created, 6);
    assert.equal(s.api.reviews.length, 3);
    assert.equal(s.api.prComments.length, 2);
    assert.equal(s.api.calls.filter((c) => c.query.includes("createPullRequest")).length, 1);
    assert.equal(s.api.calls.filter((c) => c.query.includes("updateIssueComment") && c.variables.body.includes("用量（本轮）")).length, 6);
    assert.equal(s.gitCalls.filter((c) => c.args[0] === "push").length, 3);
    assert.equal(s.gitCalls.filter((c) => c.args[0] === "merge-tree").length, 3);
    assert.deepEqual(s.orchestrator.snapshot().counts, { running: 0, retrying: 0 });
    t.mock.timers.tick(1_000);
    await s.orchestrator.tick();
    assert.equal(s.workers.length, 6, "Blocked must not start another worker");
    const history = s.api.issueMessages().map((m) => m.body);

    s.api.state.status = "Todo"; // Explicit human waiting -> start authorization, not a host status tool.
    await s.orchestrator.tick();
    await s.steps[6]!.sent.promise;
    const renewed = s.ledger.get(controlKey)!;
    assert.notEqual(renewed.authorizationId, authorization);
    assert.equal(renewed.sessions, 1);
    assert.equal(renewed.invocation!.ordinal, 1);
    assert.equal(renewed.invocation!.phase, "running");
    assert.equal(renewed.reviewRounds, 0);
    assert.equal(renewed.noProgress, 0);
    assert.equal(renewed.halted, null);
    assert.equal(renewed.aiCredits, 0);
    assert.equal(renewed.totalAiCredits, 22.5);
    assert.deepEqual(s.steps[6]!.history, history, "renewal preserves and pages the full six-result issue history");
    assert.deepEqual(s.api.issueMessages().map((m) => m.body), history);
    assert.equal(s.steps[6]!.session!.workingDirectory, s.steps[0]!.session!.workingDirectory);
    assert.notEqual(s.steps[1]!.session!.workingDirectory, s.steps[0]!.session!.workingDirectory);
    assert.equal(s.hooks.filter((h) => h.endsWith(":after_create")).length, 2, "reuse both role workspaces");
    for (const path of s.prepared) assert.ok(existsSync(path));
    assert.equal(Object.values(renewed.allocations).filter((a) => a.sessionId).length, 7);
    await s.orchestrator.stop();
    assert.equal(renewed.sessions, 1);
    assert.equal(renewed.aiCredits, 7.25);
    assert.equal(renewed.totalAiCredits, 29.75);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.counts, { start: 7, create: 7, created: 7, send: 7, metrics: 7, disconnect: 7, stop: 7, forceStop: 0, abort: 1 });
    assert.deepEqual(s.orchestrator.snapshot().counts, { running: 0, retrying: 0 });
    assert.equal(s.hooks.filter((h) => h.endsWith(":after_run")).length, 7);
    assert.equal(s.lines.filter((line) => line.includes("msg=\"session summary\"")).length, 7);
    assert.equal(s.api.issueMessages().length, 6, "stopping the held session creates no usage-only result");
    for (const step of s.steps) assert.equal(existsSync(step.session!.largeOutput!.outputDirectory!), false);
    t.diagnostic("6 started sessions, 3 reviews, 2 no-progress reworks, 6 full issue results/footers; Todo: 1/20 in a new authorization (7 total SDK sessions).");
  });

  await t.test("implementation metadata lag ends the accepted runner; host retry waits 60 seconds and starts only the next reviewer", async (t) => {
    const s = setup(t, runtime, [{ role: "implement", pendingHeadMismatch: true }, { role: "review", hold: true }]);
    const oldHead = "0".repeat(40), started = Date.now();
    s.api.state.delayPrHead = true;
    s.api.state.remoteHead = oldHead;
    s.api.state.pr = { id: "PR_1", number: 13, url: `https://github.invalid/${repo}/pull/13`, headRefOid: oldHead, body: "Existing PR" };
    await s.orchestrator.start();
    await s.orchestrator.tick();
    await s.finish(0);
    const cycle = s.ledger.get(controlKey)!, p = cycle.pending!;
    assert.ok(p, "worker exit must retain accepted publication, not schedule another implementer");
    const authorization = cycle.authorizationId, ref = p.issueMessage!, resultId = p.id;
    assert.equal(p.stale, false); assert.equal(p.pushed, true); assert.equal(p.statusApplied, false);
    assert.deepEqual(p.headMismatch, { attempts: 1, actualHead: oldHead, retryAt: started + 60_000 });
    assert.deepEqual(s.steps[0]!.submittedPending!.headMismatch, p.headMismatch, "worker-exit resume did not consume check two");
    assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle, "real disk state retains the retry gate");
    assert.equal(cycle.sessions, 1); assert.equal(cycle.reviewRounds, 0); assert.equal(cycle.noProgress, 0);
    assert.equal(s.api.state.status, "In Progress"); assert.equal(s.api.reviews.length, 0);
    assert.deepEqual(s.api.headReads.filter((r) => r.remoteHead === s.steps[0]!.head), [{ at: started, head: oldHead, remoteHead: s.steps[0]!.head }]);
    assert.equal(s.counts.created, 1); assert.equal(s.counts.send, 1);
    assert.equal(s.counts.disconnect, 1); assert.equal(s.counts.stop, 1);
    assert.deepEqual(s.orchestrator.snapshot().counts, { running: 0, retrying: 0 });
    assert.ok(s.lines.some((line) => line.includes("turn ended after result acceptance")), "runner drains an errored accepted turn without model continuation");
    const record = s.api.messages.get(ref.id)!;
    const footer = `用量（本轮）：${s.steps[0]!.credits.toFixed(2)} · 轮次 1/20 · 模型：${s.steps[0]!.model}`;
    assert.ok(record.body.includes(s.steps[0]!.summary)); assert.ok(record.body.includes(footer));
    assert.match(record.body, /Publication pending/); assert.doesNotMatch(record.body, /Stale result/);
    const headReads = s.api.headReads.length, gitCalls = s.gitCalls.length;
    await s.orchestrator.tick();
    t.mock.timers.tick(59_999);
    s.api.state.status = "AI Review"; // An external board workflow must not bypass the pending SHA check.
    s.api.state.pr!.headRefOid = s.steps[0]!.head;
    await s.orchestrator.tick();
    assert.equal(cycle.pending, p); assert.equal(p.headMismatch!.attempts, 1);
    assert.equal(s.api.headReads.length, headReads); assert.equal(s.gitCalls.length, gitCalls);
    assert.equal(s.workers.length, 1); assert.equal(s.counts.created, 1); assert.equal(s.counts.send, 1);
    assert.equal(s.api.issueMessages().length, 1); assert.equal(s.api.state.status, "AI Review");
    t.mock.timers.tick(1);
    await s.orchestrator.tick();
    assert.equal(s.api.state.status, "AI Review"); assert.equal(cycle.pending, null); assert.equal(cycle.halted, null);
    assert.equal(cycle.authorizationId, authorization); assert.equal(cycle.noProgress, 0); assert.equal(cycle.reviewRounds, 0);
    assert.equal(s.api.issueMessages().length, 1); assert.equal(s.api.issueMessages()[0]!.id, ref.id);
    assert.ok(record.body.includes(`<!-- symphony-result:${resultId} -->`));
    assert.ok(record.body.includes(s.steps[0]!.summary)); assert.ok(record.body.includes(footer));
    assert.match(record.body, /Handoff completed: AI Review/);
    assert.equal(s.gitCalls.filter((c) => c.args[0] === "push").length, 1);
    assert.equal(s.api.prComments.length, 1); assert.equal(s.api.reviews.length, 0);
    await s.orchestrator.tick();
    await s.steps[1]!.sent.promise;
    assert.deepEqual(s.workers.map((w) => w.params.role), ["implement", "review"]);
    assert.equal(cycle.sessions, 2); assert.equal(s.counts.created, 2); assert.equal(s.counts.send, 2);
    assert.deepEqual(s.steps[1]!.history, [record.body], "the reviewer reads the one original completed issue result");
    assert.equal(s.api.issueMessages().length, 1, "host retries and held review create no new messages");
    assert.deepEqual(s.api.transitions, ["In Progress"], "host does not repeat the external move to its intended target");
    assert.deepEqual(s.errors, []);
  });

  await t.test("persistent implementation metadata mismatch gets exactly three spaced host checks, Blocked and no extra SDK session", async (t) => {
    const s = setup(t, runtime, [{ role: "implement", pendingHeadMismatch: true }]);
    const oldHead = "0".repeat(40), started = Date.now();
    s.api.state.delayPrHead = true;
    s.api.state.remoteHead = oldHead;
    s.api.state.pr = { id: "PR_1", number: 13, url: `https://github.invalid/${repo}/pull/13`, headRefOid: oldHead, body: "Existing PR" };
    await s.orchestrator.start();
    await s.orchestrator.tick();
    await s.finish(0);
    const cycle = s.ledger.get(controlKey)!, p = cycle.pending!;
    assert.ok(p); assert.equal(p.headMismatch!.attempts, 1); assert.equal(p.stale, false);
    const ref = p.issueMessage!, authorization = cycle.authorizationId;
    assert.deepEqual(s.steps[0]!.submittedPending!.headMismatch, p.headMismatch);
    assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle);
    await s.orchestrator.tick();
    s.api.state.status = "AI Review"; // Auto-moved target still holds the pending result; no reviewer may run.
    t.mock.timers.tick(60_000);
    await s.orchestrator.tick();
    assert.equal(cycle.pending, p); assert.equal(p.stale, false);
    assert.deepEqual(p.headMismatch, { attempts: 2, actualHead: oldHead, retryAt: started + 120_000 });
    assert.equal(p.targetState, "AI Review"); assert.equal(p.haltReason, null);
    assert.equal(cycle.halted, null); assert.equal(cycle.sessions, 1); assert.equal(cycle.reviewRounds, 0); assert.equal(cycle.noProgress, 0);
    assert.equal(s.counts.created, 1); assert.equal(s.workers.length, 1); assert.equal(s.api.state.status, "AI Review");
    assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle);
    const checks = s.api.headReads.length;
    await s.orchestrator.tick();
    t.mock.timers.tick(59_999);
    await s.orchestrator.tick();
    assert.equal(p.headMismatch!.attempts, 2); assert.equal(s.api.headReads.length, checks);
    assert.equal(s.counts.created, 1); assert.equal(s.counts.send, 1);
    t.mock.timers.tick(1);
    await s.orchestrator.tick();
    assert.equal(p.headMismatch!.attempts, 3); assert.equal(p.stale, false); assert.equal(p.result.kind, "implement");
    assert.equal(p.targetState, "Blocked"); assert.equal(p.waitingState, "Blocked"); assert.equal(p.haltReason, "head_mismatch");
    assert.equal(cycle.pending, null); assert.equal(cycle.lastState, "Blocked"); assert.equal(cycle.waitingState, "Blocked");
    assert.equal(cycle.halted!.reason, "head_mismatch"); assert.equal(cycle.invocation!.phase, "finished");
    assert.equal(cycle.authorizationId, authorization); assert.equal(cycle.sessions, 1);
    assert.equal(cycle.reviewRounds, 0); assert.equal(cycle.noProgress, 0); assert.equal(cycle.lastSettledReworkId, null);
    assert.equal(cycle.reworkReady, false); assert.equal(Object.keys(cycle.allocations).length, 1);
    assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle);
    assert.deepEqual(s.api.headReads.filter((r) => r.remoteHead === s.steps[0]!.head).map((r) => r.at), [started, started + 60_000, started + 120_000]);
    const record = s.api.messages.get(ref.id)!;
    assert.ok(record.body.includes(s.steps[0]!.summary));
    assert.ok(record.body.includes(`<!-- symphony-result:${p.id} -->`));
    const status = record.body.split(`<!-- symphony-handoff:${p.id}:start -->`)[1]?.split(`<!-- symphony-handoff:${p.id}:end -->`)[0];
    assert.ok(status);
    for (const text of ["Blocked", s.steps[0]!.head, oldHead, "3"]) assert.ok(status.includes(text), `missing host diagnostic: ${text}`);
    assert.match(status, /expected/i); assert.match(status, /actual/i); assert.match(status, /attempt|check/i);
    assert.doesNotMatch(record.body, /Stale result|\*\*Progress:|Reviewed HEAD:/);
    assert.deepEqual(record.body.match(/^用量（本轮）：.*$/gm), [`用量（本轮）：1.25 · 轮次 1/20 · 模型：${s.steps[0]!.model}`]);
    const finalReads = s.api.headReads.length;
    t.mock.timers.tick(60_000);
    await s.orchestrator.tick();
    assert.equal(s.api.headReads.length, finalReads); assert.equal(s.workers.length, 1);
    assert.equal(s.api.issueMessages().length, 1); assert.equal(s.api.issueMessages()[0]!.id, ref.id);
    assert.equal(s.api.reviews.length, 0); assert.equal(s.api.prComments.length, 0);
    assert.equal(s.gitCalls.filter((c) => c.args[0] === "push").length, 1);
    assert.deepEqual(s.api.transitions, ["In Progress", "Blocked"]);
    assert.deepEqual(s.orchestrator.snapshot().counts, { running: 0, retrying: 0 });
    assert.deepEqual(s.counts, { start: 1, create: 1, created: 1, send: 1, metrics: 1, disconnect: 1, stop: 1, forceStop: 0, abort: 1 });
    assert.deepEqual(s.errors, []);
  });

  await t.test("real runner createSession failure blocks without a quota charge or automatic retry", async (t) => {
    const s = setup(t, runtime, [{ role: "implement", failCreate: true }]);
    await s.orchestrator.start();
    await s.orchestrator.tick();
    await s.finish(0, true);
    const cycle = s.ledger.get(controlKey)!;
    assert.equal(s.api.state.status, "Blocked");
    assert.equal(cycle.sessions, 0);
    assert.equal(cycle.reviewRounds, 0);
    assert.equal(cycle.noProgress, 0);
    assert.equal(cycle.aiCredits, 0);
    assert.equal(cycle.totalAiCredits, 0);
    assert.equal(cycle.invocation!.sessionId, null);
    assert.equal(cycle.invocation!.phase, "finished");
    assert.match(cycle.halted!.reason, /startup_failed \(session_create\).*offline createSession rejection/);
    assert.equal(cycle.waitingState, "Blocked");
    assert.equal(cycle.pending, null);
    assert.deepEqual(new RunLedger(s.ledger.path!).get(controlKey), cycle);
    assert.equal(s.api.issueMessages().length, 1);
    assert.match(s.api.issueMessages()[0]!.body, /session_create[\s\S]*offline createSession rejection[\s\S]*0 session\(s\)/);
    assert.doesNotMatch(s.api.issueMessages()[0]!.body, /用量（本轮）/);
    t.mock.timers.tick(1_000);
    await s.orchestrator.tick();
    await s.orchestrator.stop();
    assert.equal(s.workers.length, 1);
    assert.equal(s.api.state.pr, null);
    assert.equal(s.api.reviews.length, 0);
    assert.equal(s.gitCalls.length, 0);
    assert.deepEqual(s.orchestrator.snapshot().counts, { running: 0, retrying: 0 });
    assert.deepEqual(s.counts, { start: 1, create: 1, created: 0, send: 0, metrics: 0, disconnect: 0, stop: 1, forceStop: 0, abort: 0 });
    assert.equal(existsSync(s.steps[0]!.session!.largeOutput!.outputDirectory!), false);
    t.diagnostic("1 startup attempt, 0 started sessions, 0 credits, 1 meaningful failure record, no retry.");
  });
});
