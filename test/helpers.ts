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
  return {
    id: "item-1",
    nativeRef: null,
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
    tracker: { kind: "fake", active_states: ["Todo", "In Progress"], terminal_states: ["Done", "Cancelled"], ...tracker },
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
