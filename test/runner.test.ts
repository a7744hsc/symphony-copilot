import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { CopilotClient, type CopilotSession, type PermissionRequest, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import type { Role } from "../src/config.ts";
import { ExecError, run } from "../src/exec.ts";
import { runAgentAttempt, RunError, type AgentUpdate, type AttemptParams, type RunErrorCode } from "../src/runner.ts";
import type { AgentControl } from "../src/tracker/types.ts";
import { WorkspaceManager, workspacePath } from "../src/workspace.ts";
import { captureLog, flush, makeConfig, makeIssue } from "./helpers.ts";

type Emit = (type: SessionEvent["type"], data?: object) => void;
interface Behavior {
  start?(): void | Promise<void>;
  create?(config: SessionConfig): void | Promise<void>;
  turn?(config: SessionConfig, emit: Emit): void | Promise<void>;
  abort?(): void | Promise<void>;
  disconnect?(config: SessionConfig): void | Promise<void>;
  metrics?(): Promise<any>;
  stop?(config: SessionConfig | undefined): Error[] | Promise<Error[]>;
  forceStop?(): void | Promise<void>;
}

/** The real SDK constructor is inert; every method that can start or contact a runtime is mocked. */
function setup(t: TestContext, role: Role = "implement") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "runner-test-")));
  const outputDirectories: string[] = [];
  t.after(() => {
    for (const directory of outputDirectories) rmSync(directory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const config = makeConfig({
    workspace: { root: join(root, "workspaces") },
    agent: { max_turns: 1 },
    copilot: { read_allow: [join(root, "reference")], startup_timeout_ms: 1000, turn_timeout_ms: 1000 },
    tracker: { active_states: ["Todo", "In Progress", "Rework", "AI Review"], provider: { handoff_state: role === "review" ? "AI Review" : "Human Review" } },
    review: role === "review" ? {
      states: ["AI Review"], prompt_file: join(root, "REVIEW.md"), pass_state: "Human Review", fail_state: "Rework",
    } : undefined,
  });
  mkdirSync(config.copilot.readAllow[0]!);
  writeFileSync(join(root, "REVIEW.md"), "Review {{ issue.identifier }}");
  const { log, lines } = captureLog();
  const controller = new AbortController();
  const events: string[] = [];
  const prompts: string[] = [];
  const updates: AgentUpdate[] = [];
  const sessions: SessionConfig[] = [];
  const configByClient = new Map<CopilotClient, SessionConfig>();
  const behavior: Behavior = {};
  const originalMkdtemp = fs.mkdtemp;
  t.mock.method(fs, "mkdtemp", async (prefix: string) => {
    const directory = await originalMkdtemp(prefix);
    outputDirectories.push(realpathSync(directory));
    return directory;
  });
  t.mock.method(CopilotClient.prototype, "start", async () => {
    events.push("start");
    await behavior.start?.();
  });
  t.mock.getter(CopilotClient.prototype, "rpc", () => ({
    account: { getQuota: async () => ({ quotaSnapshots: {} }) },
  }));
  t.mock.method(CopilotClient.prototype, "createSession", async function (this: CopilotClient, sessionConfig: SessionConfig) {
    events.push("create");
    sessions.push(sessionConfig);
    configByClient.set(this, sessionConfig);
    await behavior.create?.(sessionConfig);
    const listeners = new Set<(event: SessionEvent) => void>();
    const emit: Emit = (type, data = {}) => {
      for (const listener of listeners) listener({ type, data } as SessionEvent);
    };
    return {
      sessionId: `session-${sessions.length}`,
      on(listener: (event: SessionEvent) => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      async send({ prompt }: { prompt: string }) {
        events.push("send");
        prompts.push(prompt);
        if (behavior.turn) await behavior.turn(sessionConfig, emit);
        else emit("session.idle");
        return "message-1";
      },
      async abort() { events.push("abort"); await behavior.abort?.(); },
      async disconnect() {
        events.push("disconnect");
        await behavior.disconnect?.(sessionConfig);
      },
      rpc: {
        usage: { getMetrics: async () => behavior.metrics ? behavior.metrics() : null },
        ui: { handlePendingSessionLimitsExhausted: async () => {} },
      },
    } as unknown as CopilotSession;
  });
  t.mock.method(CopilotClient.prototype, "stop", async function (this: CopilotClient) {
    events.push("stop");
    return behavior.stop ? await behavior.stop(configByClient.get(this)) : [];
  });
  t.mock.method(CopilotClient.prototype, "forceStop", async () => {
    events.push("forceStop");
    await behavior.forceStop?.();
  });
  const workspaces = new WorkspaceManager(log, {});
  t.mock.method(workspaces, "hook", async (_config: unknown, name: string) => {
    if (name === "after_run") events.push(name);
  });
  const params: AttemptParams = {
    config, role, workspaces, log, signal: controller.signal,
    issue: makeIssue({ state: role === "review" ? "AI Review" : "Todo" }),
    attempt: null, promptTemplate: "Work on {{ issue.identifier }}", childEnv: {}, onUpdate(update) { updates.push(update); },
    tracker: {
      kind: "fake", agentTools: () => [], secretEnvironmentNames: () => [],
      fetchIssuesByIds: async () => [], fetchIssuesByStates: async () => [],
    },
  };
  return { params, config, controller, root, outputDirectories, sessions, events, behavior, lines, prompts, updates };
}

function outputDirectory(config: SessionConfig): string {
  assert.ok(config.largeOutput?.outputDirectory);
  return config.largeOutput.outputDirectory;
}

const read = (path: string) => ({ kind: "read", path, intention: "Inspect output" }) as PermissionRequest;
const write = (fileName: string) => ({ kind: "write", fileName, diff: "", intention: "Change output", canOfferSessionApproval: false }) as PermissionRequest;
function shell(path: string, cwd: string, readOnly = true, redirection = false): PermissionRequest {
  const identifier = readOnly ? "cat" : "rm";
  const fullCommandText = `${identifier} ${path}`;
  return {
    kind: "shell", fullCommandText, intention: "Inspect output", canOfferSessionApproval: false,
    commands: [{ identifier, readOnly }], commandSegments: [{ identifier, fullCommandText }],
    possiblePaths: [path], possibleUrls: [], resolvedWorkingDirectory: cwd, hasWriteFileRedirection: redirection,
  } as PermissionRequest;
}
async function permission(config: SessionConfig, request: PermissionRequest) {
  assert.ok(config.onPermissionRequest);
  return (await config.onPermissionRequest(request, { sessionId: "fake-session" })).kind;
}
const hasCode = (code: RunErrorCode) => (error: unknown) => error instanceof RunError && error.code === code;

for (const role of ["implement", "review"] as const) {
  test(`${role} session spills large output into its private, canonical, read-only directory`, async (t) => {
    const s = setup(t, role);
    const originalReadAllow = [...s.config.copilot.readAllow];
    let outputFile = "";
    s.behavior.turn = async (config, emit) => {
      const directory = outputDirectory(config);
      const cwd = config.workingDirectory!;
      assert.equal(config.largeOutput!.enabled, true);
      assert.equal(config.largeOutput!.maxSizeBytes, 51_200);
      assert.equal(directory, realpathSync(directory));
      assert.equal(dirname(directory), realpathSync(tmpdir()));
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.ok(!directory.startsWith(s.config.workspace.root + "/"));

      // Simulate the runtime's spill, not an agent-authorized write or a real model call.
      const content = "x".repeat(config.largeOutput!.maxSizeBytes! + 1);
      outputFile = join(directory, "tool-output.txt");
      writeFileSync(outputFile, content);
      assert.ok(statSync(outputFile).size > config.largeOutput!.maxSizeBytes!);
      assert.equal(await permission(config, read(outputFile)), "approve-once");
      assert.equal(await permission(config, shell(outputFile, cwd)), "approve-once");
      assert.equal(readFileSync(outputFile, "utf8"), content);
      assert.equal(await permission(config, write(outputFile)), "reject");
      assert.equal(await permission(config, shell(outputFile, cwd, false)), "reject");
      assert.equal(await permission(config, shell(outputFile, cwd, true, true)), "reject");

      for (const outside of [dirname(directory), join(s.root, "ungranted.txt"), `${directory}-other/output.txt`]) {
        assert.equal(await permission(config, read(outside)), "reject");
        assert.equal(await permission(config, shell(outside, cwd)), "reject");
        assert.equal(await permission(config, write(outside)), "reject");
        assert.equal(await permission(config, shell(outside, cwd, false)), "reject");
      }
      assert.equal(await permission(config, read(join(originalReadAllow[0]!, "reference.txt"))), "approve-once");
      assert.equal(await permission(config, write(join(cwd, "own.txt"))), "approve-once");
      if (role === "review") {
        const evidence = join(workspacePath(s.config.workspace.root, s.params.issue.identifier), "evidence.txt");
        assert.equal(await permission(config, read(evidence)), "approve-once");
        assert.equal(await permission(config, shell(evidence, cwd)), "approve-once");
        assert.equal(await permission(config, write(evidence)), "reject");
        assert.equal(await permission(config, shell(evidence, cwd, false)), "reject");
      }
      emit("session.idle");
    };
    s.behavior.disconnect = () => { assert.ok(existsSync(outputFile)); };
    s.behavior.stop = () => {
      assert.ok(existsSync(outputFile), "retain output until the runtime has stopped");
      return [];
    };
    await runAgentAttempt(s.params);
    assert.deepEqual(s.events, ["start", "create", "send", "disconnect", "stop", "after_run"]);
    assert.deepEqual(s.config.copilot.readAllow, originalReadAllow, "do not leak the grant into later sessions");
    assert.equal(s.outputDirectories.length, 1);
    assert.equal(existsSync(s.outputDirectories[0]!), false);
  });
}

test("simultaneous attempts have unique directories and cannot read or remove each other's output", async (t) => {
  const s = setup(t);
  const ready = [Promise.withResolvers<SessionConfig>(), Promise.withResolvers<SessionConfig>()];
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let next = 0;
  s.behavior.turn = async (config, emit) => {
    const index = next++;
    writeFileSync(join(outputDirectory(config), "output.txt"), `session ${index}`);
    ready[index]!.resolve(config);
    await release[index]!.promise;
    emit("session.idle");
  };
  const attempts: Promise<void>[] = [];
  try {
    attempts.push(runAgentAttempt(s.params));
    const first = await ready[0]!.promise;
    attempts.push(runAgentAttempt({ ...s.params, attempt: 2 }));
    const second = await ready[1]!.promise;
    assert.notEqual(outputDirectory(first), outputDirectory(second));
    for (const [own, other] of [[first, second], [second, first]]) {
      const otherFile = join(outputDirectory(other!), "output.txt");
      assert.equal(await permission(own!, read(otherFile)), "reject");
      assert.equal(await permission(own!, shell(otherFile, own!.workingDirectory!)), "reject");
      assert.equal(await permission(own!, write(otherFile)), "reject");
      assert.equal(await permission(own!, shell(otherFile, own!.workingDirectory!, false)), "reject");
    }
    release[0]!.resolve();
    await attempts[0];
    assert.equal(existsSync(outputDirectory(first)), false);
    assert.equal(readFileSync(join(outputDirectory(second), "output.txt"), "utf8"), "session 1");
    release[1]!.resolve();
    await attempts[1];
    assert.equal(existsSync(outputDirectory(second)), false);
  } finally {
    for (const gate of release) gate.resolve();
    await Promise.allSettled(attempts);
  }
});

test("reviewer scratch regression uses the approved test entry point without granting interpreters", async (t) => {
  const s = setup(t, "review");
  s.config.copilot.turnTimeoutMs = 10_000;
  s.config.copilot.shellAllow.push("npm test");
  const originalAllow = [...s.config.copilot.shellAllow];
  s.behavior.turn = async (config, emit) => {
    const cwd = config.workingDirectory!;
    const command = (text: string, identifier: string): PermissionRequest => ({
      kind: "shell", fullCommandText: text, intention: "Verify a counterexample", canOfferSessionApproval: false,
      commands: [{ identifier, readOnly: false }], commandSegments: [{ identifier, fullCommandText: text }],
      possiblePaths: [], possibleUrls: [], resolvedWorkingDirectory: cwd, hasWriteFileRedirection: false,
    });
    // The fixture represents an existing project/test command; the reviewer adds only a new test.
    const implementation = 'export const isolated = (a: string, b: string) => a !== b;\n';
    const manifest = JSON.stringify({ type: "module", scripts: { test: 'node --test "test/**/*.test.ts"' } });
    writeFileSync(join(cwd, "subject.ts"), implementation);
    writeFileSync(join(cwd, "package.json"), manifest);
    mkdirSync(join(cwd, "test"));
    const probe = join(cwd, "test", "review-probe-overlap.test.ts");
    assert.equal(await permission(config, write(probe)), "approve-once");
    assert.equal(await permission(config, write(join(workspacePath(s.config.workspace.root, s.params.issue.identifier), "test", "probe.test.ts"))), "reject");
    writeFileSync(probe, 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { isolated } from "../subject.ts";\ntest("parent and child are not isolated", () => assert.equal(isolated("/state", "/state/child"), false));\n');
    assert.equal(await permission(config, command("npm test", "npm")), "approve-once");
    for (const [text, identifier] of [["node -e 'process.exit()'", "node"], ["node --test", "node"], ["bash -c true", "bash"], ["npm install", "npm"]]) {
      assert.equal(await permission(config, command(text!, identifier!)), "reject");
    }
    const childEnv = { ...process.env };
    // The probe is an independent test run, not another worker of this node:test invocation.
    delete childEnv.NODE_TEST_CONTEXT;
    await assert.rejects(run("npm", ["test"], { cwd, env: childEnv }), (error: unknown) => {
      assert.ok(error instanceof ExecError);
      assert.equal(error.exitCode, 1);
      assert.match(error.stdout, /parent and child are not isolated/);
      return true;
    });
    rmSync(probe);
    assert.equal(existsSync(probe), false);
    assert.equal(readFileSync(join(cwd, "subject.ts"), "utf8"), implementation);
    assert.equal(readFileSync(join(cwd, "package.json"), "utf8"), manifest);
    emit("session.idle");
  };
  await runAgentAttempt(s.params);
  assert.deepEqual(s.config.copilot.shellAllow, originalAllow);
});

for (const [phase, code] of [
  ["start", "startup_failed"], ["create", "startup_failed"], ["send", "response_error"],
  ["turn", "turn_failed"], ["cancel", "canceled"], ["aborted-turn", "turn_cancelled"],
  ["cancel-start", "canceled"], ["cancel-create", "canceled"],
] as const) {
  test(`${phase} failure stops the runtime before removing the output directory`, async (t) => {
    const s = setup(t);
    const fail = () => { throw new Error(`${phase} failed`); };
    if (phase === "start") s.behavior.start = fail;
    else if (phase === "create") s.behavior.create = fail;
    else if (phase === "send") s.behavior.turn = fail;
    else if (phase === "turn") s.behavior.turn = (_config, emit) => { emit("session.error", { message: "turn failed" }); };
    else if (phase === "aborted-turn") s.behavior.turn = (_config, emit) => { emit("session.idle", { aborted: true }); };
    else if (phase === "cancel-start") s.behavior.start = () => { s.controller.abort("stop"); };
    else if (phase === "cancel-create") s.behavior.create = () => { s.controller.abort("stop"); };
    else s.behavior.turn = () => { s.controller.abort("stop"); };
    s.behavior.stop = () => {
      assert.equal(s.outputDirectories.length, 1);
      assert.ok(existsSync(s.outputDirectories[0]!));
      return [];
    };
    await assert.rejects(runAgentAttempt(s.params), hasCode(code));
    assert.equal(s.events.includes("disconnect"), !["start", "create", "cancel-start"].includes(phase));
    assert.deepEqual(s.events.slice(-2), ["stop", "after_run"]);
    assert.equal(existsSync(s.outputDirectories[0]!), false);
  });
}

test("a pre-aborted attempt creates no output directory and starts no runtime", async (t) => {
  const s = setup(t);
  s.controller.abort("already canceled");
  await assert.rejects(runAgentAttempt(s.params), hasCode("canceled"));
  assert.deepEqual(s.outputDirectories, []);
  assert.deepEqual(s.events, ["after_run"]);
});

for (const operation of ["realpath", "chmod"] as const) {
  test(`output ${operation} failure removes the newly created directory without starting a runtime`, async (t) => {
    const s = setup(t);
    t.mock.method(fs, operation, async () => { throw new Error(`${operation} failed`); });
    await assert.rejects(runAgentAttempt(s.params), hasCode("startup_failed"));
    assert.equal(s.outputDirectories.length, 1);
    assert.equal(existsSync(s.outputDirectories[0]!), false);
    assert.deepEqual(s.events, ["after_run"]);
  });
}

test("a temp directory inside the workspace root fails closed instead of becoming writable output", async (t) => {
  const s = setup(t);
  t.mock.method(fs, "mkdtemp", async () => {
    const directory = mkdtempSync(join(s.config.workspace.root, "bad-tmpdir-"));
    s.outputDirectories.push(directory);
    return directory;
  });
  await assert.rejects(runAgentAttempt(s.params), /session output directory must be outside the workspace root/);
  assert.equal(existsSync(s.outputDirectories[0]!), false);
  assert.deepEqual(s.events, ["after_run"]);
});

test("output survives pending disconnect and stop promises, then is removed", async (t) => {
  const s = setup(t);
  const disconnecting = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  s.behavior.disconnect = async () => { disconnecting.resolve(); await disconnected.promise; };
  s.behavior.stop = async () => { stopping.resolve(); await stopped.promise; return []; };
  const attempt = runAgentAttempt(s.params);
  try {
    await disconnecting.promise;
    assert.ok(existsSync(s.outputDirectories[0]!));
    assert.equal(s.events.includes("stop"), false);
    disconnected.resolve();
    await stopping.promise;
    assert.ok(existsSync(s.outputDirectories[0]!));
    stopped.resolve();
    await attempt;
    assert.equal(existsSync(s.outputDirectories[0]!), false);
  } finally {
    disconnected.resolve();
    stopped.resolve();
    await attempt;
  }
});

for (const failure of ["returned-errors", "rejection", "timeout"] as const) {
  test(`stop ${failure} triggers forceStop and keeps output until it finishes`, async (t) => {
    const s = setup(t);
    const stopping = Promise.withResolvers<void>();
    const forcing = Promise.withResolvers<void>();
    const forced = Promise.withResolvers<void>();
    if (failure === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    s.behavior.stop = async () => {
      assert.ok(existsSync(s.outputDirectories[0]!));
      stopping.resolve();
      if (failure === "timeout") return new Promise<Error[]>(() => {});
      if (failure === "rejection") throw new Error("stop rejected");
      return [new Error("disconnect failed"), new Error("shutdown failed")];
    };
    s.behavior.forceStop = async () => {
      assert.ok(existsSync(s.outputDirectories[0]!));
      forcing.resolve();
      await forced.promise;
    };
    const attempt = runAgentAttempt(s.params);
    try {
      await stopping.promise;
      if (failure === "timeout") t.mock.timers.tick(10_000);
      await forcing.promise;
      assert.ok(existsSync(s.outputDirectories[0]!));
      forced.resolve();
      await attempt;
      assert.equal(existsSync(s.outputDirectories[0]!), false);
      assert.deepEqual(s.events.slice(-4), ["disconnect", "stop", "forceStop", "after_run"]);
      assert.ok(s.lines.some((line) => line.includes("copilot runtime did not stop cleanly; forcing")));
      if (failure === "returned-errors") {
        assert.ok(s.lines.some((line) => line.includes("disconnect failed; shutdown failed")));
      }
    } finally {
      forced.resolve();
      await attempt;
    }
  });
}

test("disconnect and forceStop failures are logged without replacing the turn error or skipping removal", async (t) => {
  const s = setup(t);
  s.behavior.turn = (_config, emit) => { emit("session.error", { message: "original turn failure" }); };
  s.behavior.disconnect = () => { throw new Error("disconnect rejected"); };
  s.behavior.stop = () => [new Error("stop failed")];
  s.behavior.forceStop = () => { throw new Error("force stop rejected"); };
  await assert.rejects(runAgentAttempt(s.params), /turn_failed: original turn failure/);
  assert.equal(existsSync(s.outputDirectories[0]!), false);
  assert.ok(s.lines.some((line) => line.includes("copilot session disconnect failed") && line.includes("disconnect rejected")));
  assert.ok(s.lines.some((line) => line.includes("copilot runtime force stop failed") && line.includes("force stop rejected")));
});

for (const phase of ["metrics", "disconnect", "forceStop"] as const) {
  test(`a stalled ${phase} cannot indefinitely retain session output`, async (t) => {
    const s = setup(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = Promise.withResolvers<void>();
    const hang = () => { pending.resolve(); return new Promise<never>(() => {}); };
    if (phase === "metrics") s.behavior.metrics = hang;
    else if (phase === "disconnect") s.behavior.disconnect = hang;
    else {
      s.behavior.stop = () => [new Error("stop failed")];
      s.behavior.forceStop = hang;
    }
    const attempt = runAgentAttempt(s.params);
    await pending.promise;
    assert.ok(existsSync(s.outputDirectories[0]!));
    t.mock.timers.tick(10_000);
    await attempt;
    assert.equal(existsSync(s.outputDirectories[0]!), false);
    assert.equal(s.events.at(-1), "after_run");
    if (phase !== "metrics") assert.ok(s.lines.some((line) => line.includes(phase) && line.includes("took longer than")));
  });
}

for (const failedTurn of [false, true]) {
  test(`removal failure is logged without changing a ${failedTurn ? "failed" : "successful"} attempt`, async (t) => {
    const s = setup(t);
    if (failedTurn) s.behavior.turn = (_config, emit) => { emit("session.error", { message: "original turn failure" }); };
    t.mock.method(fs, "rm", async () => {
      assert.equal(s.events.at(-1), "stop");
      throw new Error("output removal denied");
    });
    if (failedTurn) await assert.rejects(runAgentAttempt(s.params), /turn_failed: original turn failure/);
    else await runAgentAttempt(s.params);
    assert.ok(existsSync(s.outputDirectories[0]!), "the test teardown removes the deliberately retained directory");
    assert.ok(s.lines.some((line) => line.includes("session output cleanup failed") && line.includes("output removal denied") && line.includes(s.outputDirectories[0]!)));
    assert.equal(s.events.at(-1), "after_run");
  });
}

test("a usage observer failure still disconnects, stops and removes session output", async (t) => {
  const s = setup(t);
  s.params.onUpdate = (update) => {
    if (update.event === "session_usage") throw new Error("usage observer failed");
  };
  await assert.rejects(runAgentAttempt(s.params), /usage observer failed/);
  assert.deepEqual(s.events.slice(-3), ["disconnect", "stop", "after_run"]);
  assert.equal(existsSync(s.outputDirectories[0]!), false);
});

function runnerControl(): { control: AgentControl; state: { accepted: boolean; confirmed: string[] } } {
  const state = { accepted: false, confirmed: [] as string[] };
  const control: AgentControl = {
    id: "host-invocation", initialReview: true, assertActive() {}, accepted: () => state.accepted,
    async onSessionCreated(id) { state.confirmed.push(id); return 7; },
    async accept() { throw new Error("not used by this runner fixture"); }, checkpoint() {}, finish() {}, onIssueMessage() {},
  };
  return { control, state };
}

test("host session identity is passed to creation and durable confirmation completes before first send", async (t) => {
  const s = setup(t), host = runnerControl(), confirming = Promise.withResolvers<void>(), confirmed = Promise.withResolvers<number>();
  s.params.control = host.control;
  host.control.onSessionCreated = async (id) => { host.state.confirmed.push(id); confirming.resolve(); return confirmed.promise; };
  const attempt = runAgentAttempt(s.params);
  await confirming.promise;
  assert.equal(s.sessions[0]!.sessionId, host.control.id);
  assert.equal(s.sessions[0]!.sessionLimits, undefined);
  assert.equal(s.events.includes("send"), false);
  assert.equal(s.updates.some((u) => u.event === "session_started"), false);
  confirmed.resolve(7);
  await attempt;
  assert.deepEqual(host.state.confirmed, ["session-1"]);
  assert.equal(s.events.filter((e) => e === "send").length, 1);
  assert.equal(s.updates.filter((u) => u.event === "session_started").length, 1);
});

test("confirmation persistence failure cleans up without sending; first send failure was already confirmed", async (t) => {
  const s = setup(t), host = runnerControl(); s.params.control = host.control;
  host.control.onSessionCreated = async () => { throw new Error("ledger failed"); };
  await assert.rejects(runAgentAttempt(s.params), /ledger failed/);
  assert.equal(s.events.includes("send"), false);
  assert.ok(s.events.includes("disconnect"));
  host.control.onSessionCreated = async (id) => { host.state.confirmed.push(id); return 1; };
  s.behavior.turn = () => { throw new Error("first request failed"); };
  await assert.rejects(runAgentAttempt(s.params), /first request failed/);
  assert.deepEqual(host.state.confirmed, ["session-2"]);
});

for (const phase of ["start", "create"] as const) {
  for (const cancel of [false, true]) {
    test(`${phase} ${cancel ? "cancellation" : "timeout"} retains late resolution, never sends and cleans up the late runtime/session`, async (t) => {
      const s = setup(t), host = runnerControl(); s.params.control = host.control;
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      s.behavior[phase] = async () => { entered.resolve(); await release.promise; };
      const attempt = runAgentAttempt(s.params);
      const outcome = assert.rejects(attempt, hasCode(cancel ? "canceled" : "response_timeout"));
      await entered.promise;
      if (cancel) s.controller.abort("stop during startup"); else t.mock.timers.tick(1000);
      await flush();
      assert.ok(s.updates.some((u) => u.event === "startup_uncertain"));
      assert.equal(s.updates.some((u) => u.event === "startup_settled"), false, "normal stop is not proof while the RPC is unresolved");
      assert.equal(s.events.includes("send"), false);
      release.resolve();
      await outcome;
      assert.equal(s.events.includes("send"), false);
      assert.equal(existsSync(s.outputDirectories[0]!), false);
      assert.equal(s.updates.filter((u) => u.event === "startup_settled").length, 1);
      if (phase === "create") {
        assert.deepEqual(host.state.confirmed, ["session-1"]);
        assert.ok(s.updates.some((u) => u.event === "session_created_late" && u.sessionId === "session-1"));
        assert.ok(s.events.includes("abort") && s.events.includes("disconnect"));
      } else {
        assert.deepEqual(host.state.confirmed, []);
        assert.equal(s.events.includes("create"), false);
      }
    });
  }
}

test("unresolved create cleanup is bounded, and success arriving after attempt exit is still disconnected", async (t) => {
  const s = setup(t), host = runnerControl(); s.params.control = host.control;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  s.behavior.create = async () => { entered.resolve(); await release.promise; };
  const attempt = runAgentAttempt(s.params), outcome = assert.rejects(attempt, hasCode("response_timeout"));
  await entered.promise; t.mock.timers.tick(1000); await flush();
  t.mock.timers.tick(10_000); await outcome;
  assert.match(s.lines.join("\n"), /startup remains uncertain/);
  assert.equal(s.events.includes("disconnect"), false);
  release.resolve(); await flush();
  assert.ok(s.events.includes("disconnect"));
  assert.deepEqual(host.state.confirmed, ["session-1"]);
  assert.equal(s.events.includes("send"), false);
});

for (const phase of ["start", "create"] as const) {
  test(`late ${phase} rejection after attempt exit still stops the runtime and acknowledges cleanup once`, async (t) => {
    const s = setup(t), host = runnerControl(); s.params.control = host.control;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), settled = Promise.withResolvers<void>();
    s.behavior[phase] = async () => { entered.resolve(); await release.promise; };
    s.params.onUpdate = (u) => { s.updates.push(u); if (u.event === "startup_settled") settled.resolve(); };
    const outcome = assert.rejects(runAgentAttempt(s.params), hasCode("response_timeout"));
    await entered.promise;
    t.mock.timers.tick(1000); await flush();
    t.mock.timers.tick(10_000); await outcome;
    assert.equal(s.events.filter((e) => e === "stop").length, 1);
    assert.equal(s.updates.some((u) => u.event === "startup_settled"), false);
    release.reject(new Error("late RPC rejected"));
    await settled.promise;
    assert.equal(s.events.filter((e) => e === "stop").length, 2);
    assert.equal(s.updates.filter((u) => u.event === "startup_settled").length, 1);
    assert.deepEqual(host.state.confirmed, []);
    assert.equal(s.events.includes("send"), false);
  });
}

for (const failure of ["abort", "disconnect", "forceStop", "none"] as const) {
  test(`late creation ${failure === "none" ? "with positive cleanup" : `with failed ${failure}`} ${failure === "none" ? "acknowledges" : "does not acknowledge"} startup settlement`, async (t) => {
    const s = setup(t), host = runnerControl(); s.params.control = host.control;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    s.behavior.create = async () => { entered.resolve(); await release.promise; };
    host.control.onSessionCreated = async (id) => {
      host.state.confirmed.push(id);
      throw new Error("invocation is no longer active"); // Confirmation persisted before assertActive rejected.
    };
    if (failure === "abort") s.behavior.abort = () => { throw new Error("session nonexistent is not cleanup proof"); };
    if (failure === "disconnect") s.behavior.disconnect = () => { throw new Error("disconnect failed"); };
    if (failure === "forceStop" || failure === "none") {
      s.behavior.stop = () => [new Error("stop failed")];
      if (failure === "forceStop") s.behavior.forceStop = () => { throw new Error("force stop failed"); };
    }
    const outcome = assert.rejects(runAgentAttempt(s.params), hasCode("response_timeout"));
    await entered.promise; t.mock.timers.tick(1000); await flush();
    assert.equal(s.updates.some((u) => u.event === "startup_settled"), false);
    release.resolve(); await outcome;
    assert.deepEqual(host.state.confirmed, ["session-1"], "raw SDK success is charged exactly once even when halted");
    assert.equal(s.events.filter((e) => e === "abort").length, 1);
    assert.equal(s.events.filter((e) => e === "disconnect").length, 1);
    assert.equal(s.updates.filter((u) => u.event === "startup_settled").length, failure === "none" ? 1 : 0);
    assert.equal(s.events.includes("send"), false);
  });
}

for (const failTurn of [false, true]) {
  test(`accepted handoff stops continuation and avoids tracker refresh even when ${failTurn ? "the provider fails" : "the card still appears active"}`, async (t) => {
    const s = setup(t), host = runnerControl(); s.params.control = host.control;
    s.config.agent.maxTurns = 4;
    s.params.tracker.fetchIssuesByIds = async () => { throw new Error("refresh must not run"); };
    s.behavior.turn = (_config, emit) => {
      host.state.accepted = true;
      emit(failTurn ? "session.error" : "session.idle", failTurn ? { message: "provider failed after tool" } : {});
    };
    await runAgentAttempt(s.params);
    assert.equal(s.events.filter((e) => e === "send").length, 1);
  });
}

test("acceptance during a pending failed refresh or immediately before send cannot cause another prompt", async (t) => {
  const s = setup(t), host = runnerControl(); s.params.control = host.control; s.config.agent.maxTurns = 4;
  s.params.tracker.fetchIssuesByIds = async () => { host.state.accepted = true; throw new Error("refresh failed"); };
  await runAgentAttempt(s.params);
  assert.equal(s.events.filter((e) => e === "send").length, 1);
  host.state.accepted = false;
  s.params.onUpdate = (u) => { if (u.event === "turn_started") host.state.accepted = true; };
  await runAgentAttempt(s.params);
  assert.equal(s.events.filter((e) => e === "send").length, 1, "no second attempt send after acceptance");
});

test("review progress context comes from host initialReview, not a maximum-round template variable", async (t) => {
  const s = setup(t, "review"), host = runnerControl(); s.params.control = host.control;
  await runAgentAttempt(s.params);
  assert.match(s.prompts[0]!, /initial review; use progress=initial/);
  host.control.initialReview = false;
  await runAgentAttempt(s.params);
  assert.match(s.prompts[1]!, /formally handed-off rework/);
  assert.ok(!s.prompts.join("\n").includes("max_review_rounds"));
});

test("provider session limit is a turn failure, not a Symphony fee-budget decision", async (t) => {
  const s = setup(t);
  s.behavior.turn = (_config, emit) => { emit("session_limits_exhausted.requested", { requestId: "r", usedAiCredits: 1, maxAiCredits: 1 }); };
  await assert.rejects(runAgentAttempt(s.params), hasCode("turn_failed"));
});

test("unknown usage stays unknown; observed actual zero plus final metrics is complete", async (t) => {
  const s = setup(t);
  await runAgentAttempt(s.params);
  const unknown = s.updates.find((u) => u.event === "session_usage")!;
  assert.equal(unknown.summary!.usageComplete, false);
  assert.equal(unknown.aiCredits, undefined);
  s.behavior.turn = (_config, emit) => { emit("assistant.usage", { model: "actual-model", copilotUsage: { totalNanoAiu: 0 } }); emit("session.idle"); };
  s.behavior.metrics = async () => ({ totalNanoAiu: 0, totalPremiumRequestCost: 0, modelMetrics: {}, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } });
  await runAgentAttempt(s.params);
  const actual = s.updates.filter((u) => u.event === "session_usage").at(-1)!;
  assert.equal(actual.summary!.usageComplete, true);
  assert.equal(actual.aiCredits, 0);
  assert.deepEqual(actual.summary!.models.map((m) => m.model), ["actual-model"]);
});

test("late usage after idle is observed and final totals replace rather than add to live usage", async (t) => {
  const s = setup(t), host = runnerControl(); s.params.control = host.control;
  let emitLater!: Emit;
  s.behavior.turn = (_config, emit) => {
    emitLater = emit;
    emit("assistant.usage", { model: "actual-a", inputTokens: 10, outputTokens: 2, copilotUsage: { totalNanoAiu: 1e9 } });
    host.state.accepted = true; emit("session.idle");
  };
  s.behavior.metrics = async () => {
    emitLater("assistant.usage", { model: "actual-b", inputTokens: 20, outputTokens: 3, copilotUsage: { totalNanoAiu: 2e9 } });
    return { totalNanoAiu: 3e9, totalPremiumRequestCost: 1, modelMetrics: { "actual-b": { requests: { count: 1 }, totalNanoAiu: 2e9 } }, codeChanges: { linesAdded: 3, linesRemoved: 1, filesModified: ["a"] } };
  };
  await runAgentAttempt(s.params);
  const summary = s.updates.find((u) => u.event === "session_usage")!.summary!;
  assert.equal(summary.aiCredits, 3); assert.equal(summary.usageComplete, true);
  assert.deepEqual(summary.models.map((m) => m.model).sort(), ["actual-a", "actual-b"]);
  assert.equal(summary.inputTokens, 30); assert.equal(summary.outputTokens, 5);
});