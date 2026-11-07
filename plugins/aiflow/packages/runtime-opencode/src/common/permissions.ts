import type { PermissionRule } from "@aiflow/core";

const V1_ACTION: Record<string, string> = { shell: "bash", subagent: "task" };

/** v1: `{ permission, pattern, action }`, Aktionsnamen `bash`/`task`. */
export function toV1Rules(rules: readonly PermissionRule[]): { permission: string; pattern: string; action: "allow" | "ask" | "deny" }[] {
  return rules.map((r) => ({ permission: V1_ACTION[r.action] ?? r.action, pattern: r.resource, action: r.effect }));
}

/** v2: geordnete Regeln `{ action, resource, effect }` (versionsneutrales Modell entspricht v2). */
export function toV2Rules(rules: readonly PermissionRule[]): { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] {
  return rules.map((r) => ({ action: r.action, resource: r.resource, effect: r.effect }));
}
