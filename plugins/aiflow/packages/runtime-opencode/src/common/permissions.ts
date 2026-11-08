import { matchesPattern, type PermissionRule } from "@aiflow/core";

/** Präfix der Tool-Namen eines MCP-Servers, identisch in opencode v1 und v2: `<server>_<tool>`, Sonderzeichen → `_`. */
export function mcpToolPrefix(server: string): string {
  return server.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Ersetzt versionsneutrale `mcp`-Regeln (Ressource = Servername oder Muster) durch Regeln auf die Tool-Namen
 * `<server>_*` der bekannten Server. Ein konkreter, (noch) nicht gemeldeter Servername wird trotzdem abgebildet.
 * Reihenfolge bleibt erhalten, damit „letzte passende Regel gewinnt“ weiter gilt.
 */
export function expandMcpRules(rules: readonly PermissionRule[], servers: readonly string[]): PermissionRule[] {
  return rules.flatMap((r) => {
    if (r.action !== "mcp") return [r];
    const literal = !/[*?]/.test(r.resource);
    const targets = literal ? [r.resource] : servers.filter((s) => matchesPattern(r.resource, s));
    return targets.map((s) => ({ action: `${mcpToolPrefix(s)}_*`, resource: "*", effect: r.effect }));
  });
}

const V1_ACTION: Record<string, string> = { shell: "bash", subagent: "task" };

/** v1: `{ permission, pattern, action }`, Aktionsnamen `bash`/`task`. */
export function toV1Rules(rules: readonly PermissionRule[]): { permission: string; pattern: string; action: "allow" | "ask" | "deny" }[] {
  return rules.map((r) => ({ permission: V1_ACTION[r.action] ?? r.action, pattern: r.resource, action: r.effect }));
}

/** v2: geordnete Regeln `{ action, resource, effect }` (versionsneutrales Modell entspricht v2). */
export function toV2Rules(rules: readonly PermissionRule[]): { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] {
  return rules.map((r) => ({ action: r.action, resource: r.resource, effect: r.effect }));
}
