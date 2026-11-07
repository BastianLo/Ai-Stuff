import { z } from "zod";
import { contextModeSchema, idSchema, modelRefSchema, subagentSettingsSchema } from "./agent.js";

const durationSchema = z.union([z.string(), z.number()]);
const jsonLogicSchema = z.unknown();

export const documentAccessSchema = z.enum(["none", "read", "append", "write", "write-required"]);
export type DocumentAccess = z.infer<typeof documentAccessSchema>;

export const workspaceModeSchema = z.enum(["continue", "isolate", "read-only", "scratch"]);
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;

export const finalizeModeSchema = z.enum(["apply", "review", "branch", "patch", "none"]);
export type FinalizeMode = z.infer<typeof finalizeModeSchema>;

export const outcomeSchema = z.enum(["success", "rejected", "failed", "cancelled"]);
export type Outcome = z.infer<typeof outcomeSchema>;

const portSpecSchema = z.object({
  description: z.string().default(""),
  label: z.string().optional(),
});

const nodeBase = { label: z.string().optional(), notes: z.string().optional() };

export const startNodeSchema = z.object({ type: z.literal("start"), ...nodeBase });

export const agentNodeSchema = z.object({
  type: z.literal("agent"),
  ...nodeBase,
  agent: idSchema,
  instructions: z.string().optional(),
  model: modelRefSchema.optional(),
  contextMode: contextModeSchema.optional(),
  workspace: z.object({ mode: workspaceModeSchema.default("continue"), writeScope: z.array(z.string()).optional() }).optional(),
  documents: z.record(z.string(), documentAccessSchema).default({}),
  /** Benannte Zweige: Der Agent wählt genau einen. Ohne Angabe gibt es nur `next`. */
  ports: z.record(idSchema, portSpecSchema).optional(),
  decision: z.object({ votes: z.number().int().min(1).max(9).optional(), fallback: z.string().optional() }).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  timeout: durationSchema.optional(),
  maxVisits: z.number().int().positive().optional(),
  subagents: subagentSettingsSchema.partial().optional(),
});

const scriptPortSchema = z.object({ when: jsonLogicSchema.optional(), else: z.boolean().optional() });
export const scriptNodeSchema = z.object({
  type: z.literal("script"),
  ...nodeBase,
  command: z.string().min(1),
  timeout: durationSchema.default("15m"),
  env: z.record(z.string(), z.string()).default({}),
  ports: z.record(idSchema, scriptPortSchema).optional(),
});

export const conditionNodeSchema = z.object({
  type: z.literal("condition"),
  ...nodeBase,
  rules: z.record(idSchema, jsonLogicSchema),
});

export const joinNodeSchema = z.object({
  type: z.literal("join"),
  ...nodeBase,
  wait: z.enum(["all", "first", "n-of-m"]).default("all"),
  n: z.number().int().positive().optional(),
  combine: z
    .object({
      strategy: z.enum(["collect", "vote"]).default("collect"),
      field: z.string().optional(),
      rule: z.enum(["majority", "unanimous", "veto"]).optional(),
      ports: z.record(z.string(), idSchema).optional(),
    })
    .default({ strategy: "collect" }),
  workspace: z.enum(["keep-base", "candidates", "git-merge"]).default("keep-base"),
});

export const mapNodeSchema = z.object({
  type: z.literal("map"),
  ...nodeBase,
  /** Pfad im Run-Kontext, z. B. `node.plan.output.tasks`. */
  items: z.string().min(1),
  agent: idSchema,
  task: z.string().default("{{item}}"),
  maxParallel: z.number().int().min(1).max(32).default(3),
  workspace: z.enum(["read-only", "isolate"]).default("read-only"),
  merge: z.enum(["git-merge", "none"]).default("none"),
});

export const humanNodeSchema = z.object({
  type: z.literal("human"),
  ...nodeBase,
  question: z.string().min(1),
  ports: z.array(idSchema).min(1),
  allowFreeText: z.boolean().default(true),
  timeout: durationSchema.optional(),
  defaultPort: idSchema.optional(),
});

export const subworkflowNodeSchema = z.object({
  type: z.literal("subworkflow"),
  ...nodeBase,
  workflow: idSchema,
  prompt: z.string().default("{{input.prompt}}"),
});

export const endNodeSchema = z.object({
  type: z.literal("end"),
  ...nodeBase,
  outcome: outcomeSchema.default("success"),
  finalize: finalizeModeSchema.optional(),
  report: z.string().optional(),
});

export const noteNodeSchema = z.object({ type: z.literal("note"), text: z.string().default(""), ...nodeBase });

export const nodeSchema = z.discriminatedUnion("type", [
  startNodeSchema,
  agentNodeSchema,
  scriptNodeSchema,
  conditionNodeSchema,
  joinNodeSchema,
  mapNodeSchema,
  humanNodeSchema,
  subworkflowNodeSchema,
  endNodeSchema,
  noteNodeSchema,
]);
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type NodeType = WorkflowNode["type"];
export type NodeOf<T extends NodeType> = Extract<WorkflowNode, { type: T }>;

export const contextIncludeSchema = z.enum([
  "input.prompt",
  "summary",
  "details",
  "output",
  "feedback",
  "journal",
  "diff.stat",
  "diff.full",
  "documents",
  "candidates",
  "subagents",
  "script.output",
  "join.feedback",
]);
export type ContextInclude = z.infer<typeof contextIncludeSchema>;

export const edgeSchema = z.object({
  /** `knoten` oder `knoten.port` */
  from: z.string().regex(/^[a-z0-9][a-z0-9-_]*(\.[a-z0-9][a-z0-9-_]*)?$/),
  to: idSchema,
  label: z.string().optional(),
  handoff: z
    .object({ instruction: z.string().optional(), include: z.array(contextIncludeSchema).optional(), exclude: z.array(contextIncludeSchema).optional() })
    .optional(),
  workspace: workspaceModeSchema.optional(),
  loop: z.object({ max: z.number().int().min(1).max(50), onExceeded: idSchema }).optional(),
  resetLoopCounters: z.boolean().optional(),
});
export type WorkflowEdge = z.infer<typeof edgeSchema>;

export const documentSpecSchema = z.object({
  description: z.string().default(""),
  format: z.enum(["markdown", "text", "json"]).default("markdown"),
  template: z.string().optional(),
  requiredAtEnd: z.boolean().default(false),
  exportTo: z.string().optional(),
  showInReview: z.boolean().default(true),
});
export type DocumentSpec = z.infer<typeof documentSpecSchema>;

export const inputSpecSchema = z.object({
  type: z.enum(["text", "string", "number", "boolean", "select"]).default("text"),
  label: z.string().optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
});
export type InputSpec = z.infer<typeof inputSpecSchema>;

export const workflowSettingsSchema = z.object({
  defaultModel: z.string().optional(),
  workspace: z
    .object({ base: z.string().default("working-tree"), setup: z.string().optional(), retentionDays: z.number().int().min(0).default(14) })
    .default({ base: "working-tree", retentionDays: 14 }),
  limits: z
    .object({
      maxSteps: z.number().int().positive().default(60),
      maxDuration: durationSchema.default("3h"),
      maxParallelSessions: z.number().int().positive().default(4),
      defaultLoopMax: z.number().int().positive().default(3),
    })
    .default({ maxSteps: 60, maxDuration: "3h", maxParallelSessions: 4, defaultLoopMax: 3 }),
  finalize: finalizeModeSchema.default("review"),
  context: z.array(contextIncludeSchema).default(["input.prompt", "summary", "details", "output", "feedback", "journal", "diff.stat", "documents", "candidates", "subagents"]),
});
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const workflowSchema = z.object({
  schema: z.literal("aiflow/workflow@1").default("aiflow/workflow@1"),
  id: idSchema,
  name: z.string().min(1),
  command: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Command-Name: Kleinbuchstaben, Ziffern, Bindestriche")
    .optional(),
  description: z.string().default(""),
  inputs: z.record(z.string(), inputSpecSchema).default({ prompt: { type: "text", required: true } }),
  variables: z.record(z.string(), z.string()).default({}),
  settings: workflowSettingsSchema.default(workflowSettingsSchema.parse({})),
  documents: z.record(z.string(), documentSpecSchema).default({}),
  nodes: z.record(idSchema, nodeSchema),
  edges: z.array(edgeSchema).default([]),
  layout: z.record(z.string(), z.tuple([z.number(), z.number()])).default({}),
});
export type Workflow = z.infer<typeof workflowSchema>;
export type WorkflowInput = z.input<typeof workflowSchema>;

export function commandName(workflow: Pick<Workflow, "id" | "command">): string {
  return workflow.command ?? workflow.id;
}

export { jsonLogicSchema };
