import { z } from "zod";
import { FindingSchema, VerdictKindSchema } from "./types.ts";

/** Eingaben der Werkzeuge `figr_verdict` und `figr_report` (plan.md 9.1, 9.2). */
export const VerdictInputSchema = z.strictObject({
  verdict: VerdictKindSchema.describe("approved | changes_requested | rejected"),
  summary: z.string().min(1).describe("1–3 sentences"),
  findings: z.array(FindingSchema).default([]).describe("Concrete findings; blockers first"),
});
export type VerdictInput = z.infer<typeof VerdictInputSchema>;

export const PlannerReportSchema = z.strictObject({
  planPath: z.string().min(1).describe("Absolute path of the plan you wrote"),
  summary: z.string().min(1),
  risks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});
export const SynthesizerReportSchema = z.strictObject({
  planPath: z.string().min(1).describe("Absolute path of the merged plan"),
  decisions: z.array(z.strictObject({ topic: z.string(), chosen: z.string(), from: z.array(z.string()).default([]), reason: z.string() })).default([]),
  conflicts: z.array(z.string()).default([]).describe("Real conflicts that need a human decision; empty if none"),
});
export const CandidateReportSchema = z.strictObject({
  summary: z.string().min(1),
  testsRun: z.array(z.string()).default([]),
  knownIssues: z.array(z.string()).default([]),
});
export const JudgeReportSchema = z.strictObject({
  winner: z.string().min(1).describe("Letter of the winning candidate"),
  ranking: z.array(z.string()).min(1).describe("All candidate letters, best first"),
  reasons: z.string().min(1),
  mergeIdeas: z.string().optional(),
});

export type PlannerReport = z.infer<typeof PlannerReportSchema>;
export type SynthesizerReport = z.infer<typeof SynthesizerReportSchema>;
export type CandidateReport = z.infer<typeof CandidateReportSchema>;
export type JudgeReport = z.infer<typeof JudgeReportSchema>;

export const REPORT_SCHEMAS = {
  planner: PlannerReportSchema,
  synthesizer: SynthesizerReportSchema,
  candidate: CandidateReportSchema,
  judge: JudgeReportSchema,
} as const;
export type ReportRole = keyof typeof REPORT_SCHEMAS;

export const isReportRole = (role: string): role is ReportRole => role in REPORT_SCHEMAS;

/** Formatiert Zod-Fehler kurz für das Modell. */
export function issuesText(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}
