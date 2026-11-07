/** Kleine JSON-Schema-Prüfung für Ausgabe-Verträge und Übergaben (type, properties, required, enum, items, additionalProperties, minItems, minLength). */
export type JsonSchema = Record<string, unknown>;

export interface SchemaIssue {
  path: string;
  message: string;
}

export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "$"): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const type = schema.type;
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((e) => e === value)) {
    issues.push({ path, message: `muss einer von ${enumValues.map((e) => JSON.stringify(e)).join(", ")} sein` });
    return issues;
  }
  if (typeof type === "string" && !matchesType(type, value)) {
    issues.push({ path, message: `erwartet ${type}, erhalten ${describe(value)}` });
    return issues;
  }
  if (Array.isArray(type) && !type.some((t) => typeof t === "string" && matchesType(t, value))) {
    issues.push({ path, message: `erwartet ${type.join("|")}, erhalten ${describe(value)}` });
    return issues;
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    issues.push({ path, message: `mindestens ${schema.minLength} Zeichen` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) issues.push({ path, message: `mindestens ${schema.minItems} Einträge` });
    if (isObject(schema.items)) value.forEach((item, i) => issues.push(...validateJsonSchema(schema.items as JsonSchema, item, `${path}[${i}]`)));
  }
  if (isObject(value) && (type === "object" || isObject(schema.properties))) {
    const props = isObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) if (typeof key === "string" && value[key] === undefined) issues.push({ path: `${path}.${key}`, message: "fehlt" });
    for (const [key, sub] of Object.entries(props)) if (value[key] !== undefined) issues.push(...validateJsonSchema(sub, value[key], `${path}.${key}`));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) issues.push({ path: `${path}.${key}`, message: "ist nicht erlaubt" });
    }
  }
  return issues;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function formatIssues(issues: SchemaIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}
