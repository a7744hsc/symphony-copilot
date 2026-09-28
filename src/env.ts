import type { Issue } from "./types.ts";

/** Copy of `base` without secret variables, for hooks and the agent process (spec §15.3). */
export function scrubEnvironment(base: NodeJS.ProcessEnv, secretNames: string[]): Record<string, string> {
  const drop = new Set(secretNames);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !drop.has(key)) env[key] = value;
  }
  return env;
}

export function issueEnvironment(issue: Issue, workspacePath: string, workspaceKey: string): Record<string, string> {
  return {
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_BRANCH: issue.branchName ?? "",
    SYMPHONY_WORKSPACE: workspacePath,
    SYMPHONY_WORKSPACE_KEY: workspaceKey,
  };
}
