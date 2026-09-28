import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionEvent } from "@github/copilot-sdk";
import { isActiveState, isRoutable, type ServiceConfig } from "./config.ts";
import { truncate, type Logger } from "./log.ts";
import { createPermissionHandler } from "./policy.ts";
import { renderContinuationPrompt, renderIssuePrompt } from "./template.ts";
import type { TrackerAdapter } from "./tracker/index.ts";
import type { Issue } from "./types.ts";
import { assertInsideRoot, type WorkspaceManager } from "./workspace.ts";

export type RunErrorCode =
  | "startup_failed"
  | "response_timeout"
  | "response_error"
  | "turn_timeout"
  | "turn_failed"
  | "turn_cancelled"
  | "budget_exhausted"
  | "issue_refresh_failed"
  | "canceled";

export class RunError extends Error {
  readonly code: RunErrorCode;
  constructor(code: RunErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}

/** What one Copilot session used, reported when it ends. */
export interface SessionSummary {
  sessionId: string;
  turns: number;
  models: Array<{ model: string; requests: number; aiCredits: number }>;
  aiCredits: number;
  premiumRequests: number | null;
  inputTokens: number;
  outputTokens: number;
  code: { linesAdded: number; linesRemoved: number; files: number } | null;
  /** Card state from the last refresh inside the session. */
  finalState: string;
}

/** Update sent upstream to the orchestrator (spec §10.4). Token counts are absolute per session. */
export interface AgentUpdate {
  event: string;
  timestamp: Date;
  sessionId?: string;
  turn?: number;
  message?: string;
  tokens?: TokenTotals;
  /** Absolute AI credits used by this session so far. */
  aiCredits?: number;
  summary?: SessionSummary;
  rateLimits?: unknown;
}

export interface AttemptParams {
  issue: Issue;
  attempt: number | null;
  config: ServiceConfig;
  promptTemplate: string;
  tracker: TrackerAdapter;
  workspaces: WorkspaceManager;
  /** Environment for the Copilot runtime, already scrubbed of tracker secrets. */
  childEnv: Record<string, string>;
  signal: AbortSignal;
  log: Logger;
  onUpdate(update: AgentUpdate): void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunError("response_timeout", `${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Short human summary of an event for status output; never used for decisions. */
function summarize(event: SessionEvent): string | undefined {
  switch (event.type) {
    case "assistant.message": return truncate(event.data.content ?? "", 300);
    case "tool.execution_start": return event.data.toolName;
    case "session.error": return event.data.message;
    case "session.task_complete": return event.data.summary ?? "task complete";
    default: return undefined;
  }
}

async function stopClient(client: CopilotClient, log: Logger): Promise<void> {
  try {
    await withTimeout(client.stop(), 10_000, "client.stop");
  } catch (error) {
    log.warn("copilot runtime did not stop cleanly; forcing", { error: (error as Error).message });
    await client.forceStop().catch(() => {});
  }
}

interface TurnOptions {
  session: CopilotSession;
  prompt: string;
  turn: number;
  turnTimeoutMs: number;
  signal: AbortSignal;
  onEvent(event: SessionEvent): void;
}

/** One Symphony turn = one prompt until the main agent is idle; silence longer than turnTimeoutMs fails it. */
function runTurn(o: TurnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: RunError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      o.signal.removeEventListener("abort", onAbort);
      if (error) {
        o.session.abort().catch(() => {});
        reject(error);
      } else {
        resolve();
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new RunError("turn_timeout", `no agent activity for ${o.turnTimeoutMs} ms`)), o.turnTimeoutMs);
    };
    const unsubscribe = o.session.on((event) => {
      if (settled) return;
      arm();
      o.onEvent(event);
      if (event.type === "session.idle" && event.data.mode !== "autopilot") {
        if (event.data.aborted) finish(new RunError("turn_cancelled", "the session reported an aborted turn"));
        else finish();
      } else if (event.type === "session.error") {
        finish(new RunError("turn_failed", event.data.message));
      } else if (event.type === "session_limits_exhausted.requested") {
        o.session.rpc.ui.handlePendingSessionLimitsExhausted({ requestId: event.data.requestId, response: { action: "cancel" } }).catch(() => {});
        finish(new RunError("budget_exhausted", `AI credit budget reached (${event.data.usedAiCredits}/${event.data.maxAiCredits})`));
      }
    });
    const onAbort = () => finish(new RunError("canceled", String(o.signal.reason ?? "canceled by orchestrator")));
    if (o.signal.aborted) return onAbort();
    o.signal.addEventListener("abort", onAbort, { once: true });
    arm();
    o.session.send({ prompt: o.prompt }).catch((error: Error) => finish(new RunError("response_error", error.message)));
  });
}

/** Spec §16.5: workspace -> hooks -> Copilot session -> turn loop -> after_run. Throws on any failure. */
export async function runAgentAttempt(p: AttemptParams): Promise<void> {
  const { config } = p;
  const workspace = await p.workspaces.prepare(config, p.issue);
  await p.workspaces.hook(config, "before_run", workspace, p.issue, true);
  let client: CopilotClient | null = null;
  let session: CopilotSession | null = null;
  let nanoAiu = 0;
  let turns = 0;
  let issue = p.issue;
  const tokens: TokenTotals = { input: 0, output: 0, total: 0 };
  const liveModels = new Map<string, { requests: number; nanoAiu: number }>();
  try {
    assertInsideRoot(config.workspace.root, workspace.path);
    if (p.signal.aborted) throw new RunError("canceled", String(p.signal.reason ?? "canceled"));
    client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: config.copilot.cliPath ?? undefined, env: p.childEnv }),
      workingDirectory: workspace.path,
      logLevel: "warning",
      clientInfo: { applicationName: "symphony-copilot", applicationVersion: "0.1.0" },
    });
    try {
      await withTimeout(client.start(), config.copilot.startupTimeoutMs, "copilot runtime start");
      session = await withTimeout(client.createSession({
        workingDirectory: workspace.path,
        model: config.copilot.model ?? undefined,
        reasoningEffort: (config.copilot.reasoningEffort ?? undefined) as "low" | "medium" | "high" | "xhigh" | "max" | undefined,
        sessionLimits: config.copilot.maxAiCredits ? { maxAiCredits: config.copilot.maxAiCredits } : undefined,
        tools: p.tracker.agentTools({ issue: p.issue, workspacePath: workspace.path, log: p.log }),
        onPermissionRequest: createPermissionHandler({
          workspace: workspace.path,
          shellAllow: config.copilot.shellAllow,
          shellDeny: config.copilot.shellDeny,
          readAllow: config.copilot.readAllow,
          urlAllow: config.copilot.urlAllow,
        }, p.log),
        // Unattended: answer questions with a fixed instruction instead of stalling (spec §10.5).
        onUserInputRequest: () => ({ answer: config.copilot.userInputReply, wasFreeform: true }),
      }), config.copilot.startupTimeoutMs, "session create");
    } catch (error) {
      if (error instanceof RunError) throw error;
      throw new RunError("startup_failed", (error as Error).message);
    }
    const sessionId = session.sessionId;
    p.onUpdate({ event: "session_started", timestamp: new Date(), sessionId });
    client.rpc.account.getQuota({}).then(
      (quota) => p.onUpdate({ event: "rate_limits", timestamp: new Date(), sessionId, rateLimits: quota.quotaSnapshots }),
      () => {},
    );

    for (let turn = 1; ; turn++) {
      const prompt = turn === 1
        ? renderIssuePrompt(p.promptTemplate, issue, p.attempt)
        : renderContinuationPrompt(config.agent.continuationPrompt, issue, turn, config.agent.maxTurns);
      p.onUpdate({ event: "turn_started", timestamp: new Date(), sessionId, turn });
      turns = turn;
      await runTurn({
        session,
        prompt,
        turn,
        turnTimeoutMs: config.copilot.turnTimeoutMs,
        signal: p.signal,
        onEvent: (event) => {
          const update: AgentUpdate = { event: event.type, timestamp: new Date(), sessionId, turn, message: summarize(event) };
          if (event.type === "assistant.usage") {
            tokens.input += event.data.inputTokens ?? 0;
            tokens.output += event.data.outputTokens ?? 0;
            tokens.total = tokens.input + tokens.output;
            update.tokens = { ...tokens };
            nanoAiu += event.data.copilotUsage?.totalNanoAiu ?? 0;
            update.aiCredits = nanoAiu / 1e9;
            const model = liveModels.get(event.data.model) ?? { requests: 0, nanoAiu: 0 };
            model.requests++;
            model.nanoAiu += event.data.copilotUsage?.totalNanoAiu ?? 0;
            liveModels.set(event.data.model, model);
          }
          p.onUpdate(update);
        },
      });
      p.onUpdate({ event: "turn_completed", timestamp: new Date(), sessionId, turn, tokens: { ...tokens } });

      let refreshed: Issue[];
      try {
        refreshed = await p.tracker.fetchIssuesByIds([issue.id]);
      } catch (error) {
        throw new RunError("issue_refresh_failed", (error as Error).message);
      }
      if (refreshed.length === 0) break;
      issue = refreshed[0]!;
      if (!isActiveState(config, issue.state) || !isRoutable(config, issue)) break;
      if (turn >= config.agent.maxTurns) break;
    }
  } finally {
    if (session) {
      const metrics = await session.rpc.usage.getMetrics().catch(() => null);
      if (metrics) {
        p.log.info("session usage", {
          premium_requests: metrics.totalPremiumRequestCost,
          ai_credits: metrics.totalNanoAiu === undefined ? null : Number((metrics.totalNanoAiu / 1e9).toFixed(4)),
        });
      }
      const finalNanoAiu = Math.max(nanoAiu, metrics?.totalNanoAiu ?? 0);
      const models = metrics && Object.keys(metrics.modelMetrics).length > 0
        ? Object.entries(metrics.modelMetrics).map(([model, m]) => ({ model, requests: m?.requests.count ?? 0, aiCredits: (m?.totalNanoAiu ?? 0) / 1e9 }))
        : [...liveModels].map(([model, m]) => ({ model, requests: m.requests, aiCredits: m.nanoAiu / 1e9 }));
      const summary: SessionSummary = {
        sessionId: session.sessionId,
        turns,
        models,
        aiCredits: finalNanoAiu / 1e9,
        premiumRequests: metrics?.totalPremiumRequestCost ?? null,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        code: metrics ? { linesAdded: metrics.codeChanges.linesAdded, linesRemoved: metrics.codeChanges.linesRemoved, files: metrics.codeChanges.filesModified.length } : null,
        finalState: issue.state,
      };
      p.onUpdate({ event: "session_usage", timestamp: new Date(), sessionId: session.sessionId, aiCredits: summary.aiCredits, summary });
      await session.disconnect().catch(() => {});
    }
    if (client) await stopClient(client, p.log);
    await p.workspaces.hook(config, "after_run", workspace, p.issue, false);
  }
}
