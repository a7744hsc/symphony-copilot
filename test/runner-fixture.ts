import { writeFileSync } from "node:fs";
import { buildConfig } from "../src/config.ts";
import { register } from "../src/registry.ts";

const [id, workflow, root, project] = process.argv.slice(2);
if (!id || !workflow || !root || !project) throw new Error("missing fixture arguments");
const config = buildConfig({
  tracker: {
    kind: "github_project", provider: { owner: "fixture", project_number: Number(project) },
    active_states: ["Todo"], terminal_states: ["Done"],
  },
  workspace: { root },
}, workflow);
const entry = register(id, workflow, config);
writeFileSync(`${root}.fixture`, JSON.stringify(entry));
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
