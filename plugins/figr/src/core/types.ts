import { z } from "zod";

/** Zustände eines Gates (plan.md 7.1). `changes_requested`/`rejected` beziehen sich auf die aktuelle Version. */
export type GateStatus = "blocked" | "open" | "in_review" | "changes_requested" | "rejected" | "passed" | "skipped";

export const SeveritySchema = z.enum(["blocker", "major", "minor", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.strictObject({
  severity: SeveritySchema,
  location: z.string().optional(),
  message: z.string().min(1),
  suggestion: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerdictKindSchema = z.enum(["approved", "changes_requested", "rejected"]);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const VerdictSchema = z.object({
  reviewer: z.string(),
  verdict: VerdictKindSchema,
  summary: z.string(),
  findings: z.array(FindingSchema),
  sessionID: z.string().optional(),
  at: z.number(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const CheckResultSchema = z.object({
  command: z.string(),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  output: z.string(),
  durationMs: z.number(),
  timedOut: z.boolean().default(false),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const RoundSchema = z.object({
  index: z.number().int(),
  version: z.string(),
  short: z.string(),
  reviewers: z.array(z.string()),
  verdicts: z.record(z.string(), VerdictSchema),
  /** Reviewer, die nach allen Nachforderungen kein Urteil abgegeben haben. */
  missing: z.array(z.string()).default([]),
  /** `undefined` = Checks noch nicht gelaufen; leeres Array = keine Checks konfiguriert. */
  checks: z.array(CheckResultSchema).optional(),
  startedAt: z.number(),
  /** Lief die Runde gerade, als opencode beendet wurde? */
  interrupted: z.boolean().default(false),
});
export type Round = z.infer<typeof RoundSchema>;

export const VersionSchema = z.object({ hash: z.string(), short: z.string(), at: z.number() });
export type VersionInfo = z.infer<typeof VersionSchema>;

export const GateStateSchema = z.object({
  versions: z.array(VersionSchema).default([]),
  rounds: z.array(RoundSchema).default([]),
  /** Version, für die das Gate abgenommen wurde (Reviewer + ggf. Mensch). */
  passedVersion: z.string().optional(),
  /** Version, für die der Nutzer zusätzlich zugestimmt hat (`approve.human`). */
  humanApproved: z.string().optional(),
  skipped: z.boolean().default(false),
  /** Erfolgreiche Sub-Agent-Läufe als Nachweis (`evidence.subagents`). */
  evidenceRuns: z.array(z.object({ agent: z.string(), sessionID: z.string().optional(), at: z.number() })).default([]),
  /** Nachweis einmal erbracht → bleibt erbracht (plan.md 7.1). */
  evidencePassed: z.boolean().default(false),
  /** Vom Host ausgewertete Nachweise (`evidence.file`, `evidence.check`). */
  evidenceFlags: z.object({ file: z.boolean().optional(), check: z.boolean().optional() }).default({}),
  /** Eingereichter Text (`artifact.type = text`). */
  text: z.string().optional(),
  /** Eskalation ausgelöst (Version + Grund), damit nicht doppelt gefragt wird. */
  escalated: z.object({ version: z.string(), reason: z.string(), answered: z.boolean() }).optional(),
});
export type GateState = z.infer<typeof GateStateSchema>;

export const ChildRoleSchema = z.enum(["reviewer", "planner", "synthesizer", "candidate", "judge", "phase", "other"]);
export type ChildRole = z.infer<typeof ChildRoleSchema>;

export const ChildSchema = z.object({
  sessionID: z.string(),
  agent: z.string(),
  role: ChildRoleSchema,
  parentID: z.string(),
  /** Bindung an eine Review-Runde: Gate + Version. */
  gate: z.string().optional(),
  version: z.string().optional(),
  /** Fan-out-Kennung, falls von FiGr selbst gestartet. */
  fanout: z.string().optional(),
  /** Bei Kandidaten: Buchstabe; bei Planern: Zielpfad. */
  label: z.string().optional(),
  report: z.record(z.string(), z.unknown()).optional(),
  nudges: z.number().int().default(0),
  done: z.boolean().default(false),
});
export type Child = z.infer<typeof ChildSchema>;

export const PendingBindingSchema = z.object({ agent: z.string(), gate: z.string(), version: z.string(), at: z.number() });
export type PendingBinding = z.infer<typeof PendingBindingSchema>;

export const OverrideSchema = z.object({ gate: z.string(), kind: z.enum(["skip", "reset", "escalation"]), by: z.enum(["user", "orchestrator"]), at: z.number(), note: z.string().optional() });

export const FanoutInfoSchema = z.object({
  id: z.string(),
  kind: z.enum(["review", "plan", "best-of-n"]),
  gate: z.string(),
  startedAt: z.number(),
  jobs: z.array(z.object({ label: z.string(), agent: z.string(), status: z.enum(["pending", "running", "done", "missing", "failed", "cancelled"]), sessionID: z.string().optional() })),
});
export type FanoutInfo = z.infer<typeof FanoutInfoSchema>;

export const STATE_VERSION = 1;

export const SessionStateSchema = z.object({
  stateVersion: z.literal(STATE_VERSION),
  sessionID: z.string(),
  profile: z.string(),
  enabled: z.boolean().default(true),
  /** HEAD beim Start der geführten Session; Basis für `diff`-Artefakte. */
  baseCommit: z.string().optional(),
  gates: z.record(z.string(), GateStateSchema).default({}),
  subagentsTotal: z.number().int().default(0),
  /** Fortsetzungen des Stop-Guards seit der letzten Nutzernachricht. */
  nudges: z.number().int().default(0),
  /** Direkte subagent-Aufrufe seit der letzten Nutzernachricht. */
  directSubagentsThisTurn: z.number().int().default(0),
  children: z.record(z.string(), ChildSchema).default({}),
  pending: z.array(PendingBindingSchema).default([]),
  overrides: z.array(OverrideSchema).default([]),
  fanouts: z.array(FanoutInfoSchema).default([]),
  lastBlock: z.object({ message: z.string(), at: z.number() }).optional(),
  createdAt: z.number(),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export function emptyGateState(): GateState {
  return GateStateSchema.parse({});
}

export function newSessionState(sessionID: string, profile: string, at: number, baseCommit?: string): SessionState {
  return SessionStateSchema.parse({ stateVersion: STATE_VERSION, sessionID, profile, createdAt: at, ...(baseCommit ? { baseCommit } : {}) });
}

/** Aktuelle Artefakt-Versionen pro Gate (Hash), `undefined` = kein Artefakt vorhanden. */
export type CurrentVersions = Readonly<Record<string, string | undefined>>;
