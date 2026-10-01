import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection, type CopilotSession, type SessionEvent } from "@github/copilot-sdk";
import { isActiveState, isRoutable, roleFor, type Role, type ServiceConfig } from "./config.ts";
import { truncate, type Logger } from "./log.ts";
import { outputLanguageInstruction } from "./language.ts";
import { createPermissionHandler, isInside } from "./policy.ts";
import { composeAgentPrompt, renderContinuationPrompt, renderIssuePrompt, renderTemplate } from "./template.ts";
import type { TrackerAdapter } from "./tracker/index.ts";
import type { AgentControl } from "./tracker/types.ts";
import { issueForTemplate, type Issue } from "./types.ts";
import { assertInsideRoot, workspacePath, type WorkspaceManager } from "./workspace.ts";

export type RunErrorCode =
  | "startup_failed"
  | "response_timeout"
  | "response_error"
  | "turn_timeout"
  | "turn_failed"
  | "turn_cancelled"
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
  /** True only when final usage and actual model names were observed, never inferred from defaults. */
  usageComplete?: boolean;
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
  role?: Role;
  reviewRound?: number;
  control?: AgentControl;
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

/** Read at every dispatch so edits apply without a restart, like WORKFLOW.md. */
function readReviewPrompt(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new RunError("startup_failed", `cannot read review.prompt_file ${path}: ${(error as Error).message}`);
  }
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

async function stopClient(client: CopilotClient, log: Logger): Promise<boolean> {
  try {
    const errors = await withTimeout(client.stop(), 10_000, "client.stop");
    if (errors.length > 0) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
    return true;
  } catch (error) {
    log.warn("copilot runtime did not stop cleanly; forcing", { error: (error as Error).message });
    try {
      await withTimeout(client.forceStop(), 10_000, "client.forceStop");
      return true;
    } catch (error) {
      log.warn("copilot runtime force stop failed", { error: (error as Error).message });
      return false;
    }
  }
}

interface TurnOptions {
  session: CopilotSession;
  prompt: string;
  turn: number;
  turnTimeoutMs: number;
  signal: AbortSignal;
  control?: AgentControl;
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
      if (event.type === "session.idle" && event.data.mode !== "autopilot") {
        if (event.data.aborted) finish(new RunError("turn_cancelled", "the session reported an aborted turn"));
        else finish();
      } else if (event.type === "session.error") {
        finish(new RunError("turn_failed", event.data.message));
      } else if (event.type === "session_limits_exhausted.requested") {
        o.session.rpc.ui.handlePendingSessionLimitsExhausted({ requestId: event.data.requestId, response: { action: "cancel" } }).catch(() => {});
        finish(new RunError("turn_failed", `provider session limit reached (${event.data.usedAiCredits}/${event.data.maxAiCredits})`));
      }
    });
    const onAbort = () => finish(new RunError("canceled", String(o.signal.reason ?? "canceled by orchestrator")));
    if (o.signal.aborted) return onAbort();
    o.signal.addEventListener("abort", onAbort, { once: true });
    if (o.control?.accepted()) return finish();
    try { o.control?.assertActive(); } catch (error) { return finish(new RunError("canceled", (error as Error).message)); }
    arm();
    o.session.send({ prompt: o.prompt }).catch((error: Error) => finish(new RunError("response_error", error.message)));
  });
}

/** Spec §16.5: workspace -> hooks -> Copilot session -> turn loop -> after_run. Throws on any failure. */
export async function runAgentAttempt(p: AttemptParams): Promise<void> {
  const { config } = p;
  const role = p.role ?? "implement";
  const review = role === "review" ? config.review : null;
  if (role === "review" && !review) throw new RunError("startup_failed", "dispatched as reviewer but the workflow has no review block");
  p.onUpdate({ event: "startup_phase", timestamp: new Date(), message: "workspace_prepare" });
  const workspace = await p.workspaces.prepare(config, p.issue, role);
  p.onUpdate({ event: "startup_phase", timestamp: new Date(), message: "before_run" });
  await p.workspaces.hook(config, "before_run", workspace, p.issue, true);
  let client: CopilotClient | null = null;
  let session: CopilotSession | null = null;
  let outputDirectory: string | null = null;
  let nanoAiu = 0;
  let turns = 0;
  let issue = p.issue;
  let unsubscribe: (() => void) | undefined;
  let pendingStartup: Promise<void> | null = null;
  let startupUncertain = false;
  let startupSettled = false;
  let cleanupConfirmed = true;
  const markStartupUncertain = (phase: string) => {
    if (startupUncertain) return;
    startupUncertain = true;
    p.onUpdate({ event: "startup_uncertain", timestamp: new Date(), message: phase });
  };
  const settleStartup = () => {
    if (startupSettled) return;
    startupSettled = true;
    p.onUpdate({ event: "startup_settled", timestamp: new Date() });
  };
  let usageObserved = false;
  const tokens: TokenTotals = { input: 0, output: 0, total: 0 };
  const liveModels = new Map<string, { requests: number; nanoAiu: number }>();
  const usageIds = new Set<string>();
  const validUsage = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  // Timeout/abort is not cancellation of an SDK RPC. Retain its promise and clean up late success.
  const startup = async <T>(begin: () => Promise<T>, phase: string, late: (value: T) => Promise<boolean>): Promise<T> => {
    p.onUpdate({ event: "startup_phase", timestamp: new Date(), message: phase });
    const promise = begin();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new RunError("canceled", String(p.signal.reason ?? "canceled")));
      if (p.signal.aborted) onAbort();
      else p.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await withTimeout(Promise.race([promise, aborted]), config.copilot.startupTimeoutMs, phase);
    } catch (error) {
      if (error instanceof RunError && (error.code === "response_timeout" || error.code === "canceled")) {
        // A rejected late RPC also requires cleanup: rejection does not prove the runtime stopped.
        pendingStartup = promise.then(late, () => cleanupLate()).then((cleaned) => {
          if (cleaned) settleStartup();
        }).catch((error: Error) => {
          p.log.warn("late startup cleanup failed", { phase, error: error.message });
        });
        markStartupUncertain(phase);
      }
      throw error;
    } finally {
      p.signal.removeEventListener("abort", onAbort);
    }
  };
  const cleanupLate = async (lateSession?: CopilotSession): Promise<boolean> => {
    let cleaned = true;
    try {
      if (lateSession) {
        try {
          p.onUpdate({ event: "session_created_late", timestamp: new Date(), sessionId: lateSession.sessionId });
          if (p.control) await withTimeout(p.control.onSessionCreated(lateSession.sessionId), 10_000, "late session confirmation");
        } catch (error) {
          p.log.warn("late session confirmation failed", { session_id: lateSession.sessionId, error: (error as Error).message });
        } finally {
          await withTimeout(lateSession.abort(), 10_000, "late session.abort").catch((error: Error) => {
            cleaned = false;
            p.log.warn("late session abort failed", { error: error.message });
          });
          await withTimeout(lateSession.disconnect(), 10_000, "late session.disconnect").catch((error: Error) => {
            cleaned = false;
            p.log.warn("late session disconnect failed", { error: error.message });
          });
        }
      }
    } finally {
      if (client) cleaned = await stopClient(client, p.log) && cleaned;
      if (outputDirectory) await fs.rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
    }
    return cleaned;
  };
  try {
    assertInsideRoot(config.workspace.root, workspace.path);
    if (p.signal.aborted) throw new RunError("canceled", String(p.signal.reason ?? "canceled"));
    try {
      p.onUpdate({ event: "startup_phase", timestamp: new Date(), message: "session_output" });
      // Keep runtime-written output out of git workspaces and grant access to only this attempt.
      outputDirectory = await fs.mkdtemp(join(tmpdir(), "symphony-output-"));
      outputDirectory = await fs.realpath(outputDirectory);
      await fs.chmod(outputDirectory, 0o700);
      if (isInside(outputDirectory, [config.workspace.root], workspace.path)) {
        throw new RunError("startup_failed", "the session output directory must be outside the workspace root; check TMPDIR");
      }
      if (p.signal.aborted) throw new RunError("canceled", String(p.signal.reason ?? "canceled"));
      client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: config.copilot.cliPath ?? undefined, env: p.childEnv }),
        workingDirectory: workspace.path,
        logLevel: "warning",
        clientInfo: { applicationName: "symphony-copilot", applicationVersion: "0.1.0" },
      });
      await startup(() => client!.start(), "runtime_start", () => cleanupLate());
      if (p.signal.aborted) throw new RunError("canceled", String(p.signal.reason ?? "canceled"));
      const implementerWorkspace = workspacePath(config.workspace.root, p.issue.identifier);
      p.control?.assertActive();
      session = await startup(() => client!.createSession({
        sessionId: p.control?.id,
        workingDirectory: workspace.path,
        model: (review?.model ?? config.copilot.model) ?? undefined,
        reasoningEffort: ((review?.reasoningEffort ?? config.copilot.reasoningEffort) ?? undefined) as "low" | "medium" | "high" | "xhigh" | "max" | undefined,
        largeOutput: { enabled: true, maxSizeBytes: 51_200, outputDirectory: outputDirectory! },
        // Setup and interactive planning skills require people. Use the host's unattended protocol.
        disabledSkills: ["symphony-onboard", "symphony-write-card", "brainstorming", "grill-me", "grilling"],
        tools: p.tracker.agentTools({
          issue: p.issue,
          workspacePath: workspace.path,
          log: p.log,
          control: p.control,
          review: review ? {
            round: p.reviewRound ?? 1,
            passState: review.passState,
            failState: review.failState,
          } : undefined,
        }),
        onPermissionRequest: createPermissionHandler({
          workspace: workspace.path,
          shellAllow: config.copilot.shellAllow,
          shellDeny: config.copilot.shellDeny,
          // Output is read-only; reviewers may also read, but never change, the implementer's evidence.
          readAllow: [...config.copilot.readAllow, outputDirectory!, ...(review ? [implementerWorkspace] : [])],
          urlAllow: config.copilot.urlAllow,
        }, p.log),
        // Unattended: answer questions with a fixed instruction instead of stalling (spec §10.5).
        onUserInputRequest: () => ({ answer: `${config.copilot.userInputReply}\n\n${outputLanguageInstruction(config.language)}`, wasFreeform: true }),
      }), "session_create", (created) => cleanupLate(created));
    } catch (error) {
      if (error instanceof RunError) throw error;
      throw new RunError("startup_failed", (error as Error).message);
    }
    const sessionId = session.sessionId;
    p.onUpdate({ event: "startup_phase", timestamp: new Date(), sessionId, message: "session_confirm" });
    await p.control?.onSessionCreated(sessionId);
    p.onUpdate({ event: "session_started", timestamp: new Date(), sessionId });
    // Listen across idle and cleanup as well as turns: final usage can arrive after a tool handoff.
    unsubscribe = session.on((event) => {
      const update: AgentUpdate = { event: event.type, timestamp: new Date(), sessionId, turn: turns, message: summarize(event) };
      if (event.type === "assistant.usage") {
        if (event.id && usageIds.has(event.id)) return;
        if (event.id) usageIds.add(event.id);
        tokens.input += event.data.inputTokens ?? 0;
        tokens.output += event.data.outputTokens ?? 0;
        tokens.total = tokens.input + tokens.output;
        update.tokens = { ...tokens };
        const amount = event.data.copilotUsage?.totalNanoAiu;
        if (validUsage(amount)) {
          nanoAiu += amount;
          usageObserved = true;
          update.aiCredits = nanoAiu / 1e9;
        }
        if (event.data.model?.trim()) {
          const model = liveModels.get(event.data.model) ?? { requests: 0, nanoAiu: 0 };
          model.requests++;
          model.nanoAiu += validUsage(amount) ? amount : 0;
          liveModels.set(event.data.model, model);
        }
      }
      p.onUpdate(update);
    });
    client.rpc.account.getQuota({}).then(
      (quota) => p.onUpdate({ event: "rate_limits", timestamp: new Date(), sessionId, rateLimits: quota.quotaSnapshots }),
      () => {},
    );

    for (let turn = 1; ; turn++) {
      if (p.control?.accepted()) break;
      p.control?.assertActive();
      if (p.signal.aborted) throw new RunError("canceled", String(p.signal.reason ?? "canceled"));
      const repositoryPrompt = turn === 1
        ? review
          ? renderTemplate(readReviewPrompt(review.promptFile), {
            issue: issueForTemplate(issue),
            attempt: p.attempt,
            review_round: p.reviewRound ?? 1,
            implementer_workspace: workspacePath(config.workspace.root, issue.identifier),
          }) + `\n\nReview progress context: ${p.control?.initialReview !== false
            ? "initial review; use progress=initial for a quality verdict, not a rework progress assessment."
            : "a formally handed-off rework is ready; assess it as made_progress or no_progress with evidence."} If verification is impossible, use unable_to_verify with not_assessed and human_required.`
          : renderIssuePrompt(p.promptTemplate, issue, p.attempt)
        : renderContinuationPrompt(review ? review.continuationPrompt : config.agent.continuationPrompt, issue, turn, config.agent.maxTurns);
      const prompt = composeAgentPrompt(repositoryPrompt, role, turn === 1, config.language);
      p.onUpdate({ event: "turn_started", timestamp: new Date(), sessionId, turn });
      turns = turn;
      await runTurn({
        session,
        prompt,
        turn,
        turnTimeoutMs: config.copilot.turnTimeoutMs,
        signal: p.signal,
        control: p.control,
      }).catch((error) => {
        if (!p.control?.accepted()) throw error;
        p.log.warn("turn ended after result acceptance; publication belongs to host", { error: (error as Error).message });
      });
      p.onUpdate({ event: "turn_completed", timestamp: new Date(), sessionId, turn, tokens: { ...tokens } });
      if (p.control?.accepted()) break;

      let refreshed: Issue[];
      try {
        refreshed = await p.tracker.fetchIssuesByIds([issue.id]);
      } catch (error) {
        if (p.control?.accepted()) break;
        throw new RunError("issue_refresh_failed", (error as Error).message);
      }
      if (p.control?.accepted()) break;
      if (refreshed.length === 0) break;
      issue = refreshed[0]!;
      if (!isActiveState(config, issue.state) || !isRoutable(config, issue)) break;
      if (roleFor(config, issue.state) !== role) break;
      if (turn >= config.agent.maxTurns) break;
    }
  } finally {
    try {
      if (session) {
        try {
          const metrics = await withTimeout(session.rpc.usage.getMetrics(), 10_000, "session usage").catch((error: Error) => {
            p.log.warn("session usage unavailable", { error: error.message });
            return null;
          });
          if (metrics) {
            p.log.info("session usage", {
              premium_requests: metrics.totalPremiumRequestCost,
              ai_credits: metrics.totalNanoAiu === undefined ? null : Number((metrics.totalNanoAiu / 1e9).toFixed(4)),
            });
          }
          const finalNanoAiu = Math.max(nanoAiu, validUsage(metrics?.totalNanoAiu) ? metrics.totalNanoAiu : 0);
          const mergedModels = new Map([...liveModels].map(([model, m]) => [model, { model, requests: m.requests, aiCredits: m.nanoAiu / 1e9 }]));
          for (const [model, m] of Object.entries(metrics?.modelMetrics ?? {})) {
            if (!model.trim() || !m) continue;
            const live = mergedModels.get(model);
            mergedModels.set(model, { model, requests: Math.max(live?.requests ?? 0, m.requests?.count ?? 0), aiCredits: Math.max(live?.aiCredits ?? 0, validUsage(m.totalNanoAiu) ? m.totalNanoAiu / 1e9 : 0) });
          }
          const models = [...mergedModels.values()];
          const summary: SessionSummary = {
            sessionId: session.sessionId,
            usageComplete: validUsage(metrics?.totalNanoAiu) && metrics.totalNanoAiu >= nanoAiu && models.length > 0,
            turns,
            models,
            aiCredits: finalNanoAiu / 1e9,
            premiumRequests: metrics?.totalPremiumRequestCost ?? null,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            code: metrics?.codeChanges ? { linesAdded: metrics.codeChanges.linesAdded, linesRemoved: metrics.codeChanges.linesRemoved, files: metrics.codeChanges.filesModified.length } : null,
            finalState: issue.state,
          };
          p.onUpdate({ event: "session_usage", timestamp: new Date(), sessionId: session.sessionId,
            ...(usageObserved || validUsage(metrics?.totalNanoAiu) ? { aiCredits: summary.aiCredits } : {}), summary });
        } finally {
          await withTimeout(session.disconnect(), 10_000, "session.disconnect").catch((error: Error) => {
            cleanupConfirmed = false;
            p.log.warn("copilot session disconnect failed", { error: error.message });
          });
        }
      }
    } finally {
      if (client) cleanupConfirmed = await stopClient(client, p.log) && cleanupConfirmed;
      // An early stop cannot prove a retained start/create RPC will not create a runtime later.
      // Only its late handler may acknowledge settlement, even if this cleanup succeeded.
      if (!pendingStartup) {
        if (cleanupConfirmed) settleStartup();
        else markStartupUncertain("runtime_cleanup");
      }
      if (pendingStartup) await withTimeout(pendingStartup, 10_000, "pending startup cleanup").catch((error: Error) => {
        p.log.warn("startup remains uncertain; late cleanup retained", { error: error.message });
      });
      unsubscribe?.();
      if (outputDirectory) {
        await fs.rm(outputDirectory, { recursive: true, force: true }).catch((error: Error) => {
          p.log.warn("session output cleanup failed", { path: outputDirectory, error: error.message });
        });
      }
      await p.workspaces.hook(config, "after_run", workspace, p.issue, false);
    }
  }
}
