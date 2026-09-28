import type { ServiceConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { GitHubProjectTracker } from "./github-project.ts";
import { TrackerError, type TrackerAdapter } from "./types.ts";

export { TrackerError, type AgentToolContext, type TrackerAdapter, type TrackerErrorCategory } from "./types.ts";

export function createTracker(config: ServiceConfig, env: NodeJS.ProcessEnv, log: Logger): TrackerAdapter {
  switch (config.tracker.kind) {
    case "github_project":
      return new GitHubProjectTracker(config.tracker.provider, env, log);
    default:
      throw new TrackerError("unsupported_tracker_kind", `tracker.kind "${config.tracker.kind}" is not supported (supported: github_project)`);
  }
}
