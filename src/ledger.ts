import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One run of an issue: from its first dispatch until it is seen outside the active states
 * (handed off, blocked, done, or moved by a person).
 */
export interface RunCycle {
  identifier: string;
  startedAt: string;
  /** Copilot sessions that actually started in this run. */
  sessions: number;
  aiCredits: number;
  /** Review verdicts given in this run. */
  reviewRounds: number;
  halted: { reason: string; state: string; at: string } | null;
  /** Set when the orchestrator sent the card back itself (a merge conflict); such runs are dispatched first. */
  returnedFor: string | null;
}

export class LedgerError extends Error {}

/** Per-issue spend for the current run. File-backed so a restart cannot reset the limits. */
export class RunLedger {
  readonly path: string | null;
  private readonly readOnly: boolean;
  private readonly cycles: Map<string, RunCycle>;

  constructor(path: string | null = null, options: { readOnly?: boolean } = {}) {
    this.path = path;
    this.readOnly = options.readOnly ?? false;
    this.cycles = new Map(path ? load(path) : []);
  }

  get(issueId: string): RunCycle | undefined {
    return this.cycles.get(issueId);
  }

  issueIds(): string[] {
    return [...this.cycles.keys()];
  }

  open(issueId: string, identifier: string, now: Date): RunCycle {
    let cycle = this.cycles.get(issueId);
    if (!cycle) {
      cycle = { identifier, startedAt: now.toISOString(), sessions: 0, aiCredits: 0, reviewRounds: 0, halted: null, returnedFor: null };
      this.cycles.set(issueId, cycle);
    }
    return cycle;
  }

  close(issueId: string): RunCycle | undefined {
    const cycle = this.cycles.get(issueId);
    this.cycles.delete(issueId);
    return cycle;
  }

  save(): void {
    if (!this.path || this.readOnly) return;
    const data = { version: 1, issues: Object.fromEntries(this.cycles) };
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(temp, this.path);
  }
}

function load(path: string): Array<[string, RunCycle]> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new LedgerError(`cannot read run ledger ${path}: ${(error as Error).message}`);
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new LedgerError(`run ledger ${path} is not valid JSON (delete it to reset all limits): ${(error as Error).message}`);
  }
  const entries: Array<[string, RunCycle]> = [];
  for (const [id, raw] of Object.entries<any>(data?.issues ?? {})) {
    if (!raw || typeof raw.identifier !== "string" || !Number.isFinite(raw.sessions) || !Number.isFinite(raw.aiCredits)) {
      throw new LedgerError(`run ledger ${path} has a malformed entry for ${id} (delete it to reset all limits)`);
    }
    entries.push([id, {
      identifier: raw.identifier,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : new Date(0).toISOString(),
      sessions: raw.sessions,
      aiCredits: raw.aiCredits,
      reviewRounds: Number.isFinite(raw.reviewRounds) ? raw.reviewRounds : 0,
      halted: raw.halted && typeof raw.halted.reason === "string" && typeof raw.halted.state === "string"
        ? { reason: raw.halted.reason, state: raw.halted.state, at: String(raw.halted.at ?? "") }
        : null,
      returnedFor: typeof raw.returnedFor === "string" ? raw.returnedFor : null,
    }]);
  }
  return entries;
}
