import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { assertRunnerIdentity, canonicalPath, pathsOverlap, RunnerRegistry, runnerIdentity, validateId, workflowId, type RunnerRecord } from "../src/instances.ts";
import { RunLedger } from "../src/ledger.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { requestRunner, serveRunner } from "../src/runner-control.ts";
import { WorkflowStore } from "../src/workflow.ts";
import { makeConfig, makeIssue, quietLog, reviewWorkflowText, workflowText } from "./helpers.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "symphony-instances-"));
  const cleanup: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    try { for (const close of cleanup) await close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const registry = new RunnerRegistry(join(dir, "registry"));
  const record = (id: string, patch: Partial<RunnerRecord> = {}): RunnerRecord => ({
    id, workflow: join(dir, `${id}.md`), workspace: join(dir, "work", id),
    inputs: [patch.workflow ?? join(dir, `${id}.md`)],
    workspacePaths: [patch.workspace ?? join(dir, "work", id)],
    directory: join(dir, "logs", id), project: `https://api.github.com/me/${id}`, scope: id,
    run: { pid: process.pid, nonce: randomUUID(), socket: join(dir, `${id}.sock`) }, ...patch,
  });
  const reviewRecord = (id: string, promptFile: string): RunnerRecord => {
    const r = record(id);
    writeFileSync(r.workflow, reviewWorkflowText(r.workspace, id === "alpha" ? 1 : 2, promptFile));
    const store = new WorkflowStore(r.workflow, quietLog, {});
    return { ...r, ...runnerIdentity(store.workflow.config) };
  };
  return { dir, registry, record, reviewRecord, cleanup };
}

test("registry atomically admits independent workflows, retains stopped state and releases only its own run", async (t) => {
  const { registry, record } = fixture(t);
  const a = record("alpha"), b = record("beta");
  await Promise.all([registry.claim(a), registry.claim(b)]);
  assert.deepEqual(registry.list().map((r) => r.id).sort(), ["alpha", "beta"]);
  await registry.release(a.id, "obsolete-nonce");
  assert.ok(registry.list().find((r) => r.id === a.id)?.run);
  await registry.release(a.id, a.run!.nonce);
  assert.equal(registry.list().find((r) => r.id === a.id)?.run, null);
  assert.ok(registry.list().find((r) => r.id === b.id)?.run);
  await assert.rejects(registry.claim(record("third", { workspace: a.workspace })), /state path collision.*alpha/);
  await registry.claim({ ...a, run: { ...a.run!, nonce: randomUUID() } });
});

test("concurrent same-project claims have exactly one winner, regardless of log directory", async (t) => {
  const { registry, record } = fixture(t);
  const results = await Promise.allSettled([
    registry.claim(record("alpha", { project: "shared" })),
    new RunnerRegistry(registry.root).claim(record("beta", { project: "shared" })),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.match(String(failure.reason), /same project are not supported/);
  assert.equal(registry.list().length, 1);
});

test("state protection covers ancestors, symlinks, hard-linked ledgers and cross-resource collisions", async (t) => {
  const { dir, registry, record } = fixture(t);
  const a = record("alpha");
  mkdirSync(a.workspace, { recursive: true });
  writeFileSync(join(a.workspace, ".symphony-ledger.json"), "{}");
  await registry.claim(a);
  for (const workspace of [a.workspace, join(a.workspace, "nested"), join(dir, "work")]) {
    await assert.rejects(registry.claim(record("beta", { workspace })), /state path collision/);
  }
  symlinkSync(a.workspace, join(dir, "alias"));
  await assert.rejects(registry.claim(record("beta", { workspace: join(dir, "alias", "not-created") })), /state path collision/);
  await assert.rejects(registry.claim(record("beta", { directory: join(a.workspace, "logs") })), /state path collision/);
  const beta = record("beta");
  mkdirSync(beta.workspace, { recursive: true });
  linkSync(join(a.workspace, ".symphony-ledger.json"), join(beta.workspace, ".symphony-ledger.json"));
  await assert.rejects(registry.claim(beta), /state path collision/);
  assert.equal(existsSync(beta.directory), false, "rejection must precede log creation");
  assert.equal(pathsOverlap(join(dir, "work-a"), join(dir, "work-ab")), false);
  await assert.rejects(registry.claim(record("gamma", { workspace: dir })), /shared registry/);
  await assert.rejects(registry.claim(record("gamma", { workspace: join(dir, "logs") })), /must not overlap/);
});

test("existing log/ledger symlinks cannot overlap even within one runner", async (t) => {
  const { dir, registry, record } = fixture(t);
  const a = record("alpha");
  mkdirSync(a.directory, { recursive: true });
  mkdirSync(a.workspace, { recursive: true });
  writeFileSync(join(a.directory, "orchestrator.log"), "");
  symlinkSync(join(a.directory, "orchestrator.log"), join(a.workspace, ".symphony-ledger.json"));
  await assert.rejects(registry.claim(a), /must not overlap/);
  assert.equal(readFileSync(join(a.directory, "orchestrator.log"), "utf8"), "");
  const b = record("beta");
  mkdirSync(b.directory, { recursive: true });
  writeFileSync(b.workflow, "prompt");
  symlinkSync(b.workflow, join(b.directory, "orchestrator.log"));
  await assert.rejects(registry.claim(b), /must not overlap/);
  assert.equal(readFileSync(join(dir, "beta.md"), "utf8"), "prompt");
});

for (const kind of ["root", "ancestor", "chain"] as const) {
  for (const aliasFirst of [false, true]) {
    test(`workspace ${kind} link locations reject cleanup collisions, aliasFirst=${aliasFirst}`, async (t) => {
      for (const stopped of [false, true]) {
        const { dir, registry, record } = fixture(t);
        const b = record("beta");
        const parent = join(b.workspace, "GH-1"), mount = join(parent, "mount"), outside = join(dir, "outside");
        mkdirSync(parent, { recursive: true });
        mkdirSync(outside);
        symlinkSync(outside, mount);
        const entry = join(dir, "entry");
        if (kind === "chain") symlinkSync(mount, entry);
        const workspace = kind === "root" ? mount : join(kind === "chain" ? entry : mount, "alpha");
        const a = record("alpha");
        writeFileSync(a.workflow, workflowText(workspace, 1));
        const store = new WorkflowStore(a.workflow, quietLog, {});
        Object.assign(a, runnerIdentity(store.workflow.config));
        const ledger = new RunLedger(join(workspace, ".symphony-ledger.json"));
        ledger.authorize(makeIssue(), 20);
        const original = readFileSync(ledger.path!, "utf8");
        const [first, second] = aliasFirst ? [a, b] : [b, a];
        await registry.claim(first);
        if (stopped) await registry.release(first.id, first.run!.nonce);
        const saved = readFileSync(registry.path, "utf8");
        await assert.rejects(registry.claim(second), /state path collision/, `stopped=${stopped}`);
        assert.equal(readFileSync(registry.path, "utf8"), saved);
        assert.equal(lstatSync(mount).isSymbolicLink(), true);
        assert.equal(readFileSync(ledger.path!, "utf8"), original);
        assert.equal(existsSync(a.directory), false);
        assert.equal(existsSync(b.directory), false);
        store.close();
      }
    });
  }
}

test("same-target workspace aliases require restart and preserve last-good execution paths", async (t) => {
  const { dir, registry, record } = fixture(t);
  const b = record("beta");
  const direct = join(dir, "outside"), mount = join(b.workspace, "GH-1", "mount");
  mkdirSync(direct);
  mkdirSync(join(b.workspace, "GH-1"), { recursive: true });
  symlinkSync(direct, mount);
  await registry.claim(b);
  const a = record("alpha");
  const text = workflowText(direct, 1);
  writeFileSync(a.workflow, text);
  let pinned: ReturnType<typeof runnerIdentity> | undefined;
  const store = new WorkflowStore(a.workflow, quietLog, {}, (c) => { if (pinned) assertRunnerIdentity(pinned, c); });
  pinned = runnerIdentity(store.workflow.config);
  Object.assign(a, pinned);
  await registry.claim(a);
  const original = store.workflow;
  let time = 2_000_000_000;
  const edit = (contents: string) => { writeFileSync(a.workflow, contents); utimesSync(a.workflow, ++time, time); return store.refresh(); };
  assert.equal(edit(workflowText(mount, 1)), original);
  assert.equal(store.workflow.config.workspace.root, direct);
  assert.match(store.reloadError!, /runner identity changed.*restart/);
  const saved = readFileSync(registry.path, "utf8");
  assert.equal(edit(text.replace("prompt-1", "updated")).definition.promptTemplate, "updated");
  assert.equal(store.reloadError, null);
  assert.equal(readFileSync(registry.path, "utf8"), saved);
  await registry.release(a.id, a.run!.nonce);
  edit(workflowText(mount, 1));
  const colliding = new WorkflowStore(a.workflow, quietLog, {});
  await assert.rejects(registry.claim({ ...a, ...runnerIdentity(colliding.workflow.config) }), /state path collision/);
  const safe = join(dir, "safe-alias");
  symlinkSync(direct, safe);
  edit(workflowText(safe, 1));
  assert.match(store.reloadError!, /runner identity changed.*restart/, "even a safe same-target alias needs a new claim");
  const restarted = new WorkflowStore(a.workflow, quietLog, {});
  await registry.claim({ ...a, ...runnerIdentity(restarted.workflow.config) });
  assert.equal(restarted.workflow.config.workspace.root, safe);
  for (const s of [store, colliding, restarted]) s.close();
});

test("workspace link locations also protect a runner's own logs and the shared registry", async (t) => {
  for (const resource of ["log", "registry"] as const) {
    const { dir, registry, record } = fixture(t);
    const a = record("alpha"), outside = join(dir, "outside");
    const owner = resource === "log" ? a.directory : registry.root;
    mkdirSync(owner, { recursive: true });
    mkdirSync(outside);
    const mount = join(owner, "mount");
    symlinkSync(outside, mount);
    writeFileSync(a.workflow, workflowText(join(mount, "alpha"), 1));
    const store = new WorkflowStore(a.workflow, quietLog, {});
    Object.assign(a, runnerIdentity(store.workflow.config));
    await assert.rejects(registry.claim(a), resource === "log" ? /must not overlap/ : /shared registry/);
    assert.equal(lstatSync(mount).isSymbolicLink(), true);
    assert.equal(existsSync(join(outside, "alpha")), false);
    assert.deepEqual(registry.list(), []);
    store.close();
  }
});

test("stopped workspace claims retain link entries even after the link is removed", async (t) => {
  const { dir, registry, record } = fixture(t);
  const a = record("alpha"), b = record("beta");
  const outside = join(dir, "outside"), mount = join(b.workspace, "mount");
  mkdirSync(outside);
  mkdirSync(b.workspace, { recursive: true });
  symlinkSync(outside, mount);
  writeFileSync(a.workflow, workflowText(mount, 1));
  const store = new WorkflowStore(a.workflow, quietLog, {});
  Object.assign(a, runnerIdentity(store.workflow.config));
  await registry.claim(a);
  await registry.release(a.id, a.run!.nonce);
  rmSync(mount);
  const saved = readFileSync(registry.path, "utf8");
  await assert.rejects(new RunnerRegistry(registry.root).claim(b), /state path collision.*alpha/);
  assert.equal(readFileSync(registry.path, "utf8"), saved);
  store.close();
});

test("dangling workspace root and ancestor links reserve their entries before state exists", async (t) => {
  for (const suffix of ["", "alpha"]) {
    for (const aliasFirst of [false, true]) {
      const { dir, registry, record } = fixture(t);
      const a = record("alpha"), b = record("beta"), missing = join(dir, "not-created");
      mkdirSync(b.workspace, { recursive: true });
      const mount = join(b.workspace, "mount");
      symlinkSync(missing, mount);
      writeFileSync(a.workflow, workflowText(join(mount, suffix), 1));
      const store = new WorkflowStore(a.workflow, quietLog, {});
      Object.assign(a, runnerIdentity(store.workflow.config));
      const [first, second] = aliasFirst ? [a, b] : [b, a];
      await registry.claim(first);
      await assert.rejects(registry.claim(second), /state path collision/);
      assert.equal(existsSync(missing), false);
      assert.equal(lstatSync(mount).isSymbolicLink(), true);
      store.close();
    }
  }
});

test("independent sibling workspaces can use a common symlink ancestor", async (t) => {
  const { dir, registry, record } = fixture(t);
  const outside = join(dir, "outside"), shared = join(dir, "shared");
  mkdirSync(outside);
  symlinkSync(outside, shared);
  for (const [id, number] of [["alpha", 1], ["beta", 2]] as const) {
    const a = record(id);
    writeFileSync(a.workflow, workflowText(join(shared, id), number));
    const store = new WorkflowStore(a.workflow, quietLog, {});
    const identity = runnerIdentity(store.workflow.config);
    Object.assign(a, identity);
    await registry.claim(a);
    const ledger = new RunLedger(join(store.workflow.config.workspace.root, ".symphony-ledger.json"));
    ledger.authorize(makeIssue(), 20);
    assert.doesNotThrow(() => assertRunnerIdentity(identity, store.workflow.config), "creating a missing root must not change its identity");
    assert.equal(canonicalPath(ledger.path!), join(canonicalPath(outside), id, ".symphony-ledger.json"));
    store.close();
  }
  assert.equal(registry.list().length, 2);
});

test("intermediate input, log and ledger links cannot hide in another runner's cleanup domain", async (t) => {
  for (const resource of ["input", "log", "ledger"] as const) {
    for (const aliasFirst of [false, true]) {
      const { dir, registry, record, reviewRecord } = fixture(t);
      const b = record("beta"), outside = join(dir, "outside"), bridge = join(b.workspace, "GH-1", "bridge");
      mkdirSync(join(b.workspace, "GH-1"), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, bridge);
      const target = join(outside, "file");
      writeFileSync(target, "original contents");
      const alias = join(dir, "input-alias");
      if (resource === "input") symlinkSync(join(bridge, "file"), alias);
      const a = resource === "input" ? reviewRecord("alpha", alias) : record("alpha");
      if (resource === "log") {
        mkdirSync(a.directory, { recursive: true });
        symlinkSync(join(bridge, "file"), join(a.directory, "orchestrator.log"));
      } else if (resource === "ledger") {
        mkdirSync(a.workspace, { recursive: true });
        symlinkSync(join(bridge, "file"), join(a.workspace, ".symphony-ledger.json"));
      }
      const [first, second] = aliasFirst ? [a, b] : [b, a];
      await registry.claim(first);
      await assert.rejects(registry.claim(second), /state path collision/, `${resource}, aliasFirst=${aliasFirst}`);
      assert.equal(readFileSync(target, "utf8"), "original contents");
      assert.equal(lstatSync(bridge).isSymbolicLink(), true);
    }
  }
});

for (const [kind, link] of [["symlink", symlinkSync], ["hard link", linkSync]] as const) {
  test(`ledger temporary ${kind} collisions protect live and stopped runners before effects`, async (t) => {
    for (const resource of ["workflow", "ledger", "log"] as const) {
      for (const stopped of [false, true]) {
        const { registry, record } = fixture(t);
        const a = record("alpha"), b = record("beta");
        mkdirSync(a.workspace, { recursive: true });
        mkdirSync(a.directory, { recursive: true });
        mkdirSync(b.workspace, { recursive: true });
        const target = resource === "workflow" ? a.workflow
          : resource === "ledger" ? join(a.workspace, ".symphony-ledger.json")
          : join(a.directory, "orchestrator.log");
        writeFileSync(target, "alpha state");
        await registry.claim(a);
        if (stopped) await registry.release(a.id, a.run!.nonce);
        link(target, join(b.workspace, ".symphony-ledger.json.tmp"));
        await assert.rejects(registry.claim(b), /state path collision.*alpha/, `${kind}: ${resource}, stopped=${stopped}`);
        assert.equal(readFileSync(target, "utf8"), "alpha state");
        assert.equal(existsSync(b.directory), false);
        assert.equal(existsSync(join(b.workspace, ".symphony-ledger.json")), false);
        assert.deepEqual(registry.list().map((r) => r.id), ["alpha"]);
      }
    }
  });

  test(`ledger temporary ${kind} collisions protect the same runner and the registry`, async (t) => {
    for (const resource of ["workflow", "ledger", "log", "registry"] as const) {
      const { registry, record } = fixture(t);
      const a = record("alpha");
      mkdirSync(a.workspace, { recursive: true });
      mkdirSync(a.directory, { recursive: true });
      mkdirSync(registry.root, { recursive: true });
      const target = resource === "workflow" ? a.workflow
        : resource === "ledger" ? join(a.workspace, ".symphony-ledger.json")
        : resource === "log" ? join(a.directory, "orchestrator.log") : registry.path;
      writeFileSync(target, "[]");
      link(target, join(a.workspace, ".symphony-ledger.json.tmp"));
      const expected = resource === "registry" ? /shared registry/ : /must not overlap/;
      await assert.rejects(registry.claim(a), expected, `${kind}: ${resource}`);
      assert.equal(readFileSync(target, "utf8"), "[]");
      assert.deepEqual(registry.list(), []);
    }
  });
}

test("ledger temporary paths participate in collision checks in either claim order", async (t) => {
  for (const sidecarFirst of [false, true]) {
    const { registry, record } = fixture(t);
    const a = record("alpha"), b = record("beta");
    mkdirSync(a.directory, { recursive: true });
    const temporary = join(b.workspace, ".symphony-ledger.json.tmp");
    symlinkSync(temporary, join(a.directory, "orchestrator.log"));
    const [first, second] = sidecarFirst ? [b, a] : [a, b];
    await registry.claim(first);
    await assert.rejects(registry.claim(second), /state path collision/);
    assert.equal(existsSync(temporary), false);
    assert.equal(existsSync(b.workspace), false);
    assert.equal(registry.list().length, 1);
  }
});

test("pre-existing ledger temporary files fail startup without overwriting crash evidence", async (t) => {
  for (const kind of ["file", "directory", "dangling symlink"]) {
    const { dir, registry, record } = fixture(t);
    const a = record("alpha");
    mkdirSync(a.workspace, { recursive: true });
    const temporary = join(a.workspace, ".symphony-ledger.json.tmp");
    if (kind === "file") writeFileSync(temporary, "unfinished save");
    else if (kind === "directory") mkdirSync(temporary);
    else symlinkSync(join(dir, "missing"), temporary);
    await assert.rejects(registry.claim(a), /ledger temporary path already exists/);
    assert.equal(existsSync(a.directory), false);
    assert.equal(existsSync(join(a.workspace, ".symphony-ledger.json")), false);
    assert.deepEqual(registry.list(), []);
    if (kind === "file") assert.equal(readFileSync(temporary, "utf8"), "unfinished save");
  }
});

for (const [kind, link] of [["symlink", symlinkSync], ["hard link", linkSync]] as const) {
  test(`reviewer inputs reject cross-runner ${kind} writes in either claim order, live or stopped`, async (t) => {
    for (const resource of ["log", "ledger"] as const) {
      for (const readerFirst of [false, true]) {
        for (const stopped of [false, true]) {
          const { dir, registry, record, reviewRecord } = fixture(t);
          const prompt = join(dir, "REVIEW.md");
          writeFileSync(prompt, "alpha review instructions");
          const a = reviewRecord("alpha", prompt), b = record("beta");
          mkdirSync(b.directory, { recursive: true });
          mkdirSync(b.workspace, { recursive: true });
          const destination = resource === "log" ? join(b.directory, "orchestrator.log") : join(b.workspace, ".symphony-ledger.json");
          link(prompt, destination);
          const [first, second] = readerFirst ? [a, b] : [b, a];
          await registry.claim(first);
          if (stopped) await registry.release(first.id, first.run!.nonce);
          const before = readFileSync(registry.path, "utf8");
          await assert.rejects(registry.claim(second), /state path collision/, `${resource}, readerFirst=${readerFirst}, stopped=${stopped}`);
          assert.equal(readFileSync(prompt, "utf8"), "alpha review instructions");
          assert.equal(readFileSync(registry.path, "utf8"), before);
        }
      }
    }
  });

  test(`reviewer inputs reject intra-runner and registry ${kind} aliases`, async (t) => {
    for (const resource of ["log", "ledger", "temporary", "registry"] as const) {
      const { dir, registry, reviewRecord } = fixture(t);
      const prompt = join(dir, "REVIEW.md");
      const a = reviewRecord("alpha", prompt);
      mkdirSync(a.directory, { recursive: true });
      mkdirSync(a.workspace, { recursive: true });
      mkdirSync(registry.root, { recursive: true });
      const target = resource === "log" ? join(a.directory, "orchestrator.log")
        : resource === "registry" ? registry.path
        : join(a.workspace, `.symphony-ledger.json${resource === "temporary" ? ".tmp" : ""}`);
      writeFileSync(target, "[]");
      link(target, prompt);
      await assert.rejects(registry.claim(a), resource === "registry" ? /shared registry/ : /must not overlap/, resource);
      assert.equal(readFileSync(prompt, "utf8"), "[]");
      assert.equal(readFileSync(target, "utf8"), "[]");
      assert.deepEqual(registry.list(), []);
    }
  });
}

test("reviewer input ancestry and dangling aliases are reserved before files exist", async (t) => {
  for (const own of [false, true]) {
    const { dir, registry, record, reviewRecord } = fixture(t);
    const b = record("beta");
    const prompt = join(own ? join(dir, "work", "alpha") : b.workspace, "GH-1", "REVIEW.md");
    const a = reviewRecord("alpha", prompt);
    if (!own) await registry.claim(b);
    await assert.rejects(registry.claim(a), own ? /must not overlap/ : /state path collision/);
    assert.equal(existsSync(prompt), false);
  }
  const { dir, registry, record, reviewRecord } = fixture(t);
  const prompt = join(dir, "future-review.md");
  const a = reviewRecord("alpha", prompt), b = record("beta");
  mkdirSync(b.directory, { recursive: true });
  symlinkSync(prompt, join(b.directory, "orchestrator.log"));
  await registry.claim(a);
  await assert.rejects(registry.claim(b), /state path collision/);
  assert.equal(existsSync(prompt), false);
});

test("input links inside a writable workspace reserve both their entry and external target", async (t) => {
  for (const input of ["workflow", "review"] as const) {
    for (const kind of ["file", "directory"] as const) {
      const { dir, registry, reviewRecord } = fixture(t);
      const workspace = join(dir, "work", "alpha"), outside = join(dir, "outside");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside);
      const target = join(outside, "input.md"), link = join(workspace, "link");
      writeFileSync(target, "instructions");
      symlinkSync(kind === "file" ? target : outside, link);
      const alias = kind === "file" ? link : join(link, "input.md");
      const a = reviewRecord("alpha", input === "review" ? alias : join(dir, "REVIEW.md"));
      if (input === "workflow") {
        writeFileSync(target, readFileSync(a.workflow));
        const store = new WorkflowStore(alias, quietLog, {});
        Object.assign(a, runnerIdentity(store.workflow.config));
      }
      await assert.rejects(registry.claim(a), /must not overlap/, `${input}: ${kind}`);
      assert.equal(existsSync(alias), true);
      assert.equal(existsSync(a.directory), false);
    }
  }
});

test("registry rejects incomplete workflow input inventories without rewriting them", async (t) => {
  const { registry, record } = fixture(t);
  const a = record("alpha");
  mkdirSync(registry.root, { recursive: true });
  for (const inputs of [undefined, [], ["relative-review.md"], [a.workflow, null]]) {
    const text = JSON.stringify([{ ...a, inputs }]);
    writeFileSync(registry.path, text);
    assert.throws(() => registry.list(), /invalid runner registry.*input paths/);
    await assert.rejects(registry.claim(record("beta")), /invalid runner registry/);
    assert.equal(readFileSync(registry.path, "utf8"), text);
  }
});

test("registry rejects incomplete workspace location inventories without rewriting them", async (t) => {
  const { registry, record } = fixture(t);
  const a = record("alpha");
  mkdirSync(registry.root, { recursive: true });
  for (const workspacePaths of [undefined, [], ["relative-root"], [a.workspace, null]]) {
    const text = JSON.stringify([{ ...a, workspacePaths }]);
    writeFileSync(registry.path, text);
    assert.throws(() => registry.list(), /invalid runner registry.*workspace paths/);
    await assert.rejects(registry.claim(record("beta")), /invalid runner registry/);
    assert.equal(readFileSync(registry.path, "utf8"), text);
  }
});

test("dangling symlinks reserve their eventual targets before state files exist", async (t) => {
  const { dir, registry, record } = fixture(t);
  const a = record("alpha"), b = record("beta");
  mkdirSync(a.workspace, { recursive: true });
  mkdirSync(b.directory, { recursive: true });
  symlinkSync(join(a.workspace, ".symphony-ledger.json"), join(b.directory, "orchestrator.log"));
  await registry.claim(a);
  await assert.rejects(registry.claim(b), /state path collision/);
  assert.equal(existsSync(join(a.workspace, ".symphony-ledger.json")), false);
  symlinkSync(join(dir, "future-target"), join(dir, "future-alias"));
  assert.equal(canonicalPath(join(dir, "future-alias", "child")), join(canonicalPath(dir), "future-target", "child"));
});

test("IDs bind canonical workflow paths; duplicate names and aliases cannot steal registrations", async (t) => {
  const { dir, registry, record } = fixture(t);
  const a = record("alpha");
  writeFileSync(a.workflow, "workflow");
  symlinkSync(a.workflow, join(dir, "alias.md"));
  assert.equal(workflowId(a.workflow), workflowId(join(dir, "alias.md")));
  assert.equal(validateId("Alpha"), "alpha");
  assert.throws(() => validateId("../alpha"), /workflow ID/);
  await registry.claim(a);
  await assert.rejects(registry.claim(a), /already running/);
  await assert.rejects(registry.claim(record("alpha", { workflow: join(dir, "other.md") })), /already belongs/);
  await assert.rejects(registry.claim(record("alias", { workflow: canonicalPath(join(dir, "alias.md")) })), /registered as/);
});

test("dead process claims can restart, malformed registry is not silently overwritten", async (t) => {
  const { registry, record } = fixture(t);
  const a = record("alpha");
  await registry.claim({ ...a, run: { ...a.run!, pid: 2147483647 } });
  await registry.claim(a);
  assert.equal(registry.list()[0]?.run?.pid, process.pid);
  writeFileSync(registry.path, "not json");
  await assert.rejects(registry.claim(record("beta")), /cannot read runner registry/);
  assert.equal(readFileSync(registry.path, "utf8"), "not json");
  assert.equal(existsSync(join(registry.root, "registry.lock")), false);
});

function config(dir: string, provider: Record<string, unknown> = {}) {
  return makeConfig({
    tracker: { kind: "github_project", provider: {
      owner: "Me", project_number: 1, repo: "Me/App",
      start_state: "Todo", working_state: "In Progress", blocked_state: "Blocked", ...provider,
    } },
    workspace: { root: join(dir, "work") },
  });
}

test("project identity ignores repository filters, owner casing, default ports and endpoint suffixes", (t) => {
  const { dir } = fixture(t);
  const a = runnerIdentity(config(dir));
  const b = runnerIdentity(config(dir, {
    owner: "me", owner_type: "organization", repo: "Me/Other", project_number: "01",
    endpoint: "https://API.GITHUB.COM:443/graphql/",
  }));
  assert.equal(a.project, b.project);
  assert.equal(a.project, runnerIdentity(config(dir, { endpoint: "http://api.github.com/graphql" })).project);
  assert.notEqual(a.scope, b.scope);
  assert.notEqual(a.project, runnerIdentity(config(dir, { project_number: 2 })).project);
  assert.notEqual(a.project, runnerIdentity(config(dir, { endpoint: "https://enterprise.example/api/graphql" })).project);
});

test("identity-changing reloads keep the old config, but prompt edits and recovery still work", (t) => {
  const { dir } = fixture(t);
  const path = join(dir, "WORKFLOW.md"), workspace = join(dir, "work");
  const text = workflowText(workspace, 1);
  writeFileSync(path, text);
  let pinned: ReturnType<typeof runnerIdentity> | undefined;
  const store = new WorkflowStore(path, quietLog, {}, (c) => { if (pinned) assertRunnerIdentity(pinned, c); });
  pinned = runnerIdentity(store.workflow.config);
  let time = 2_000_000_000;
  const edit = (contents: string) => { writeFileSync(path, contents); utimesSync(path, ++time, time); return store.refresh(); };
  for (const changed of [
    workflowText(join(dir, "other"), 1), workflowText(workspace, 2),
    text.replace("me/app-1", "me/other"), text.replace("owner: me", "owner: other"),
  ]) {
    assert.equal(edit(changed).definition.promptTemplate, "prompt-1");
    assert.equal(store.workflow.config.workspace.root, workspace);
    assert.match(store.reloadError!, /runner identity changed/);
  }
  assert.equal(edit(text.replace("prompt-1", "new prompt")).definition.promptTemplate, "new prompt");
  assert.equal(store.reloadError, null);
  store.close();
});

test("reviewer input changes require restart; reload failures retain last-good configuration and recover", async (t) => {
  const { dir, registry, record } = fixture(t);
  const b = record("beta");
  mkdirSync(b.directory, { recursive: true });
  const log = join(b.directory, "orchestrator.log");
  writeFileSync(log, "beta log");
  await registry.claim(b);
  const path = join(dir, "alpha.md"), workspace = join(dir, "work", "alpha"), prompt = join(dir, "REVIEW.md");
  const text = reviewWorkflowText(workspace, 1, prompt);
  writeFileSync(path, text);
  writeFileSync(prompt, "original review");
  let pinned: ReturnType<typeof runnerIdentity> | undefined;
  const store = new WorkflowStore(path, quietLog, {}, (c) => { if (pinned) assertRunnerIdentity(pinned, c); });
  pinned = runnerIdentity(store.workflow.config);
  const a = { ...record("alpha"), ...pinned };
  await registry.claim(a);
  let time = 2_000_000_000;
  const edit = (contents: string) => { writeFileSync(path, contents); utimesSync(path, ++time, time); return store.refresh(); };
  for (const changed of [
    reviewWorkflowText(workspace, 1, log),
    reviewWorkflowText(workspace, 1, join(dir, "other-review.md")),
    workflowText(workspace, 1),
  ]) {
    const before = store.workflow;
    assert.equal(edit(changed), before);
    assert.equal(store.workflow.config.review?.promptFile, prompt);
    assert.match(store.reloadError!, /runner identity changed.*restart/);
  }
  writeFileSync(prompt, "revised review");
  const recovered = edit(text.replace("prompt-1", "new implementation prompt").replace("  states: [AI Review]", "  model: different-model\n  states: [AI Review]"));
  assert.equal(store.reloadError, null);
  assert.equal(recovered.definition.promptTemplate, "new implementation prompt");
  assert.equal(recovered.config.review?.model, "different-model");
  assert.equal(readFileSync(recovered.config.review!.promptFile, "utf8"), "revised review");
  assert.equal(readFileSync(log, "utf8"), "beta log");
  await registry.release(a.id, a.run!.nonce);
  edit(reviewWorkflowText(workspace, 1, log));
  const colliding = new WorkflowStore(path, quietLog, {});
  await assert.rejects(registry.claim({ ...a, ...runnerIdentity(colliding.workflow.config) }), /state path collision/);
  edit(reviewWorkflowText(workspace, 1, join(dir, "other-review.md")));
  const restarted = new WorkflowStore(path, quietLog, {});
  await registry.claim({ ...a, ...runnerIdentity(restarted.workflow.config) });
  writeFileSync(path, workflowText(workspace, 1));
  const disabled = new WorkflowStore(path, quietLog, {});
  const noReview = runnerIdentity(disabled.workflow.config);
  assert.throws(() => assertRunnerIdentity(noReview, recovered.config), /runner identity changed/);
  const sameFileReview = { ...disabled.workflow.config, review: { ...recovered.config.review!, promptFile: path } };
  assert.throws(() => assertRunnerIdentity(noReview, sameFileReview), /runner identity changed/);
  assert.throws(() => assertRunnerIdentity(runnerIdentity(sameFileReview), disabled.workflow.config), /runner identity changed/);
  for (const s of [store, colliding, restarted, disabled]) s.close();
});

test("control targets a run nonce, never a possibly reused PID", async (t) => {
  const { record } = fixture(t);
  const a = record("alpha");
  // Use a short socket path: macOS has a 104-byte Unix socket path limit.
  a.run!.socket = join(tmpdir(), `sy-test-${randomUUID()}.sock`);
  let stops = 0;
  const server = await serveRunner(a.run!, () => stops ? "stopping" : "running", () => { stops++; });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await assert.rejects(requestRunner({ ...a, run: { ...a.run!, nonce: "old-run" } }, "stop"), /without a response/);
  assert.equal(stops, 0);
  assert.equal(await requestRunner(a, "status"), "running");
  assert.equal(await requestRunner(a, "stop"), "stopping");
  assert.equal(stops, 1);
});

test("independent stores, ledgers, trackers, prompts and worker shutdown remain isolated", async (t) => {
  const { dir, cleanup } = fixture(t);
  const instances = [1, 2].map((number) => {
    const workspace = join(dir, `work-${number}`);
    const path = join(dir, `${number}.md`);
    writeFileSync(path, workflowText(workspace, number));
    const store = new WorkflowStore(path, quietLog, {});
    const ledger = new RunLedger(join(workspace, ".symphony-ledger.json"));
    let issue = makeIssue({ nativeRef: { repository: `me/app-${number}`, issue_id: `issue-${number}` } });
    let aborted = false;
    let prompt: string | undefined;
    const orchestrator = new Orchestrator({
      log: quietLog, ledger, refreshWorkflow: () => store.refresh(), workflowError: () => store.reloadError,
      createTracker: () => ({
        kind: "github_project", agentTools: () => [], secretEnvironmentNames: () => [],
        fetchIssuesByStates: async (states) => states.includes(issue.state) ? [issue] : [],
        fetchIssuesByIds: async () => [issue],
        moveIssue: async (_i, state) => { issue = { ...issue, state }; },
      }),
      removeWorkspace: async () => {},
      runWorker: async (p) => {
        prompt = p.workflow.definition.promptTemplate;
        assert.equal(p.workflow.config.tracker.provider.repo, `me/app-${number}`);
        mkdirSync(p.workflow.config.workspace.root, { recursive: true });
        writeFileSync(join(p.workflow.config.workspace.root, "worker"), prompt);
        await p.control.onSessionCreated(`session-${number}`);
        await new Promise<void>((resolve) => p.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      },
    });
    cleanup.push(async () => { await orchestrator.stop(); store.close(); });
    return { orchestrator, ledger, workspace, prompt: () => prompt, aborted: () => aborted };
  });
  const [a, b] = instances;
  await Promise.all(instances.map((i) => i.orchestrator.tick()));
  assert.equal(a!.prompt(), "prompt-1");
  assert.equal(b!.prompt(), "prompt-2");
  assert.equal(a!.ledger.records()[0]?.sessions, 1);
  assert.equal(b!.ledger.records()[0]?.sessions, 1);
  assert.notEqual(a!.ledger.records()[0]?.key, b!.ledger.records()[0]?.key);
  await a!.orchestrator.stop();
  assert.equal(a!.aborted(), true);
  assert.equal(b!.aborted(), false);
  assert.equal(b!.orchestrator.snapshot().counts.running, 1);
  assert.equal(readFileSync(join(b!.workspace, "worker"), "utf8"), "prompt-2");
});

test("shutdown waits for an in-flight tracker operation before releasing runner ownership", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const fetching = new Promise<void>((resolve) => { entered = resolve; });
  const workflow = { definition: { config: {}, promptTemplate: "" }, config: makeConfig(), loadedAt: new Date() };
  const orchestrator = new Orchestrator({
    log: quietLog, refreshWorkflow: () => workflow, workflowError: () => null,
    createTracker: () => ({
      kind: "fake", agentTools: () => [], secretEnvironmentNames: () => [],
      fetchIssuesByStates: async () => { entered(); await gate; return []; },
      fetchIssuesByIds: async () => [],
    }),
    runWorker: async () => assert.fail("stopping runner must not dispatch"),
    removeWorkspace: async () => {},
  });
  t.after(async () => { release(); await orchestrator.stop(); });
  const poll = orchestrator.tick();
  await fetching;
  let stopped = false;
  const stop = orchestrator.stop().then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  release();
  await Promise.all([poll, stop]);
  assert.equal(stopped, true);
});
