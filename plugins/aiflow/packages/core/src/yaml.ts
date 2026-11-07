import { parse, stringify } from "yaml";
import type { z } from "zod";
import { AiflowError } from "./errors.js";

/** Parst YAML und prüft gegen ein Zod-Schema. Fehlermeldungen nennen Pfad und Problem. */
export function parseYaml<S extends z.ZodType>(schema: S, text: string, source = "YAML"): z.infer<S> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new AiflowError("VALIDATION", `${source}: kein gültiges YAML (${error instanceof Error ? error.message : String(error)}).`);
  }
  return parseWithSchema(schema, raw, source);
}

export function parseWithSchema<S extends z.ZodType>(schema: S, raw: unknown, source = "Eingabe"): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`);
    throw new AiflowError("VALIDATION", `${source} ist ungültig: ${issues.join("; ")}`, result.error.issues);
  }
  return result.data;
}

export function toYaml(value: unknown): string {
  return stringify(value, { lineWidth: 120 });
}
