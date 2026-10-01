import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Role, ServiceConfig } from "./config.ts";
import { decideResult, IMPLEMENTATION_HEAD_CHECK_LIMIT, validateAgentResult, type AgentResult, type PendingHandoff } from "./iteration.ts";
import { normalizeState, type Issue } from "./types.ts";

export interface RunInvocation {
  id: string;
  sessionId: string | null;
  role: Role;
  ordinal: number | null;
  phase: "starting" | "running" | "finished";
  /** Missing in older ledgers means false; only a runner cleanup acknowledgement clears true. */
  startupUncertain?: boolean;
  credits: number;
}
/** Minimal accounting/ownership tombstones, not a semantic history or a publication queue. */
export interface RunAllocation {
  authorizationId: string;
  sessionId: string | null;
  ordinal: number | null;
  credits: number;
  resultId: string | null;
}
export interface RunCycle {
  key: string;
  itemId: string;
  identifier: string;
  authorizationId: string;
  startedAt: string;
  sessions: number;
  limit: number;
  aiCredits: number;
  totalAiCredits: number;
  reviewRounds: number;
  noProgress: number;
  waitingState: string | null;
  lastState: string;
  halted: { reason: string; state: string; at: string } | null;
  returnedFor: string | null;
  terminal: boolean;
  invocation: RunInvocation | null;
  pending: PendingHandoff | null;
  reworkId: string | null;
  lastSettledReworkId: string | null;
  reworkReady: boolean;
  allocations: Record<string, RunAllocation>;
}
type LegacyCycle = Pick<RunCycle, "identifier" | "startedAt" | "sessions" | "aiCredits" | "reviewRounds" | "halted" | "returnedFor">;
export class LedgerError extends Error {}

export function ledgerWritePaths(path: string): [string, string] {
  return [path, `${path}.tmp`];
}

const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const nullableText = (v: unknown) => v === null || text(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new LedgerError(message); }

export function issueControlKey(issue: Issue): string {
  const repo = issue.nativeRef?.repository;
  const id = issue.nativeRef?.issue_id;
  check(text(repo) && /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) && text(id), `missing or invalid native issue identity for ${issue.identifier}`);
  return `${repo.trim().toLowerCase()}:${encodeURIComponent(id.trim())}`;
}
function canonicalKey(key: string): boolean {
  const match = /^([\w.-]+\/[\w.-]+):(.+)$/.exec(key);
  if (!match || match[1] !== match[1]!.toLowerCase()) return false;
  try {
    const id = decodeURIComponent(match[2]!);
    return text(id) && id === id.trim() && encodeURIComponent(id) === match[2];
  } catch { return false; }
}
function fresh(issue: Issue, limit: number, now: Date): RunCycle {
  check(count(limit) && limit > 0, "authorization limit must be a positive integer");
  return {
    key: issueControlKey(issue), itemId: issue.id, identifier: issue.identifier, authorizationId: randomUUID(), startedAt: now.toISOString(),
    sessions: 0, limit, aiCredits: 0, totalAiCredits: 0, reviewRounds: 0, noProgress: 0, waitingState: null, lastState: issue.state,
    halted: null, returnedFor: null, terminal: false, invocation: null, pending: null, reworkId: null, lastSettledReworkId: null,
    reworkReady: false, allocations: {},
  };
}

/** Single-host ledger. A failed critical save poisons this instance: callers MUST stop scheduling. */
export class RunLedger {
  readonly path: string | null;
  private readonly readOnly: boolean;
  private readonly cycles = new Map<string, RunCycle>();
  private readonly legacy = new Map<string, LegacyCycle>();
  private failure: LedgerError | null = null;

  constructor(path: string | null = null, options: { readOnly?: boolean } = {}) {
    this.path = path;
    this.readOnly = options.readOnly ?? false;
    if (!path) return;
    let data: any;
    try { data = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new LedgerError(`cannot read run ledger ${path}: ${(error as Error).message}`);
    }
    check(object(data) && (data.version === 1 || data.version === 2) && object(data.issues), "unknown or malformed run ledger version/records");
    if (data.version === 1) {
      for (const [id, raw] of Object.entries(data.issues)) { check(text(id), "invalid legacy item ID"); validateLegacy(raw); this.legacy.set(id, raw); }
    } else {
      validateData(data);
      for (const [key, cycle] of Object.entries<RunCycle>(data.issues)) this.cycles.set(key, cycle);
      for (const [id, raw] of Object.entries<LegacyCycle>(data.legacy)) this.legacy.set(id, raw);
    }
  }
  private healthy(): void { if (this.failure) throw this.failure; }
  private owns(cycle: RunCycle): void { this.healthy(); check(this.cycles.get(cycle.key) === cycle, "cycle does not belong to this ledger instance"); }
  private mapping(issue: Issue, key: string): void {
    check(text(issue.id) && text(issue.identifier) && text(issue.state), "invalid issue mapping");
    check(![...this.cycles.values()].some((c) => c.itemId === issue.id && c.key !== key), "item already belongs to another native identity");
  }
  get(keyOrItemId: string): RunCycle | undefined {
    this.healthy();
    return this.cycles.get(keyOrItemId) ?? [...this.cycles.values()].find((c) => c.itemId === keyOrItemId);
  }
  issueIds(): string[] { this.healthy(); return [...this.cycles.keys()]; }
  records(): RunCycle[] { this.healthy(); return [...this.cycles.values()]; }
  legacyItemIds(): string[] { this.healthy(); return [...this.legacy.keys()]; }

  /** Resolve existing control only. Never authorize by identifier, even a unique legacy identifier. */
  adopt(issue: Issue, limit: number): RunCycle | undefined {
    this.healthy();
    const key = issueControlKey(issue);
    this.mapping(issue, key);
    const cycle = this.cycles.get(key), old = this.legacy.get(issue.id);
    check(!(cycle && old), "legacy item collides with an existing native record");
    if (cycle) {
      if (cycle.itemId !== issue.id || cycle.identifier !== issue.identifier) {
        cycle.itemId = issue.id; cycle.identifier = issue.identifier; this.save();
      }
      return cycle;
    }
    const matches = [...this.legacy.values()].filter((c) => c.identifier === issue.identifier);
    check(old ? old.identifier === issue.identifier : matches.length === 0, "ambiguous or orphan legacy identifier; exact item identity is required");
    if (!old) return undefined;
    const migrated = { ...fresh(issue, limit, new Date(old.startedAt)), sessions: old.sessions, aiCredits: old.aiCredits,
      totalAiCredits: old.aiCredits, reviewRounds: old.reviewRounds, halted: old.halted, returnedFor: old.returnedFor,
      waitingState: old.halted?.state ?? null, lastState: old.halted?.state ?? issue.state };
    this.cycles.set(key, migrated); this.legacy.delete(issue.id); this.save();
    return migrated;
  }
  /** Caller must first verify a genuine waiting -> Todo authorization and drain the old worker. */
  authorize(issue: Issue, limit: number, now: Date = new Date()): RunCycle {
    const existing = this.adopt(issue, limit);
    check(!existing?.terminal, "cannot authorize a terminal issue");
    check(!existing?.invocation?.startupUncertain, "startup remains uncertain; cleanup acknowledgement is required");
    check(!existing?.pending && (!existing?.invocation || existing.invocation.phase === "finished"), "cannot authorize with an unfinished invocation/handoff");
    const reset = fresh(issue, limit, now);
    if (existing) { reset.totalAiCredits = existing.totalAiCredits; reset.allocations = existing.allocations; }
    const cycle = existing ? Object.assign(existing, reset) : reset;
    this.cycles.set(cycle.key, cycle); this.save();
    return cycle;
  }
  begin(cycle: RunCycle, role: Role): RunInvocation {
    this.owns(cycle);
    check(role === "implement" || role === "review", "invalid invocation role");
    check(!cycle.halted && !cycle.terminal && !cycle.waitingState, "cannot begin while halted, terminal or waiting");
    check(!cycle.invocation?.startupUncertain, "startup remains uncertain; cleanup acknowledgement is required");
    check(!cycle.pending && (!cycle.invocation || cycle.invocation.phase === "finished"), "an invocation/handoff is already active");
    check(cycle.sessions < cycle.limit, "session limit reached");
    const invocation: RunInvocation = { id: randomUUID(), sessionId: null, role, ordinal: null, phase: "starting", credits: 0 };
    cycle.invocation = invocation;
    cycle.allocations[invocation.id] = { authorizationId: cycle.authorizationId, sessionId: null, ordinal: null, credits: 0, resultId: null };
    this.save(); return invocation;
  }
  confirm(cycle: RunCycle, invocationId: string, sessionId: string): number {
    this.owns(cycle);
    const allocation = cycle.allocations[invocationId];
    check(allocation && text(sessionId), "unknown invocation or invalid session identity");
    if (allocation.sessionId !== null) {
      check(allocation.sessionId === sessionId, "invocation already owns a different session");
      return allocation.ordinal!;
    }
    const invocation = cycle.invocation;
    check(invocation?.id === invocationId && invocation.phase === "starting", "invocation is not awaiting creation confirmation");
    check(![...this.cycles.values()].some((c) => Object.values(c.allocations).some((a) => a.sessionId === sessionId)), "session already belongs to another invocation");
    allocation.sessionId = invocation.sessionId = sessionId;
    allocation.ordinal = invocation.ordinal = ++cycle.sessions;
    invocation.phase = "running";
    this.save(); return invocation.ordinal;
  }
  accept(cycle: RunCycle, invocationId: string, result: AgentResult, workspacePath: string, config: ServiceConfig): PendingHandoff {
    this.owns(cycle);
    check(!cycle.halted && !cycle.terminal, "cannot accept a result while halted or terminal");
    const invocation = cycle.invocation;
    check(invocation?.id === invocationId && invocation.phase === "running", "result does not belong to a running invocation (possibly finished)");
    if (cycle.pending) {
      check(cycle.pending.invocationId === invocationId && isDeepStrictEqual(cycle.pending.result, result) && cycle.pending.workspacePath === workspacePath, "repeated result changed or belongs to a different invocation");
      return cycle.pending;
    }
    validateAgentResult(result, !cycle.reworkReady);
    check(result.kind === invocation.role || result.kind === "blocked", "result does not match invocation role");
    check(text(workspacePath), "workspacePath is required");
    check(result.kind !== "review" || result.verdict === "unable_to_verify" || !cycle.reworkId || cycle.reworkReady, "rework has not been formally handed off");
    const hasRework = cycle.reworkReady && cycle.reworkId !== null && cycle.reworkId !== cycle.lastSettledReworkId;
    const decision = decideResult(result, config, { ...cycle, hasRework });
    const pending: PendingHandoff = {
      id: randomUUID(), invocationId, sourceState: cycle.lastState, workspacePath, result: structuredClone(result), ...decision,
      issueMessage: null, pr: null, prPublished: false, pushed: false, statusApplied: false, stale: false, reworkId: cycle.reworkId,
      waitingState: config.tracker.activeStates.some((s) => normalizeState(s) === normalizeState(decision.targetState)) ? null : decision.targetState,
    };
    cycle.pending = pending; cycle.allocations[invocationId]!.resultId = pending.id;
    this.save(); return pending;
  }
  checkpoint(cycle: RunCycle): void { this.owns(cycle); this.save(); }
  /** Host verifies remote publication/state first. Finished remains visible after pending is cleared. */
  complete(cycle: RunCycle, stale = false): void {
    this.owns(cycle);
    const p = cycle.pending;
    if (!p) return;
    if (!stale && !p.stale && !cycle.terminal && !cycle.halted) {
      cycle.noProgress = p.nextNoProgress; cycle.waitingState = p.waitingState; cycle.lastState = p.targetState;
      if (p.haltReason) cycle.halted = { reason: p.haltReason, state: p.targetState, at: new Date().toISOString() };
      if (p.result.kind === "review") {
        cycle.reviewRounds++;
        if (p.result.verdict !== "unable_to_verify") {
          if (p.reworkId) cycle.lastSettledReworkId = p.reworkId;
          cycle.reworkId = p.result.verdict === "request_changes" && !p.haltReason ? randomUUID() : null;
          cycle.reworkReady = false;
        }
      } else if (p.result.kind === "implement" && cycle.reworkId && !p.haltReason) cycle.reworkReady = true;
    }
    cycle.invocation!.phase = "finished"; cycle.pending = null; this.save();
  }
  pause(cycle: RunCycle, reason: string, state: string, now: Date = new Date()): void {
    this.owns(cycle); check(text(reason) && text(state), "pause reason and state are required");
    cycle.halted = { reason, state, at: now.toISOString() }; cycle.waitingState = state; this.save();
  }
  /** Observation is not authorization. Waiting/halt ownership and terminal detection belong to the host. */
  observe(cycle: RunCycle, issue: Issue): void {
    this.owns(cycle); check(issueControlKey(issue) === cycle.key, "observed issue has a different native identity"); this.mapping(issue, cycle.key);
    check(!this.legacy.has(issue.id), "observed item collides with a legacy record");
    if (cycle.itemId === issue.id && cycle.identifier === issue.identifier && cycle.lastState === issue.state) return;
    cycle.itemId = issue.id; cycle.identifier = issue.identifier; cycle.lastState = issue.state; this.save();
  }
  recordUsage(cycle: RunCycle, invocationId: string, absolute: number): void {
    this.owns(cycle);
    const allocation = cycle.allocations[invocationId];
    check(allocation?.sessionId && money(absolute), "unknown/unconfirmed invocation or invalid usage");
    const delta = absolute - allocation.credits;
    if (delta <= 0) return;
    const current = allocation.authorizationId === cycle.authorizationId;
    check(Number.isFinite(cycle.totalAiCredits + delta) && Number.isFinite(cycle.aiCredits + (current ? delta : 0)), "usage total overflow");
    allocation.credits = absolute; cycle.totalAiCredits += delta;
    if (current) cycle.aiCredits += delta;
    if (cycle.invocation?.id === invocationId) cycle.invocation.credits = absolute;
    this.save();
  }
  save(): void {
    this.healthy();
    try {
      const data = { version: 2, issues: Object.fromEntries(this.cycles), legacy: Object.fromEntries(this.legacy) };
      validateData(data);
      if (!this.path || this.readOnly) return;
      mkdirSync(dirname(this.path), { recursive: true });
      const [path, temp] = ledgerWritePaths(this.path);
      const fd = openSync(temp, "wx", 0o600);
      let renamed = false;
      try {
        try { writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); }
        finally { closeSync(fd); }
        renameSync(temp, path);
        renamed = true;
      } finally {
        // An unsuccessful exclusive open never reaches this cleanup.
        if (!renamed) unlinkSync(temp);
      }
    } catch (error) {
      this.failure = new LedgerError(`run ledger save failed; instance unusable, stop scheduling: ${(error as Error).message}`);
      throw this.failure;
    }
  }
}

function validateLegacy(raw: unknown): asserts raw is LegacyCycle {
  check(object(raw) && text(raw.identifier) && date(raw.startedAt) && count(raw.sessions) && money(raw.aiCredits) && count(raw.reviewRounds) && nullableText(raw.returnedFor), "malformed legacy/base run record");
  check(raw.halted === null || (object(raw.halted) && text(raw.halted.reason) && text(raw.halted.state) && date(raw.halted.at)), "malformed halt record");
}
function validateData(data: any): void {
  check(object(data) && data.version === 2 && object(data.issues) && object(data.legacy), "malformed version 2 ledger");
  const items = new Set<string>(), sessions = new Set<string>(), invocations = new Set<string>();
  for (const [id, raw] of Object.entries(data.legacy)) { check(text(id), "invalid legacy item ID"); validateLegacy(raw); }
  for (const [key, raw] of Object.entries(data.issues)) {
    validateLegacy(raw);
    const c = raw as RunCycle;
    check(c.key === key && canonicalKey(key), "malformed native control key");
    check(text(c.itemId) && !items.has(c.itemId) && !Object.hasOwn(data.legacy, c.itemId), "duplicate or ambiguous item mapping"); items.add(c.itemId);
    check(text(c.authorizationId) && count(c.limit) && c.limit > 0 && money(c.totalAiCredits) && c.totalAiCredits >= c.aiCredits && count(c.noProgress), "malformed authorization counters");
    check(nullableText(c.waitingState) && text(c.lastState) && typeof c.terminal === "boolean" && nullableText(c.reworkId) && nullableText(c.lastSettledReworkId) && typeof c.reworkReady === "boolean", "malformed control state");
    check(!c.reworkReady || (c.reworkId !== null && c.reworkId !== c.lastSettledReworkId), "invalid rework readiness");
    check(object(c.allocations), "missing invocation allocations");
    let total = 0, current = 0;
    const ordinals = new Set<string>();
    for (const [id, a] of Object.entries(c.allocations)) {
      check(text(id) && !invocations.has(id) && object(a) && text(a.authorizationId) && nullableText(a.sessionId) && money(a.credits) && nullableText(a.resultId), "malformed invocation allocation"); invocations.add(id);
      check(a.sessionId === null ? a.ordinal === null && a.credits === 0 && a.resultId === null : count(a.ordinal) && a.ordinal > 0, "malformed session allocation");
      if (a.sessionId !== null) {
        const ordinalKey = `${a.authorizationId}:${a.ordinal}`;
        check(!sessions.has(a.sessionId) && !ordinals.has(ordinalKey), "duplicate session or ordinal"); sessions.add(a.sessionId); ordinals.add(ordinalKey);
        check(a.authorizationId !== c.authorizationId || a.ordinal! <= c.sessions, "session allocation exceeds counter");
      }
      total += a.credits; if (a.authorizationId === c.authorizationId) current += a.credits;
    }
    check(Number.isFinite(total) && total <= c.totalAiCredits + 1e-9 * Math.max(1, total) && current <= c.aiCredits + 1e-9 * Math.max(1, current), "usage allocations exceed totals");
    if (c.invocation !== null) {
      const i = c.invocation, a = object(i) && c.allocations[i.id];
      check(a && a.authorizationId === c.authorizationId && ["implement", "review"].includes(i.role) && ["starting", "running", "finished"].includes(i.phase), "malformed current invocation");
      check(i.startupUncertain === undefined || typeof i.startupUncertain === "boolean", "malformed startup uncertainty fence");
      check(i.sessionId === a.sessionId && i.ordinal === a.ordinal && i.credits === a.credits, "invocation/allocation mismatch");
      check(i.phase === "finished" || (i.phase === "starting" ? i.sessionId === null : i.sessionId !== null), "invocation phase contradicts confirmation");
    }
    if (c.pending !== null) {
      const p = c.pending;
      check(object(p) && text(p.id) && c.invocation?.id === p.invocationId && c.invocation.phase === "running" && c.allocations[p.invocationId]?.resultId === p.id, "malformed pending invocation binding");
      check(text(p.sourceState) && text(p.targetState) && text(p.workspacePath) && nullableText(p.haltReason) && nullableText(p.waitingState) && count(p.nextNoProgress) && p.reworkId === c.reworkId, "malformed pending decision");
      check([p.prPublished, p.pushed, p.statusApplied, p.stale].every((v) => typeof v === "boolean"), "malformed pending publication flags");
      check(p.issueMessage === null || (object(p.issueMessage) && text(p.issueMessage.id) && nullableText(p.issueMessage.url)), "malformed pending issue message");
      check(p.pr === null || (object(p.pr) && text(p.pr.id) && count(p.pr.number) && p.pr.number > 0 && text(p.pr.url)), "malformed pending PR");
      check(!p.prPublished || p.pr !== null, "published PR reference is missing");
      try { validateAgentResult(p.result, !c.reworkReady); } catch (error) { throw new LedgerError(`malformed pending result: ${(error as Error).message}`); }
      check(p.result.kind === c.invocation.role || p.result.kind === "blocked", "pending result role mismatch");
      const r = p.result;
      const next = r.kind !== "review" ? c.noProgress : r.verdict === "approve" || r.progress === "made_progress" ? 0 : r.progress === "no_progress" ? c.noProgress + 1 : c.noProgress;
      check(p.nextNoProgress === next, "pending progress contradicts the saved result");
      check(r.kind !== "review" || r.verdict === "unable_to_verify" || !p.reworkId || c.reworkReady, "pending rework was never handed off");
      check(p.haltReason === null || ["human_required", "no_progress", "session_limit", "session_limit_unreviewed", "head_mismatch"].includes(p.haltReason), "invalid pending halt reason");
      if (p.headMismatch !== undefined) {
        const h = p.headMismatch;
        check(object(h) && r.kind === "implement" && p.pushed && count(h.attempts) && h.attempts > 0 &&
          h.attempts <= IMPLEMENTATION_HEAD_CHECK_LIMIT && text(h.actualHead) && count(h.retryAt), "invalid implementation head retry");
        check((h.attempts === IMPLEMENTATION_HEAD_CHECK_LIMIT) === (p.haltReason === "head_mismatch"), "head retry limit contradicts halt decision");
      }
      check(p.haltReason !== "head_mismatch" || p.headMismatch?.attempts === IMPLEMENTATION_HEAD_CHECK_LIMIT, "head mismatch halt needs exhausted checks");
      check(p.waitingState === null || p.waitingState === p.targetState, "pending waiting state contradicts target");
      check(p.haltReason === null || p.waitingState === p.targetState, "halted handoff must wait at its target");
    }
  }
}
