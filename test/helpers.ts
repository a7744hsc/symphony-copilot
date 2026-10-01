import { buildConfig, type ServiceConfig } from "../src/config.ts";
import { createLogger, type Logger } from "../src/log.ts";
import type { Issue } from "../src/types.ts";
import type { EffectiveWorkflow } from "../src/workflow.ts";

export const quietLog: Logger = createLogger("error", {}, () => {});

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger("debug", {}, (line) => lines.push(line)), lines };
}

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const id = overrides.id ?? "item-1";
  return {
    id,
    nativeRef: { provider: "fake", repository: "fake/repo", issue_id: `fake-${overrides.identifier ?? id}`, project_item_id: id },
    identifier: "GH-1",
    title: "Do the thing",
    description: null,
    priority: null,
    state: "Todo",
    branchName: "agent/1",
    url: null,
    assigneeId: null,
    labels: ["agent"],
    blockedBy: [],
    dispatchable: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: null,
    ...overrides,
  };
}

export function makeConfig(raw: Record<string, any> = {}): ServiceConfig {
  const { tracker = {}, ...rest } = raw;
  return buildConfig({
    tracker: {
      kind: "fake", active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Cancelled"], ...tracker,
      provider: {
        ...(tracker.kind === undefined || tracker.kind === "fake"
          ? { start_state: "Todo", working_state: "In Progress", blocked_state: "Blocked", handoff_state: "Human Review" }
          : {}),
        ...tracker.provider,
      },
    },
    workspace: { root: "/tmp/symphony-test-root" },
    ...rest,
  }, "/tmp/WORKFLOW.md", {});
}

export function makeWorkflow(config: ServiceConfig, promptTemplate = "Work on {{ issue.identifier }}"): EffectiveWorkflow {
  return { definition: { config: {}, promptTemplate }, config, loadedAt: new Date() };
}

/** Lets pending promise callbacks run (setImmediate is not mocked). */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function workflowText(workspace: string, number: number, endpoint = "https://api.github.com/graphql", prompt = `prompt-${number}`): string {
  return `---
tracker:
  kind: github_project
  provider:
    owner: me
    project_number: ${number}
    repo: me/app-${number}
    endpoint: ${endpoint}
    start_state: Todo
    working_state: In Progress
    blocked_state: Blocked
    handoff_state: Human Review
  active_states: [Todo, In Progress]
  terminal_states: [Done]
polling:
  interval_ms: 1000
workspace:
  root: ${JSON.stringify(workspace)}
---
${prompt}
`;
}

export function reviewWorkflowText(workspace: string, number: number, promptFile: string, endpoint?: string): string {
  return workflowText(workspace, number, endpoint)
    .replace("handoff_state: Human Review", "handoff_state: AI Review")
    .replace("active_states: [Todo, In Progress]", "active_states: [Todo, In Progress, AI Review, Rework]")
    .replace("polling:", `review:
  states: [AI Review]
  prompt_file: ${JSON.stringify(promptFile)}
  pass_state: Human Review
  fail_state: Rework
polling:`);
}
