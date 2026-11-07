/** Kleine Helfer zum toleranten Lesen unbekannter API-Antworten. */
export function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

export function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}
