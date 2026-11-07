import type { JsonSchema } from "@aiflow/core";

/** Erzeugt einen minimalen gültigen Wert zu einem JSON-Schema (für Fakes und Simulation). */
export function sampleFromSchema(schema: JsonSchema, hints: Record<string, unknown> = {}, key = ""): unknown {
  if (key in hints) return hints[key];
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "object": {
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(props)) if (required.includes(k) || k in hints) out[k] = sampleFromSchema(sub, hints, k);
      return out;
    }
    case "array":
      return [];
    case "string":
      return key ? `${key}` : "text";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return true;
    default:
      return null;
  }
}
