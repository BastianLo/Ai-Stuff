import { z } from "zod";
import { permissionPresetSchema, permissionRuleSchema } from "./permissions.js";

const durationSchema = z.union([z.string(), z.number()]);
export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_]*$/, "Nur Kleinbuchstaben, Ziffern, '-' und '_' (beginnend mit Buchstabe/Ziffer)");

export const modelRefSchema = z.object({
  ref: z.string().regex(/^[^/\s]+\/\S+$/, "Format: provider/modell"),
  variant: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export function splitModelRef(ref: string): { providerID: string; modelID: string } {
  const index = ref.indexOf("/");
  return { providerID: ref.slice(0, index), modelID: ref.slice(index + 1) };
}

export const contextModeSchema = z.enum(["fresh", "resume", "fork"]);
export type ContextMode = z.infer<typeof contextModeSchema>;

export const subagentSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  allowed: z.array(idSchema).default([]),
  mode: z.enum(["optional", "enforced"]).default("optional"),
  maxParallel: z.number().int().min(1).max(32).default(4),
  maxRuns: z.number().int().min(1).max(500).default(12),
  maxWaves: z.number().int().min(1).max(100).optional(),
  depth: z.number().int().min(0).max(3).default(0),
  workspace: z.enum(["read-only", "isolate"]).default("read-only"),
  documents: z.enum(["none", "read"]).default("read"),
  context: z.array(z.enum(["input.prompt", "goal", "documents"])).default(["input.prompt", "documents"]),
  timeoutPerAgent: durationSchema.default("20m"),
  /** Bei `enforced`: Tools, die trotz Delegationszwang erlaubt bleiben (z. B. `list`). */
  keepTools: z.array(z.string()).default([]),
});
export type SubagentSettings = z.infer<typeof subagentSettingsSchema>;

export const outputContractSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json"), schema: z.record(z.string(), z.unknown()) }),
]);
export type OutputContract = z.infer<typeof outputContractSchema>;

export const agentSchema = z.object({
  schema: z.literal("aiflow/agent@1").default("aiflow/agent@1"),
  id: idSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  tags: z.array(z.string()).default([]),
  appearance: z.object({ icon: z.string().default("bot"), color: z.string().default("#6366f1") }).default({ icon: "bot", color: "#6366f1" }),
  identity: z.string().default(""),
  snippets: z.array(idSchema).default([]),
  includeProjectInstructions: z.boolean().default(true),
  model: modelRefSchema.optional(),
  limits: z
    .object({ maxSteps: z.number().int().positive().optional(), timeout: durationSchema.default("30m"), retries: z.number().int().min(0).max(5).default(1) })
    .default({ timeout: "30m", retries: 1 }),
  permissions: z
    .object({ preset: permissionPresetSchema.default("read-only"), rules: z.array(permissionRuleSchema).default([]), questions: z.boolean().default(false) })
    .default({ preset: "read-only", rules: [], questions: false }),
  /** MCP-Server: `default` gilt für nicht aufgeführte Server; `allow`/`deny` überschreiben pro Server. */
  mcp: z
    .object({ default: z.enum(["allow", "deny"]).default("allow"), allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]) })
    .default({ default: "allow", allow: [], deny: [] }),
  output: outputContractSchema.default({ type: "text" }),
  contextMode: contextModeSchema.default("fresh"),
  decision: z.object({ votes: z.number().int().min(1).max(9).default(1) }).default({ votes: 1 }),
  subagents: subagentSettingsSchema.optional(),
});
export type AgentDefinition = z.infer<typeof agentSchema>;
export type AgentInput = z.input<typeof agentSchema>;

export const snippetSchema = z.object({
  schema: z.literal("aiflow/snippet@1").default("aiflow/snippet@1"),
  id: idSchema,
  name: z.string().min(1),
  description: z.string().default(""),
  kind: z.enum(["instruction", "document-template"]).default("instruction"),
  content: z.string(),
});
export type Snippet = z.infer<typeof snippetSchema>;
