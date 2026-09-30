import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunLedger } from "../src/ledger.ts";
import { createLogger } from "../src/log.ts";
import { register } from "../src/registry.ts";
import { WorkflowStore } from "../src/workflow.ts";

const [id, workflow, sessions] = process.argv.slice(2);
if (!id || !workflow || !sessions) throw new Error("missing fixture arguments");
const store = new WorkflowStore(workflow, createLogger("error"));
const root = store.workflow.config.workspace.root;
const entry = register(id, workflow, store.workflow.config);
const ledger = new RunLedger(join(root, ".symphony-ledger.json"));
ledger.open("shared-item", `${id}-issue`, new Date(0)).sessions = Number(sessions);
ledger.save();
writeFileSync(`${root}.fixture`, JSON.stringify({
  ...entry,
  prompt: store.workflow.definition.promptTemplate,
  projectNumber: store.workflow.config.tracker.provider.project_number,
}));
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  store.close();
  process.exit(0);
});
