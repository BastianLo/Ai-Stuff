import type { AgentDefinition } from "./agent.js";
import type { JsonSchema } from "./jsonschema.js";
import { validateJsonSchema, formatIssues } from "./jsonschema.js";
import { AiflowError } from "./errors.js";

export interface BranchOption {
  port: string;
  description: string;
  /** Übergabe-Anweisungen aller Kanten an diesem Port. */
  instructions: string[];
}

export interface HandoffSchemaOptions {
  branches?: BranchOption[];
  output?: AgentDefinition["output"];
  candidates?: string[];
}

/** Strukturierte Übergabe eines Agent-Schritts. */
export interface Handoff {
  summary: string;
  details?: string;
  branch?: string;
  branchReason?: string;
  handoff?: string;
  output?: unknown;
  selectedCandidate?: string;
}

/** Baut das JSON-Schema der Abschluss-Phase für einen Knoten (PLAN.md 8.4). */
export function buildHandoffSchema(options: HandoffSchemaOptions): JsonSchema {
  const required = ["summary"];
  const properties: Record<string, JsonSchema> = {
    summary: { type: "string", minLength: 1, description: "Was wurde getan bzw. entschieden? Höchstens 10 Sätze." },
    details: { type: "string", description: "Optionale Details für den nächsten Schritt." },
  };
  const branches = options.branches ?? [];
  if (branches.length > 1) {
    required.push("branch", "branchReason");
    properties.branch = {
      enum: branches.map((b) => b.port),
      description: branches.map((b) => `${b.port}: ${b.description || "(keine Beschreibung)"}`).join(" · "),
    };
    properties.branchReason = { type: "string", minLength: 1, description: "Begründung der Zweigwahl." };
  }
  const instructions = branches.flatMap((b) => b.instructions.map((i) => (branches.length > 1 ? `${b.port}: ${i}` : i)));
  properties.handoff = {
    type: "string",
    description: instructions.length > 0 ? `Übergabe an den nächsten Schritt. ${instructions.join(" · ")}` : "Übergabe an den nächsten Schritt.",
  };
  if (options.output?.type === "json") {
    required.push("output");
    properties.output = options.output.schema;
  }
  if (options.candidates && options.candidates.length > 0) {
    required.push("selectedCandidate");
    properties.selectedCandidate = { enum: options.candidates, description: "Gewählter Kandidat." };
  }
  return { type: "object", required, properties };
}

/** Prüft eine rohe Übergabe gegen das Schema und gibt sie typisiert zurück. */
export function parseHandoff(schema: JsonSchema, raw: unknown): Handoff {
  const issues = validateJsonSchema(schema, raw);
  if (issues.length > 0) throw new AiflowError("VALIDATION", `Ungültige Übergabe: ${formatIssues(issues)}`, issues);
  return raw as Handoff;
}

/** Mehrheitsentscheidung aus mehreren Stimmen; bei Gleichstand gewinnt `fallback` bzw. die erste Stimme. */
export function majorityVote(votes: readonly string[], fallback?: string): { winner: string; tie: boolean; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const v of votes) counts[v] = (counts[v] ?? 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter((k) => counts[k] === max);
  if (leaders.length === 1 && leaders[0] !== undefined) return { winner: leaders[0], tie: false, counts };
  const winner = fallback ?? leaders[0] ?? votes[0] ?? "";
  return { winner, tie: true, counts };
}

export type VoteRule = "majority" | "unanimous" | "veto";

/** Wertet boolesche Stimmen eines Joins aus. `veto`: ein `false` genügt. */
export function evaluateBooleanVote(values: readonly boolean[], rule: VoteRule): boolean {
  if (values.length === 0) return false;
  switch (rule) {
    case "veto":
    case "unanimous":
      return values.every(Boolean);
    case "majority":
      return values.filter(Boolean).length > values.length / 2;
  }
}
