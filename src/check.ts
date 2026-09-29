import { existsSync, readFileSync } from "node:fs";
import { buildConfig, ConfigError, type ServiceConfig } from "./config.ts";
import { parseSettings, type GitHubProjectSettings } from "./tracker/github-project.ts";
import { TrackerError } from "./tracker/types.ts";
import { renderContinuationPrompt, renderIssuePrompt, renderTemplate } from "./template.ts";
import { issueForTemplate, normalizeState, type Issue } from "./types.ts";
import { loadWorkflow, type WorkflowDefinition } from "./workflow.ts";

export interface Finding {
  level: "error" | "warning";
  message: string;
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
}

export const WORKFLOW_SCHEMA: SchemaNode = JSON.parse(readFileSync(new URL("../schema/workflow.schema.json", import.meta.url), "utf8"));

export interface CheckResult {
  findings: Finding[];
  config: ServiceConfig | null;
  /** Settings for the checks; the token and a missing project number are stand-ins. */
  settings: GitHubProjectSettings | null;
  hasProjectNumber: boolean;
  tokenAvailable: boolean;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** Keys the schema does not define; values are left to buildConfig. */
export function unknownKeys(value: unknown, schema: SchemaNode = WORKFLOW_SCHEMA, path = ""): Finding[] {
  if (!isMap(value)) return [];
  const findings: Finding[] = [];
  for (const [key, child] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    const known = schema.properties?.[key];
    if (known) {
      findings.push(...unknownKeys(child, known, where));
    } else if (typeof schema.additionalProperties === "object") {
      findings.push(...unknownKeys(child, schema.additionalProperties, where));
    } else if (schema.additionalProperties === false) {
      const [closest] = Object.keys(schema.properties ?? {})
        .map((name) => ({ name, d: distance(key, name) }))
        .filter((c) => c.d <= 2)
        .sort((x, y) => x.d - y.d);
      findings.push({ level: "error", message: `${where}: unknown key${closest ? ` (did you mean ${closest.name}?)` : ""}` });
    }
  }
  return findings;
}

/** Checks WORKFLOW.md without network access. */
export function checkWorkflow(path: string, env: NodeJS.ProcessEnv = process.env): CheckResult {
  const findings: Finding[] = [];
  const result: CheckResult = { findings, config: null, settings: null, hasProjectNumber: false, tokenAvailable: false };
  const error = (message: string) => findings.push({ level: "error", message });
  const warn = (message: string) => findings.push({ level: "warning", message });

  let definition: WorkflowDefinition;
  try {
    definition = loadWorkflow(path);
  } catch (e) {
    error((e as Error).message);
    return result;
  }
  findings.push(...unknownKeys(definition.config));
  try {
    result.config = buildConfig(definition.config, path, env);
  } catch (e) {
    if (e instanceof ConfigError) e.problems.forEach(error);
    else error((e as Error).message);
  }
  const config = result.config;
  if (config) {
    if (config.tracker.kind === "github_project") result.settings = probeSettings(config.tracker.provider, env, result, error, warn);
    else error(`tracker.kind "${config.tracker.kind}" is not supported (supported: github_project)`);
    if (result.settings) crossCheck(config, result.settings, error, warn);
    if (!config.hooks.afterCreate) warn("hooks.after_create is empty: workspaces start as empty folders; clone the repository there (see examples/WORKFLOW.md)");
    if (config.review && !config.hooks.beforeRun?.includes("SYMPHONY_ROLE")) {
      warn("hooks.before_run does not look at SYMPHONY_ROLE: the reviewer's workspace is not reset to the pushed branch (see examples/WORKFLOW.md)");
    }
    if (config.copilot.cliPath && !existsSync(config.copilot.cliPath)) error(`copilot.cli_path ${config.copilot.cliPath} does not exist`);
  }
  checkTemplates(definition, config, result.settings, error, warn);
  return result;
}

function trackerMessage(e: unknown): string {
  return e instanceof TrackerError ? e.message.slice(e.category.length + 2) : (e as Error).message;
}

function probeSettings(provider: Record<string, unknown>, env: NodeJS.ProcessEnv, result: CheckResult, error: (m: string) => void, warn: (m: string) => void): GitHubProjectSettings | null {
  const rawToken = provider.token ?? "$SYMPHONY_GITHUB_TOKEN";
  const probeEnv = { ...env };
  if (typeof rawToken === "string" && rawToken.startsWith("$")) {
    const name = rawToken.slice(1);
    result.tokenAvailable = Boolean(env[name]);
    probeEnv[name] ||= "unset";
  } else if (typeof rawToken === "string" && rawToken.trim() !== "") {
    result.tokenAvailable = true;
    warn("tracker.provider.token holds a literal token: use a $ENV_VAR reference so the secret stays out of git");
  }
  const number = provider.project_number;
  result.hasProjectNumber = number !== undefined && number !== null && number !== "";
  if (!result.hasProjectNumber) warn("tracker.provider.project_number is not set: `symphony setup-board` creates the board and fills it in");
  try {
    return parseSettings(result.hasProjectNumber ? provider : { ...provider, project_number: 1 }, probeEnv);
  } catch (e) {
    error(trackerMessage(e));
    return null;
  }
}

function crossCheck(config: ServiceConfig, settings: GitHubProjectSettings, error: (m: string) => void, warn: (m: string) => void): void {
  const has = (list: string[], state: string) => list.some((s) => normalizeState(s) === normalizeState(state));
  const active = config.tracker.activeStates;
  const reviewStates = config.review?.states ?? [];
  const implementer = (state: string) => has(active, state) && !has(reviewStates, state);

  const blocked = settings.blockedState;
  if (blocked && has(active, blocked)) error(`tracker.provider.blocked_state "${blocked}" must not be an active state: halted cards are moved there to take them away from agents`);
  if (blocked && config.mergeConflicts && has(config.mergeConflicts.states, blocked)) {
    error(`tracker.provider.blocked_state "${blocked}" must not be in merge_conflicts.states: a halted card with a conflicting pull request would start again with fresh run limits`);
  }
  const handoff = settings.handoffState;
  if (handoff && implementer(handoff)) error(`tracker.provider.handoff_state "${handoff}" must not be an implementer state: the agent would start again right after submitting`);
  if (config.review) {
    if (!handoff) warn("tracker.provider.handoff_state is not set: submitted cards never reach the review agent");
    else if (!has(reviewStates, handoff)) warn(`tracker.provider.handoff_state "${handoff}" is not a review state: submissions skip the review agent`);
    if (has(active, config.review.passState)) error(`review.pass_state "${config.review.passState}" must not be an active state: approved work would be picked up again`);
    if (!implementer(config.review.failState)) error(`review.fail_state "${config.review.failState}" must be an active state worked by the implementer`);
  }
  const dispatchLabels = new Set(config.tracker.requiredLabels);
  for (const label of settings.followups?.labels ?? []) {
    if (dispatchLabels.has(label.trim().toLowerCase())) {
      error(`tracker.provider.followups.labels includes "${label}" from tracker.required_labels: follow-ups would be worked on without a person deciding`);
    }
  }
  if (dispatchLabels.size === 0) warn("tracker.required_labels is empty: every open issue in an active column is worked on");
}

function sampleIssue(config: ServiceConfig | null, settings: GitHubProjectSettings | null): Issue {
  const prefix = settings?.identifierPrefix ?? "GH-";
  return {
    id: "PVTI_sample",
    nativeRef: { project_item_id: "PVTI_sample", issue_id: "I_sample", issue_number: 1, repository: settings ? `${settings.repoOwner}/${settings.repoName}` : "owner/repo" },
    identifier: `${prefix}1`,
    title: "Sample issue",
    description: "Sample description.",
    priority: 2,
    state: config?.tracker.activeStates[0] ?? "Todo",
    branchName: `${settings?.branchPrefix ?? "agent/"}1`,
    url: "https://github.com/owner/repo/issues/1",
    assigneeId: "someone",
    labels: config?.tracker.requiredLabels ?? [],
    blockedBy: [],
    dispatchable: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** Renders every template once per branch of `attempt`; strict Liquid reports unknown variables and filters. */
function checkTemplates(definition: WorkflowDefinition, config: ServiceConfig | null, settings: GitHubProjectSettings | null, error: (m: string) => void, warn: (m: string) => void): void {
  const issue = sampleIssue(config, settings);
  const reported = new Set<string>();
  const render = (label: string, fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      const message = `${label}: ${(e as Error).message}`;
      if (!reported.has(message)) error(message);
      reported.add(message);
    }
  };
  if (definition.promptTemplate.trim() === "") warn("the prompt (the Markdown after the front matter) is empty: agents get a generic one-line prompt");
  for (const attempt of [null, 2]) render("prompt", () => renderIssuePrompt(definition.promptTemplate, issue, attempt));
  if (!config) return;
  render("agent.continuation_prompt", () => renderContinuationPrompt(config.agent.continuationPrompt, issue, 2, config.agent.maxTurns));
  const review = config.review;
  if (!review) return;
  if (!existsSync(review.promptFile)) {
    error(`review.prompt_file ${review.promptFile} does not exist`);
  } else {
    const template = readFileSync(review.promptFile, "utf8");
    for (const attempt of [null, 2]) {
      render("review.prompt_file", () => renderTemplate(template, {
        issue: issueForTemplate(issue), attempt, review_round: 1, max_review_rounds: review.maxRounds, implementer_workspace: `${config.workspace.root}/${issue.identifier}`,
      }));
    }
  }
  render("review.continuation_prompt", () => renderContinuationPrompt(review.continuationPrompt, issue, 2, config.agent.maxTurns));
}
