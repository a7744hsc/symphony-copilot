#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { scrubEnvironment } from "./env.ts";
import { RunLedger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { Orchestrator } from "./orchestrator.ts";
import { runAgentAttempt } from "./runner.ts";
import { createTracker } from "./tracker/index.ts";
import { WorkflowStore } from "./workflow.ts";
import { WorkspaceManager } from "./workspace.ts";

const USAGE = `Usage: symphony [path/to/WORKFLOW.md] [--dry-run] [--once] [--log-level debug|info|warn|error]

  --dry-run   poll the tracker and log what would be dispatched; no workspaces, no agents
  --once      run a single poll tick, wait for dispatched workers, then exit`;

function main(): Promise<number> | number {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        once: { type: "boolean", default: false },
        "log-level": { type: "string", default: "info" },
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
  const level = args.values["log-level"] as "debug" | "info" | "warn" | "error";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    process.stderr.write(`invalid --log-level ${level}\n`);
    return 2;
  }
  const log = createLogger(level);
  const dryRun = args.values["dry-run"];

  let store: WorkflowStore;
  let ledger: RunLedger;
  try {
    store = new WorkflowStore(args.positionals[0] ?? "WORKFLOW.md", log);
    ledger = new RunLedger(join(store.workflow.config.workspace.root, ".symphony-ledger.json"), { readOnly: dryRun });
  } catch (error) {
    log.error("startup failed", { error: (error as Error).message });
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

  return (async () => {
    log.info("starting", { workflow: store.path, dry_run: dryRun, once: args.values.once, workspace_root: store.workflow.config.workspace.root, ledger: ledger.path });
    try {
      if (args.values.once) {
        await orchestrator.runOnce();
        store.close();
        return 0;
      }
      await orchestrator.start();
    } catch (error) {
      log.error("startup failed", { error: (error as Error).message });
      store.close();
      return 1;
    }
    store.watch();
    return new Promise<number>((resolveExit) => {
      let stopping = false;
      const shutdown = (signal: string) => {
        if (stopping) {
          log.warn("second signal; exiting immediately", { signal });
          resolveExit(1);
          return;
        }
        stopping = true;
        log.info("shutting down", { signal });
        void orchestrator.stop().finally(() => {
          store.close();
          resolveExit(0);
        });
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });
  })();
}

const code = await main();
process.exit(code);
