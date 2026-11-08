import type { ArtifactLocation } from "../artifacts/version.ts";
import type { AuditLog } from "../audit/log.ts";
import type { ProfileConfig } from "../config/schema.ts";
import type { GateView } from "../core/gates.ts";
import type { Child, FanoutInfo, Round, SessionState } from "../core/types.ts";
import type { FanoutDeps, FanoutJob } from "../fanout/runner.ts";
import type { HostPorts } from "../host/ports.ts";

/** Was die Muster (Review, Multi-Plan, Best-of-N) vom Controller brauchen. Hält die Muster ohne Abhängigkeit auf `figr.ts`. */
export interface PatternHost {
  readonly ports: HostPorts;
  readonly audit: AuditLog;
  profile(state: SessionState): ProfileConfig;
  location(state: SessionState): ArtifactLocation;
  views(state: SessionState): Promise<GateView[]>;
  touch(state: SessionState): void;
  /** Beschreibung des Artefakts für Reviewer (Pfad bzw. Diff-Statistik). */
  describeArtifact(state: SessionState, view: GateView): Promise<string>;
  /** Runde zur Version holen bzw. anlegen. */
  ensureRound(state: SessionState, gate: string, version: { hash: string; short: string }): Round;
  /** Checks der Runde ausführen, falls noch nicht gelaufen. */
  runRoundChecks(state: SessionState, gate: string, round: Round, signal?: AbortSignal): Promise<void>;
  /** Eskalation an den Nutzer; Rückgabe = Text für den Orchestrator, `undefined` = weiter wie geplant. */
  escalate(state: SessionState, view: GateView, reason: string): Promise<{ text: string; passed: boolean } | undefined>;
  /** Menschliche Freigabe für `approve.human`. */
  humanApproval(state: SessionState, view: GateView): Promise<{ approved: boolean; feedback?: string }>;
  ask(state: SessionState, title: string, detail: string): Promise<{ approved: boolean; feedback?: string }>;
  startFanout(state: SessionState, kind: FanoutInfo["kind"], gate: string, jobs: readonly FanoutJob[]): FanoutInfo;
  endFanout(state: SessionState, fanout: FanoutInfo): void;
  fanoutDeps<R>(state: SessionState, fanout: FanoutInfo, extra: (job: FanoutJob) => Partial<Child>, read: (child: Child) => R | undefined): FanoutDeps<R>;
  /** Für die Richter-Prüfung: erlaubte Gewinner (grüne, falls es grüne gibt), pro Fan-out. */
  setJudgeRule(fanoutID: string, rule: { all: string[]; allowed: string[] }): void;
  bumpDiff(): void;
}
