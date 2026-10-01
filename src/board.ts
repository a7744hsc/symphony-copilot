import { readFileSync, writeFileSync } from "node:fs";
import { isMap as isYamlMap, isScalar, parseDocument } from "yaml";
import { checkWorkflow, type CheckResult, type Finding } from "./check.ts";
import type { ServiceConfig } from "./config.ts";
import { graphqlRequest, restRequest, type FetchLike, type GitHubApi } from "./tracker/github-api.ts";
import type { GitHubProjectSettings } from "./tracker/github-project.ts";
import { normalizeState } from "./types.ts";

export type StateRole = "other" | "start" | "implement" | "review" | "waiting" | "blocked" | "terminal";

export interface BoardState {
  name: string;
  role: StateRole;
  /** The first WORKFLOW.md key that names this column. */
  source: string;
}

interface Option {
  name: string;
  color: string;
  description: string;
}

export interface DesiredBoard {
  statusOptions: Option[];
  priorityOptions: Option[];
  labels: Option[];
}

export interface BoardSnapshot {
  project: {
    id: string;
    title: string;
    url: string;
    closed: boolean;
    itemCount: number;
    /** Null when the status field is missing or not single-select. */
    statusOptions: string[] | null;
    priority: { dataType: string; options: string[] } | null;
    workflows: Array<{ name: string; enabled: boolean }>;
  } | null;
  repo: { id: string; labels: string[] } | null;
}

const ROLE_RANK: Record<StateRole, number> = { other: 0, start: 1, implement: 1, review: 1, waiting: 2, blocked: 3, terminal: 4 };
const ROLE_COLOR: Record<StateRole, string> = { other: "GRAY", start: "YELLOW", implement: "BLUE", review: "PURPLE", waiting: "ORANGE", blocked: "RED", terminal: "GREEN" };
const PRIORITY_COLORS = ["RED", "ORANGE", "YELLOW", "GRAY"];

/** Every column the workflow names, in board order: other, active (as listed), waiting, blocked, terminal. */
export function boardStates(config: ServiceConfig, settings: GitHubProjectSettings): BoardState[] {
  const has = (list: Array<string | null | undefined>, state: string) => list.some((s) => s && normalizeState(s) === normalizeState(state));
  const waiting = [settings.handoffState, config.review?.passState, ...(config.mergeConflicts?.states ?? [])];
  const role = (state: string): StateRole => {
    if (has([settings.startState], state)) return "start";
    if (has(config.tracker.activeStates, state)) return has(config.review?.states ?? [], state) ? "review" : "implement";
    if (has(config.tracker.terminalStates, state)) return "terminal";
    if (has([settings.blockedState], state)) return "blocked";
    return has(waiting, state) ? "waiting" : "other";
  };
  const named: Array<[string | null | undefined, string]> = [
    ...config.tracker.activeStates.map((s): [string, string] => [s, "tracker.active_states"]),
    [settings.startState, "tracker.provider.start_state"],
    [settings.workingState, "tracker.provider.working_state"],
    [settings.handoffState, "tracker.provider.handoff_state"],
    [config.review?.passState, "review.pass_state"],
    ...(config.mergeConflicts?.states ?? []).map((s): [string, string] => [s, "merge_conflicts.states"]),
    [settings.blockedState, "tracker.provider.blocked_state"],
    ...settings.agentStates.map((s): [string, string] => [s, "tracker.provider.agent_states"]),
    [settings.followups?.state, "tracker.provider.followups.state"],
    ...config.tracker.terminalStates.map((s): [string, string] => [s, "tracker.terminal_states"]),
  ];
  const seen = new Set<string>();
  const states: BoardState[] = [];
  for (const [name, source] of named) {
    if (!name?.trim() || seen.has(normalizeState(name))) continue;
    seen.add(normalizeState(name));
    states.push({ name: name.trim(), role: role(name), source });
  }
  return states.sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role]);
}

export function desiredBoard(config: ServiceConfig, settings: GitHubProjectSettings): DesiredBoard {
  const label = config.tracker.requiredLabels[0];
  const describe: Record<StateRole, string> = {
    other: "Not worked on by agents",
    start: `Human start or reauthorization entry${label ? `; requires label "${label}"` : ""}`,
    implement: `Scheduler-managed implementation${label ? `; requires label "${label}"` : ""}; do not move cards manually`,
    review: "Scheduler-managed independent review; do not move cards manually",
    waiting: `Waiting for a person; move to "${settings.startState}" to reauthorize`,
    blocked: `Stopped; a person resolves the blocker, then moves to "${settings.startState}"`,
    terminal: "Finished",
  };
  const states = boardStates(config, settings);
  const firstTerminal = states.find((s) => s.role === "terminal");
  const statusOptions = states.map((s) => ({
    name: s.name,
    color: s.role === "terminal" && s !== firstTerminal ? "GRAY" : ROLE_COLOR[s.role],
    description: describe[s.role],
  }));
  const priorities = ["P1", "P2", "P3", "P4"];
  const followupPriority = settings.followups?.priority;
  if (followupPriority && !priorities.some((p) => p.toLowerCase() === followupPriority.toLowerCase())) priorities.push(followupPriority);
  const priorityOptions = priorities.map((name, i) => ({ name, color: PRIORITY_COLORS[i] ?? "GRAY", description: i === 0 ? "Runs first" : "" }));
  const labels: Option[] = config.tracker.requiredLabels.map((name) => ({ name, color: "0E8A16", description: "symphony-copilot works on issues with this label" }));
  for (const name of settings.followups?.labels ?? []) {
    if (!labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) labels.push({ name, color: "C5DEF5", description: "Filed by an agent; a person decides when to work on it" });
  }
  return { statusOptions, priorityOptions, labels };
}

function ownerField(settings: GitHubProjectSettings): string {
  return settings.ownerType === "user" ? "user" : "organization";
}

export async function readBoard(api: GitHubApi, settings: GitHubProjectSettings): Promise<BoardSnapshot> {
  const data: any = await graphqlRequest(api,
    `query($login: String!, $number: Int!, $owner: String!, $name: String!, $status: String!, $priority: String!) {
      account: ${ownerField(settings)}(login: $login) { projectV2(number: $number) {
        id title url closed items(first: 1) { totalCount }
        status: field(name: $status) { ... on ProjectV2SingleSelectField { options { name } } }
        priority: field(name: $priority) { ... on ProjectV2SingleSelectField { dataType options { name } } ... on ProjectV2Field { dataType } }
        workflows(first: 50) { nodes { name enabled } } } }
      repository(owner: $owner, name: $name) { id labels(first: 100) { nodes { name } } } }`,
    { login: settings.owner, number: settings.projectNumber, owner: settings.repoOwner, name: settings.repoName, status: settings.statusField, priority: settings.priorityField },
    { allowNotFound: true },
  );
  const p = data?.account?.projectV2;
  const repo = data?.repository;
  const names = (nodes: unknown): string[] => (Array.isArray(nodes) ? nodes : []).filter((n: any) => typeof n?.name === "string").map((n: any) => n.name);
  return {
    project: p?.id ? {
      id: p.id,
      title: p.title ?? "",
      url: p.url ?? "",
      closed: Boolean(p.closed),
      itemCount: p.items?.totalCount ?? 0,
      statusOptions: Array.isArray(p.status?.options) ? names(p.status.options) : null,
      priority: p.priority?.dataType ? { dataType: p.priority.dataType, options: names(p.priority.options) } : null,
      workflows: (p.workflows?.nodes ?? []).filter((w: any) => typeof w?.name === "string").map((w: any) => ({ name: w.name, enabled: Boolean(w.enabled) })),
    } : null,
    repo: repo?.id ? { id: repo.id, labels: names(repo.labels?.nodes) } : null,
  };
}

export function boardFindings(config: ServiceConfig, settings: GitHubProjectSettings, snapshot: BoardSnapshot): Finding[] {
  const findings: Finding[] = [];
  const error = (message: string) => findings.push({ level: "error", message });
  const warn = (message: string) => findings.push({ level: "warning", message });
  const same = (a: string, b: string) => normalizeState(a) === normalizeState(b);
  const repoName = `${settings.repoOwner}/${settings.repoName}`;
  const p = snapshot.project;
  if (!p) {
    error(`board ${settings.owner}#${settings.projectNumber} was not found or is not accessible (check owner_type, and that the token has the project scope)`);
  } else {
    if (p.closed) warn(`board ${p.url} is closed`);
    if (!p.statusOptions) {
      error(`the board has no single-select field "${settings.statusField}" (tracker.provider.status_field)`);
    } else {
      for (const state of boardStates(config, settings)) {
        if (!p.statusOptions.some((o) => same(o, state.name))) error(`column "${state.name}" (${state.source}) is not an option of the board's "${settings.statusField}" field`);
      }
    }
    const followupPriority = settings.followups?.priority;
    if (!p.priority) {
      warn(`the board has no "${settings.priorityField}" field (tracker.provider.priority_field): cards are not ordered by priority`);
    } else if (followupPriority && p.priority.dataType === "SINGLE_SELECT" && !p.priority.options.some((o) => same(o, followupPriority))) {
      error(`priority "${followupPriority}" (tracker.provider.followups.priority) is not an option of the board's "${settings.priorityField}" field`);
    }
    const workflow = (name: string) => p.workflows.find((w) => same(w.name, name));
    if (workflow("Pull request linked to issue")?.enabled) {
      warn(config.review
        ? `project workflow "Pull request linked to issue" is enabled: it may move the card when the agent opens its pull request, potentially skipping the review agent; inspect it at ${p.url}/workflows if status transitions are unexpected`
        : `project workflow "Pull request linked to issue" is enabled: it may move the card when the agent opens its pull request instead of to "${settings.handoffState ?? "the handoff column"}"; inspect it at ${p.url}/workflows if status transitions are unexpected`);
    }
  }
  if (!snapshot.repo) {
    error(`repository ${repoName} was not found or is not accessible`);
  } else {
    const labels = snapshot.repo.labels;
    const exists = (label: string) => labels.some((l) => l.toLowerCase() === label.toLowerCase());
    for (const label of config.tracker.requiredLabels) {
      if (!exists(label)) error(`label "${label}" (tracker.required_labels) does not exist in ${repoName}`);
    }
    for (const label of settings.followups?.labels ?? []) {
      if (!exists(label)) warn(`label "${label}" (tracker.provider.followups.labels) does not exist in ${repoName}; follow-ups are filed without it`);
    }
  }
  return findings;
}

/** `symphony check --online`: compares the board with the workflow. */
export async function checkBoard(result: CheckResult, fetchImpl: FetchLike = fetch): Promise<Finding[]> {
  const { config, settings } = result;
  if (!config || !settings) return [];
  if (!result.tokenAvailable) return [{ level: "error", message: "the board check needs a GitHub token (bin/symphony takes it from `gh auth token`)" }];
  if (!result.hasProjectNumber) return [{ level: "error", message: "no board yet: run `symphony setup-board` to create it" }];
  try {
    const snapshot = await readBoard({ endpoint: settings.endpoint, token: settings.token, fetchImpl }, settings);
    return boardFindings(config, settings, snapshot);
  } catch (e) {
    return [{ level: "error", message: `could not read the board: ${(e as Error).message}` }];
  }
}

/** Sets tracker.provider.project_number in the front matter and leaves every other byte alone. */
export function writeProjectNumber(text: string, projectNumber: number): string {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) throw new Error("WORKFLOW.md has no front matter");
  const start = open[0].length;
  const close = /^---[ \t]*\r?$/m.exec(text.slice(start));
  if (!close) throw new Error("the front matter is not closed with ---");
  const end = start + close.index;
  const front = text.slice(start, end);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const provider = parseDocument(front).getIn(["tracker", "provider"], true);
  if (!isYamlMap(provider) || provider.flow) throw new Error("tracker.provider is not a block map; set project_number by hand");
  const pairNamed = (key: string) => provider.items.find((p) => isScalar(p.key) && p.key.value === key);
  const pair = pairNamed("project_number");
  let updated: string;
  if (pair && isScalar(pair.value) && pair.value.range && pair.value.range[1] > pair.value.range[0]) {
    const [from, to] = pair.value.range;
    updated = front.slice(0, from) + projectNumber + front.slice(to);
  } else if (pair && isScalar(pair.key) && pair.key.range) {
    const colon = front.indexOf(":", pair.key.range[1]);
    updated = `${front.slice(0, colon + 1)} ${projectNumber}${front.slice(colon + 1)}`;
  } else {
    const anchor = pairNamed("owner_type") ?? pairNamed("owner") ?? provider.items[0];
    if (!anchor || !isScalar(anchor.key) || !anchor.key.range) throw new Error("tracker.provider is empty; set project_number by hand");
    const keyStart = anchor.key.range[0];
    const indent = front.slice(front.lastIndexOf("\n", keyStart - 1) + 1, keyStart);
    const valueEnd = isScalar(anchor.value) && anchor.value.range ? anchor.value.range[1] : anchor.key.range[1];
    let lineEnd = front.indexOf("\n", valueEnd);
    if (lineEnd < 0) lineEnd = front.length;
    else if (front[lineEnd - 1] === "\r") lineEnd--;
    updated = `${front.slice(0, lineEnd)}${eol}${indent}project_number: ${projectNumber}${front.slice(lineEnd)}`;
  }
  if (parseDocument(updated).getIn(["tracker", "provider", "project_number"]) !== projectNumber) {
    throw new Error("could not write tracker.provider.project_number; set it by hand");
  }
  return text.slice(0, start) + updated + text.slice(end);
}

interface Prepared {
  ownerId: string;
  repoId: string;
  labels: string[];
}

async function prepare(api: GitHubApi, settings: GitHubProjectSettings): Promise<Prepared> {
  const data: any = await graphqlRequest(api,
    `query($login: String!, $owner: String!, $name: String!) {
      account: ${ownerField(settings)}(login: $login) { id }
      repository(owner: $owner, name: $name) { id labels(first: 100) { nodes { name } } } }`,
    { login: settings.owner, owner: settings.repoOwner, name: settings.repoName },
  );
  return {
    ownerId: data?.account?.id,
    repoId: data?.repository?.id,
    labels: (data?.repository?.labels?.nodes ?? []).filter((n: any) => typeof n?.name === "string").map((n: any) => n.name),
  };
}

/** Creates the board, calling `onCreated` as soon as it has a number so a later failure can be retried. */
async function createBoard(api: GitHubApi, settings: GitHubProjectSettings, desired: DesiredBoard, title: string, prepared: Prepared, onCreated: (number: number) => void): Promise<{ url: string; labelsCreated: string[] }> {
  const created: any = await graphqlRequest(api,
    `mutation($owner: ID!, $title: String!, $repo: ID!) { createProjectV2(input: { ownerId: $owner, title: $title, repositoryId: $repo }) { projectV2 { id number url } } }`,
    { owner: prepared.ownerId, title, repo: prepared.repoId },
  );
  const project = created?.createProjectV2?.projectV2;
  if (!project?.id || !Number.isInteger(project.number)) throw new Error("GitHub did not return the new board");
  onCreated(project.number);
  const fields: any = await graphqlRequest(api,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { field(name: "Status") { ... on ProjectV2SingleSelectField { id } } } } }`,
    { id: project.id },
  );
  const statusFieldId = fields?.node?.field?.id;
  if (!statusFieldId) throw new Error("the new board has no Status field");
  await graphqlRequest(api,
    `mutation($field: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
      updateProjectV2Field(input: { fieldId: $field, name: $name, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
    { field: statusFieldId, name: settings.statusField, options: desired.statusOptions },
  );
  await graphqlRequest(api,
    `mutation($project: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
      createProjectV2Field(input: { projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
    { project: project.id, name: settings.priorityField, options: desired.priorityOptions },
  );
  const labelsCreated: string[] = [];
  for (const label of desired.labels) {
    if (prepared.labels.some((l) => l.toLowerCase() === label.name.toLowerCase())) continue;
    await restRequest(api, "POST", `/repos/${settings.repoOwner}/${settings.repoName}/labels`, label);
    labelsCreated.push(label.name);
  }
  return { url: project.url, labelsCreated };
}

export function workflowNotes(url: string): string[] {
  return [
    "GitHub Project workflows are separate from WORKFLOW.md and may change card statuses automatically.",
    "setup-board cannot configure or enable them because GitHub's public API does not expose workflow configuration. No workflow changes are required.",
    `If a card changes status unexpectedly or skips a Symphony stage, inspect enabled workflows at ${url}/workflows; they may be the cause.`,
    `Then add a Board view (New view > Board) to see the columns.`,
  ];
}

export interface SetupOptions {
  path: string;
  env: NodeJS.ProcessEnv;
  /** Returns null when nobody can answer (not a terminal). */
  ask: (question: string) => Promise<string | null>;
  print: (line: string) => void;
  fetchImpl?: FetchLike;
  /** Skip the final confirmation; deleting a board still needs its number typed. */
  yes?: boolean;
  title?: string;
}

/** `symphony setup-board`: creates the board WORKFLOW.md describes and writes its number back. */
export async function setupBoard(o: SetupOptions): Promise<number> {
  const checked = checkWorkflow(o.path, o.env);
  const errors = checked.findings.filter((f) => f.level === "error");
  const { config, settings } = checked;
  if (errors.length > 0 || !config || !settings) {
    o.print(`${o.path} has problems; fix them first (symphony check):`);
    for (const f of errors) o.print(`  ${f.message}`);
    return 1;
  }
  if (!checked.tokenAvailable) {
    o.print("No GitHub token: run 'gh auth login' and 'gh auth refresh -s project', or set SYMPHONY_GITHUB_TOKEN.");
    return 1;
  }
  const api: GitHubApi = { endpoint: settings.endpoint, token: settings.token, fetchImpl: o.fetchImpl ?? fetch };

  let replace: { id: string; number: number; title: string } | null = null;
  if (checked.hasProjectNumber) {
    const existing = (await readBoard(api, settings)).project;
    if (existing) {
      o.print(`Board ${settings.owner}#${settings.projectNumber} already exists: "${existing.title}" ${existing.url} (${existing.itemCount} cards).`);
      const choice = await o.ask("Delete it and create a new one [d], or exit [E]? ");
      if (choice === null) {
        o.print("Not running in a terminal; nothing changed.");
        return 1;
      }
      if (choice.trim().toLowerCase() !== "d") {
        o.print("Nothing changed.");
        return 0;
      }
      const typed = await o.ask(`Deleting removes the board with every card's status and fields; the issues stay. Type ${settings.projectNumber} to confirm: `);
      if (typed?.trim() !== String(settings.projectNumber)) {
        o.print("The number did not match; nothing changed.");
        return 1;
      }
      replace = { id: existing.id, number: settings.projectNumber, title: existing.title };
    } else {
      o.print(`Board ${settings.owner}#${settings.projectNumber} does not exist; the new board gets a new number.`);
    }
  }

  const desired = desiredBoard(config, settings);
  const prepared = await prepare(api, settings);
  if (!prepared.ownerId) throw new Error(`${settings.ownerType} ${settings.owner} not found (tracker.provider.owner, owner_type)`);
  if (!prepared.repoId) throw new Error(`repository ${settings.repoOwner}/${settings.repoName} not found (tracker.provider.repo)`);
  const title = o.title ?? settings.repoName;
  const hasLabel = (name: string) => prepared.labels.some((l) => l.toLowerCase() === name.toLowerCase());
  o.print("");
  if (replace) o.print(`Delete board ${replace.number} "${replace.title}", then:`);
  o.print(`Create a board for ${settings.repoOwner}/${settings.repoName}, owned by ${settings.owner} (${settings.ownerType}):`);
  o.print(`  Title:    ${title}`);
  o.print(`  ${settings.statusField}:   ${desired.statusOptions.map((s) => s.name).join(", ")}`);
  o.print(`  ${settings.priorityField}: ${desired.priorityOptions.map((s) => s.name).join(", ")}`);
  if (desired.labels.length > 0) o.print(`  Labels:   ${desired.labels.map((l) => `${l.name} (${hasLabel(l.name) ? "exists" : "new"})`).join(", ")}`);
  o.print(`  Then write its number to ${o.path}.`);
  if (!o.yes) {
    const answer = await o.ask("Go ahead? [y/N] ");
    if (answer?.trim().toLowerCase() !== "y") {
      o.print("Nothing changed.");
      return answer === null ? 1 : 0;
    }
  }

  if (replace) {
    await graphqlRequest(api, `mutation($id: ID!) { deleteProjectV2(input: { projectId: $id }) { projectV2 { id } } }`, { id: replace.id });
    o.print(`Deleted board ${replace.number}.`);
  }
  let created: number | null = null;
  const result = await createBoard(api, settings, desired, title, prepared, (number) => {
    writeFileSync(o.path, writeProjectNumber(readFileSync(o.path, "utf8"), number));
    created = number;
    o.print(`Created board ${number}. Wrote project_number: ${number} to ${o.path} (tracker.provider.project_number).`);
  }).catch((error: Error) => {
    if (created !== null) o.print(`Board ${created} was created, but setting it up failed. Run setup-board again and choose [d] to start over.`);
    throw error;
  });
  o.print(`Set up ${result.url}${result.labelsCreated.length > 0 ? `; created labels ${result.labelsCreated.join(", ")}` : ""}.`);
  o.print("");
  for (const line of workflowNotes(result.url)) o.print(line);
  o.print("");
  o.print("Next: commit WORKFLOW.md, run `symphony check --online`, then do a dry run.");
  return 0;
}
