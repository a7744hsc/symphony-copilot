#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { scrubEnvironment } from "./env.ts";
import { assertRunnerIdentity, canonicalPath, RunnerRegistry, runnerIdentity, validateId, workflowId, type RunnerIdentity, type RunnerRecord } from "./instances.ts";
import { RunLedger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runAgentAttempt } from "./runner.ts";
import { serveRunner, type RunnerState } from "./runner-control.ts";
import { createTracker } from "./tracker/index.ts";
import { WorkflowStore } from "./workflow.ts";
import { WorkspaceManager } from "./workspace.ts";

const USAGE = `Usage: node src/cli.ts [path/to/WORKFLOW.md] [--id ID] [--dry-run] [--once] [--log-level debug|info|warn|error]

  --dry-run   poll the tracker and log what would be dispatched; no workspaces, no agents
  --once      run a single poll tick, wait for dispatched workers, then exit`;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        once: { type: "boolean", default: false },
        "log-level": { type: "string", default: "info" },
        id: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (args.values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const level = args.values["log-level"] as "debug" | "info" | "warn" | "error";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    process.stderr.write(`invalid --log-level ${level}\n`);
    return 2;
  }
  let logFile: number | undefined;
  const log = createLogger(level, {}, (line) => {
    process.stderr.write(`${line}\n`);
    if (logFile !== undefined) writeSync(logFile, `${line}\n`);
  });
  const dryRun = args.values["dry-run"];

  let store: WorkflowStore;
  let ledger: RunLedger;
  let identity: RunnerIdentity | undefined;
  let record: RunnerRecord | undefined;
  const registry = new RunnerRegistry();
  const reportFailure = (error: unknown) => {
    const message = (error as Error).message;
    log.error("startup failed", { error: message });
    if (process.connected) process.send?.({ type: "error", message });
  };
  try {
    store = new WorkflowStore(args.positionals[0] ?? "WORKFLOW.md", log, process.env,
      (config) => { if (identity) assertRunnerIdentity(identity, config); });
    identity = runnerIdentity(store.workflow.config);
    if (!dryRun) {
      const registered = registry.list().find((r) => r.workflow === identity!.workflow);
      const id = validateId(args.values.id ?? registered?.id ?? workflowId(store.path));
      const nonce = randomUUID();
      const candidate: RunnerRecord = {
        ...identity, id,
        directory: canonicalPath(process.env.SYMPHONY_STATE_DIR || !registered
          ? join(process.env.SYMPHONY_STATE_DIR || join(homedir(), "symphony-workspaces"), "runners", id)
          : registered.directory),
        run: {
          pid: process.pid, nonce,
          socket: process.platform === "win32" ? `\\\\.\\pipe\\symphony-${nonce}` : join(tmpdir(), `symphony-${nonce}.sock`),
        },
      };
      await registry.claim(candidate);
      record = candidate;
      mkdirSync(record.directory, { recursive: true, mode: 0o700 });
      logFile = openSync(join(record.directory, "orchestrator.log"), "a", 0o600);
    }
    ledger = new RunLedger(join(store.workflow.config.workspace.root, ".symphony-ledger.json"), { readOnly: dryRun });
  } catch (error) {
    reportFailure(error);
    if (record) await registry.release(record.id, record.run!.nonce);
    if (logFile !== undefined) closeSync(logFile);
    return 1;
  }

  const orchestrator = new Orchestrator({
    log,
    dryRun,
    ledger,
    refreshWorkflow: () => store.refresh(),
    workflowError: () => store.reloadError,
    createTracker: (config) => createTracker(config, process.env, log),
    runWorker: async (p) => {
      const env = scrubEnvironment(process.env, p.tracker.secretEnvironmentNames());
      await runAgentAttempt({
        issue: p.issue,
        attempt: p.attempt,
        role: p.role,
        reviewRound: p.reviewRound,
        control: p.control,
        config: p.workflow.config,
        promptTemplate: p.workflow.definition.promptTemplate,
        tracker: p.tracker,
        workspaces: new WorkspaceManager(p.log, env),
        childEnv: env,
        signal: p.signal,
        log: p.log,
        onUpdate: p.onUpdate,
      });
    },
    removeWorkspace: (config, issue, tracker) =>
      new WorkspaceManager(log, scrubEnvironment(process.env, tracker.secretEnvironmentNames())).remove(config, issue),
  });

  process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason) }));

  let state: RunnerState = "starting";
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  let stopping: Promise<void> | undefined;
  const shutdown = () => {
    if (state === "stopping") return;
    state = "stopping";
    log.info("shutting down", { workflow_id: record?.id });
    stopping = orchestrator.stop();
    finish();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  let control: Awaited<ReturnType<typeof serveRunner>> | undefined;
  try {
    if (record) control = await serveRunner(record.run!, () => state, shutdown);
    log.info("starting", { workflow_id: record?.id, workflow: store.path, dry_run: dryRun, once: args.values.once, workspace_root: store.workflow.config.workspace.root, ledger: ledger.path });
    if (args.values.once) {
      await orchestrator.runOnce();
    } else {
      await orchestrator.start();
      if (!stopping) {
        store.watch();
        state = "running";
        if (process.connected) {
          process.send?.({ type: "ready", id: record?.id, pid: process.pid });
          process.disconnect?.();
        }
      }
      await stopped;
    }
    return orchestrator.snapshot().ledger_error ? 1 : 0;
  } catch (error) {
    reportFailure(error);
    return 1;
  } finally {
    await stopping;
    await orchestrator.stop();
    store.close();
    if (control) await new Promise<void>((resolve, reject) => control!.close((error) => error ? reject(error) : resolve()));
    if (record) await registry.release(record.id, record.run!.nonce);
    if (logFile !== undefined) closeSync(logFile);
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

const code = await main().catch((error: Error) => {
  process.stderr.write(`runner failed: ${error.message}\n`);
  if (process.connected) process.send?.({ type: "error", message: error.message });
  return 1;
});
process.exit(code);
