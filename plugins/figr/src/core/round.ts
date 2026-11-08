import type { ApproveConfig, Quorum } from "../config/schema.ts";
import { fingerprint } from "../util/hash.ts";
import type { Finding, Round, Severity } from "./types.ts";

export type RoundStatus = "in_review" | "passed" | "changes_requested" | "rejected";

export interface RoundEvaluation {
  readonly status: RoundStatus;
  readonly approved: number;
  readonly required: number;
  /** Reviewer ohne Urteil (weder abgegeben noch als missing markiert). */
  readonly pending: readonly string[];
  readonly checksGreen: boolean | undefined;
}

/** Benötigte Zustimmungen (plan.md 7.2). */
export function required(quorum: Quorum, reviewers: number): number {
  if (quorum === "all") return reviewers;
  if (quorum === "majority") return Math.floor(reviewers / 2) + 1;
  return quorum;
}

/** Wertet eine Runde aus (reine Funktion, plan.md 7.2). */
export function evaluateRound(round: Round, approve: Pick<ApproveConfig, "quorum" | "veto" | "checks">): RoundEvaluation {
  const verdicts = round.reviewers.map((r) => round.verdicts[r]).filter((v) => v !== undefined);
  const approved = verdicts.filter((v) => v.verdict === "approved").length;
  const need = required(approve.quorum, round.reviewers.length);
  const pending = round.reviewers.filter((r) => !round.verdicts[r] && !round.missing.includes(r));
  const checksGreen = approve.checks.length === 0 ? true : round.checks === undefined ? undefined : round.checks.every((c) => c.ok);
  const base = { approved, required: need, pending, checksGreen };
  if (approve.veto && verdicts.some((v) => v.verdict === "rejected")) return { ...base, status: "rejected" };
  if (checksGreen === false) return { ...base, status: "changes_requested" };
  if (approved >= need && checksGreen === true) return { ...base, status: "passed" };
  if (pending.length === 0 && approved < need) return { ...base, status: "changes_requested" };
  return { ...base, status: "in_review" };
}

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

/** Alle Befunde einer Runde inkl. roter Checks, nach Schwere sortiert, Duplikate zusammengeführt. */
export function roundFindings(round: Round): (Finding & { from: string[] })[] {
  const merged = new Map<string, Finding & { from: string[] }>();
  for (const reviewer of round.reviewers) {
    const v = round.verdicts[reviewer];
    if (!v) continue;
    for (const f of v.findings) {
      const key = `${f.severity}|${normalize(f.message)}`;
      const existing = merged.get(key);
      if (existing) existing.from.push(reviewer);
      else merged.set(key, { ...f, from: [reviewer] });
    }
  }
  for (const c of round.checks ?? []) {
    if (!c.ok) merged.set(`check|${c.command}`, { severity: "blocker", location: c.command, message: `Check fehlgeschlagen: ${c.command}${c.timedOut ? " (Zeitlimit)" : ` (Exit ${c.exitCode ?? "?"})`}`, from: ["check"] });
  }
  return [...merged.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Fingerprint der normalisierten Befunde (Schwere + Text, sortiert). Leer, wenn es keine Befunde gibt. */
export function stagnationFingerprint(round: Round): string {
  const items = roundFindings(round)
    .map((f) => `${f.severity}:${normalize(f.message)}`)
    .sort();
  return items.length === 0 ? "" : fingerprint(items.join("\n"));
}

export type EscalationReason = "maxRounds" | "stagnation";

/** Muss eskaliert werden? Betrachtet die abgeschlossenen, nicht bestandenen Runden eines Gates. */
export function escalationReason(rounds: readonly Round[], approve: ApproveConfig, stagnation: boolean): EscalationReason | undefined {
  const failed = rounds.filter((r) => {
    const s = evaluateRound(r, approve).status;
    return s === "changes_requested" || s === "rejected";
  });
  if (failed.length >= approve.maxRounds) return "maxRounds";
  if (stagnation && failed.length >= 2) {
    const [a, b] = failed.slice(-2).map(stagnationFingerprint);
    if (a && a === b) return "stagnation";
  }
  return undefined;
}
