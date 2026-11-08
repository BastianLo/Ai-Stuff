import type { GateConfig, ProfileConfig } from "../config/schema.ts";
import { gateOrder } from "./graph.ts";
import { evaluateRound, type RoundEvaluation } from "./round.ts";
import { emptyGateState, type CurrentVersions, type GateState, type GateStatus, type Round, type SessionState } from "./types.ts";

export interface GateView {
  readonly name: string;
  readonly config: GateConfig;
  readonly state: GateState;
  readonly status: GateStatus;
  /** Aktuelle Artefakt-Version (Hash) und Kurz-ID, falls vorhanden. */
  readonly version?: { readonly hash: string; readonly short: string };
  /** Runde zur aktuellen Version. */
  readonly round?: Round;
  readonly evaluation?: RoundEvaluation;
  /** Nachweis-Fortschritt bei evidence-Gates. */
  readonly evidence?: { readonly have: number; readonly need: number };
  /** Unerfüllte Voraussetzungen (bei blocked). */
  readonly missingRequires: readonly string[];
  /** Wartet nur noch auf die menschliche Freigabe. */
  readonly awaitingHuman: boolean;
}

const DONE: ReadonlySet<GateStatus> = new Set(["passed", "skipped"]);
export const isDone = (s: GateStatus): boolean => DONE.has(s);

export function shortFor(state: GateState, hash: string): string | undefined {
  return state.versions.find((v) => v.hash === hash)?.short;
}

/** Letzte Runde zu einer Version. */
export function roundFor(state: GateState, hash: string): Round | undefined {
  for (let i = state.rounds.length - 1; i >= 0; i--) {
    const r = state.rounds[i];
    if (r?.version === hash) return r;
  }
  return undefined;
}

function evidenceProgress(config: GateConfig, state: GateState): { have: number; need: number; met: boolean } | undefined {
  const ev = config.evidence;
  if (!ev) return undefined;
  const sub = ev.subagents;
  const have = sub ? state.evidenceRuns.filter((r) => sub.agents.includes(r.agent)).length : 0;
  const need = sub ? sub.min : 0;
  const met = (have >= need) && (ev.file ? state.evidenceFlags.file === true : true) && (ev.check ? state.evidenceFlags.check === true : true);
  return { have, need, met: met || state.evidencePassed };
}

/** Berechnet die Zustände aller Gates in topologischer Reihenfolge (reine Funktion, plan.md 7.1). */
export function computeGates(profile: ProfileConfig, session: Pick<SessionState, "gates">, current: CurrentVersions): GateView[] {
  const views = new Map<string, GateView>();
  for (const name of gateOrder(profile).order) {
    const config = profile.gates[name];
    if (!config) continue;
    const state = session.gates[name] ?? emptyGateState();
    const missingRequires = config.requires.filter((r) => !isDone(views.get(r)?.status ?? "blocked"));
    const hash = current[name];
    const short = hash ? (shortFor(state, hash) ?? "?") : undefined;
    const version = hash && short ? { hash, short } : undefined;
    const evidence = evidenceProgress(config, state);
    const base = { name, config, state, missingRequires, awaitingHuman: false, ...(version ? { version } : {}), ...(evidence ? { evidence: { have: evidence.have, need: evidence.need } } : {}) };
    const put = (status: GateStatus, extra: Partial<GateView> = {}): void => {
      views.set(name, { ...base, ...extra, status });
    };

    if (state.skipped) {
      put("skipped");
      continue;
    }
    if (missingRequires.length > 0) {
      put("blocked");
      continue;
    }
    const approve = config.approve;
    if (!approve) {
      if (evidence) put(evidence.met ? "passed" : "open");
      else if (config.artifact) put(hash ? "passed" : "open");
      else put("passed");
      continue;
    }
    if (!hash) {
      put("open");
      continue;
    }
    if (state.passedVersion && (state.passedVersion === hash || !approve.invalidateOnChange)) {
      put("passed", roundExtra(state, hash, approve));
      continue;
    }
    const round = roundFor(state, hash);
    if (!round) {
      put("in_review");
      continue;
    }
    const evaluation = evaluateRound(round, approve);
    if (evaluation.status === "passed" && approve.human && state.humanApproved !== hash) {
      put("in_review", { round, evaluation, awaitingHuman: true });
      continue;
    }
    put(evaluation.status, { round, evaluation });
  }
  return [...views.values()];
}

function roundExtra(state: GateState, hash: string, approve: NonNullable<GateConfig["approve"]>): Partial<GateView> {
  const round = roundFor(state, hash);
  return round ? { round, evaluation: evaluateRound(round, approve) } : {};
}

/** Ist die geführte Session fertig? Final-Gate erfüllt, sonst alle Gates (plan.md 6.3). */
export function isComplete(views: readonly GateView[]): boolean {
  const finals = views.filter((v) => v.config.final);
  const relevant = finals.length > 0 ? finals : views;
  return relevant.every((v) => isDone(v.status));
}

/**
 * Für einen direkt gestarteten Reviewer: das Gate, dessen Review er am ehesten meint.
 * Zuerst ein Gate, das auf Review wartet, sonst das letzte mit vorhandenem Artefakt.
 */
export function reviewTarget(candidates: readonly GateView[]): GateView | undefined {
  const usable = candidates.filter((v) => v.status !== "blocked" && v.version);
  return usable.find((v) => v.status === "in_review" || v.status === "changes_requested" || v.status === "rejected") ?? usable.at(-1);
}
