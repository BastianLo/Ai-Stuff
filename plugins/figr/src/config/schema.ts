import { z } from "zod";

/**
 * Schema der `figr.jsonc` (plan.md 6.2). Alle Objekte sind strikt, damit Tippfehler auffallen.
 *
 * Profile dürfen per `extends` voneinander erben und nur Teile überschreiben. Deshalb gibt es zwei Varianten:
 * `RawConfigSchema` (alles optional, so wie es in der Datei steht) und `ProfileSchema` (aufgelöstes Profil mit Standardwerten).
 */

const AgentId = z.string().min(1);
const Command = z.string().min(1);

export const QuorumSchema = z.union([z.literal("all"), z.literal("majority"), z.number().int().min(1)]);
export type Quorum = z.infer<typeof QuorumSchema>;

const ArtifactFile = z.strictObject({
  type: z.literal("file"),
  path: z.string().min(1),
  /** `session` = relativ zu workDir/<sid> (Standard), `project` = relativ zum Projekt. Absolute Pfade gelten unverändert. */
  root: z.enum(["session", "project"]).default("session"),
});
const ArtifactDiff = z.strictObject({
  type: z.literal("diff"),
  /** Glob-Muster für Pfade, die nicht zur Version zählen (z. B. Build-Artefakte). */
  ignore: z.array(z.string()).default([]),
});
const ArtifactText = z.strictObject({ type: z.literal("text") });
export const ArtifactSchema = z.discriminatedUnion("type", [ArtifactFile, ArtifactDiff, ArtifactText]);
export type ArtifactConfig = z.infer<typeof ArtifactSchema>;

const ProduceMultiPlan = z.strictObject({
  pattern: z.literal("multi-plan"),
  planners: z.array(AgentId).min(1),
  synthesizer: AgentId,
  askOnConflict: z.boolean().default(false),
  enforce: z.boolean().default(false),
});
const ProduceSingle = z.strictObject({
  pattern: z.literal("single"),
  agent: AgentId,
  enforce: z.boolean().default(false),
});
const ProduceBestOfN = z.strictObject({
  pattern: z.literal("best-of-n"),
  agent: AgentId,
  n: z.number().int().min(1).max(8).default(3),
  judge: AgentId,
  checks: z.array(Command).default([]),
  checksParallel: z.boolean().default(true),
  enforce: z.boolean().default(false),
});
export const ProduceSchema = z.discriminatedUnion("pattern", [ProduceMultiPlan, ProduceSingle, ProduceBestOfN]);
export type ProduceConfig = z.infer<typeof ProduceSchema>;
export type BestOfNProduce = z.infer<typeof ProduceBestOfN>;

export const ApproveSchema = z.strictObject({
  reviewers: z.array(AgentId).min(1),
  quorum: QuorumSchema.default("all"),
  veto: z.boolean().default(false),
  maxRounds: z.number().int().min(1).default(3),
  human: z.boolean().default(false),
  invalidateOnChange: z.boolean().default(true),
  checks: z.array(Command).default([]),
  /** Bewertungsmaßstab, der den Reviewern mitgegeben wird. */
  rubric: z.string().optional(),
  /** Zeitlimit pro Check in Sekunden. */
  checkTimeout: z.number().int().min(1).default(600),
});
export type ApproveConfig = z.infer<typeof ApproveSchema>;

export const EvidenceSchema = z.strictObject({
  subagents: z.strictObject({ agents: z.array(AgentId).min(1), min: z.number().int().min(1).default(1) }).optional(),
  file: z.strictObject({ path: z.string().min(1), root: z.enum(["session", "project"]).default("project") }).optional(),
  check: Command.optional(),
});
export type EvidenceConfig = z.infer<typeof EvidenceSchema>;

export const GateSchema = z.strictObject({
  description: z.string().optional(),
  requires: z.array(z.string()).default([]),
  artifact: ArtifactSchema.optional(),
  produce: ProduceSchema.optional(),
  agents: z.array(AgentId).default([]),
  approve: ApproveSchema.optional(),
  evidence: EvidenceSchema.optional(),
  final: z.boolean().default(false),
});
export type GateConfig = z.infer<typeof GateSchema>;

const DEFAULT_SHELL_ALLOW = ["git status*", "git diff*", "git log*", "git show*", "ls*", "pwd"];

export const RulesSchema = z.strictObject({
  orchestrator: z
    .strictObject({
      mayEdit: z.boolean().default(false),
      shell: z.strictObject({ allow: z.array(z.string()).default(DEFAULT_SHELL_ALLOW) }).prefault({}),
      maxDirectSubagentsPerTurn: z.number().int().min(1).nullable().default(null),
    })
    .prefault({}),
  subagents: z
    .strictObject({
      maxParallel: z.number().int().min(1).default(4),
      maxTotal: z.number().int().min(1).default(60),
      independentReviews: z.boolean().default(true),
    })
    .prefault({}),
  stopGuard: z
    .strictObject({
      enabled: z.boolean().default(true),
      maxNudges: z.number().int().min(0).default(3),
      /** Endet die letzte Antwort mit einer Frage an den Nutzer, wird nicht nachgeschickt. */
      respectQuestions: z.boolean().default(true),
    })
    .prefault({}),
  stagnation: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
});
export type RulesConfig = z.infer<typeof RulesSchema>;

export const ProfileSchema = z.strictObject({
  gates: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/, "Gate-Namen: Kleinbuchstaben, Ziffern, - und _"), GateSchema).default({}),
  rules: RulesSchema.prefault({}),
});
export type ProfileConfig = z.infer<typeof ProfileSchema>;

/** Rohform eines Profils: beliebige (strikte) Teilmenge, aufgelöst über `extends`. Tiefe Prüfung erst nach dem Zusammenführen. */
export const RawProfileSchema = z.strictObject({
  extends: z.string().optional(),
  gates: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
});
export type RawProfile = z.infer<typeof RawProfileSchema>;

export const RawConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  defaultProfile: z.string().optional(),
  orchestrators: z.array(AgentId).default(["orchestrator"]),
  workDir: z.string().min(1).default(".opencode/figr"),
  profiles: z.record(z.string(), RawProfileSchema).default({}),
});
export type RawConfig = z.infer<typeof RawConfigSchema>;

/** Vollständig aufgelöste Konfiguration. */
export interface FigrConfig {
  readonly orchestrators: readonly string[];
  readonly workDir: string;
  readonly defaultProfile: string;
  readonly profiles: Readonly<Record<string, ProfileConfig>>;
}

/** Plugin-Optionen aus `opencode.json`. */
export const PluginOptionsSchema = z.object({
  profile: z.string().optional(),
  config: z.string().optional(),
  /** Nur für Tests: globale Konfiguration abschalten. */
  global: z.boolean().optional(),
});
export type PluginOptions = z.infer<typeof PluginOptionsSchema>;
