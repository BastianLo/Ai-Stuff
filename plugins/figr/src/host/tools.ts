import { toJsonSchema, VerdictInputSchema } from "../core/reports.ts";
import { TOOL } from "../figr.ts";

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input: Record<string, unknown>;
}

const str = (description: string) => ({ type: "string", description });

/** Tool-Definitionen (plan.md 9). Beschreibungen auf Englisch, weil sie das Modell lesen soll. */
export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: TOOL.status,
    description: "FiGr: show gates, their status, versions, approvals, open findings and the recommended next step.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: TOOL.plan,
    description: "FiGr: produce the plan for the plan gate. Runs the configured planners in parallel (independently) and a synthesizer that merges their plans, or a single planner. Returns the plan path and version. Then call figr_review for the plan gate.",
    input: {
      type: "object",
      required: ["task"],
      properties: {
        task: str("The complete task description for the planners"),
        planners: { type: "array", items: { type: "string" }, description: "Optional subset of configured planner agents" },
        context: str("Optional findings from research to give the planners"),
        gate: str("Optional gate name (defaults to the gate produced by figr_plan)"),
      },
      additionalProperties: false,
    },
  },
  {
    name: TOOL.review,
    description: "FiGr: start the review board of a gate for the current artifact version. All configured reviewers run in parallel; checks run too. Returns the result, findings grouped by severity and the next step. Text approvals do not count – only this tool or reviewers' figr_verdict calls do.",
    input: { type: "object", required: ["gate"], properties: { gate: str("Gate name, e.g. plan or implementation"), focus: str("Optional focus for this round") }, additionalProperties: false },
  },
  {
    name: TOOL.bestOfN,
    description: "FiGr: best-of-N implementation. N implementers work in separate git worktrees, checks run per candidate, a judge picks the winner, and the winner is applied to the project. Then call figr_review for the implementation gate.",
    input: {
      type: "object",
      required: ["task"],
      properties: { task: str("Complete implementation task"), n: { type: "integer", minimum: 1, maximum: 8, description: "Number of candidates (default from config)" }, agent: str("Optional implementer agent") },
      additionalProperties: false,
    },
  },
  {
    name: TOOL.submit,
    description: "FiGr: submit a text artifact for a gate (artifact type text), or write the gate's plan file from text (artifact type file).",
    input: { type: "object", required: ["gate", "text"], properties: { gate: str("Gate name"), text: str("Full artifact text (Markdown)") }, additionalProperties: false },
  },
  {
    name: TOOL.verdict,
    description: "FiGr: submit your structured review verdict for the gate you are reviewing. Call exactly once at the end of your review.",
    input: toJsonSchema(VerdictInputSchema),
  },
  {
    name: TOOL.report,
    description: "FiGr: submit the structured result of your role (planner, synthesizer, candidate or judge). Call exactly once at the end.",
    input: { type: "object", additionalProperties: true },
  },
];
