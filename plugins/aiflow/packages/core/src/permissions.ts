import { z } from "zod";

export const permissionEffectSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionEffect = z.infer<typeof permissionEffectSchema>;

/** Versionsneutrale Rechte-Regel (Form von opencode v2). Die letzte passende Regel gewinnt. */
export const permissionRuleSchema = z.object({
  action: z.string().min(1),
  resource: z.string().min(1).default("*"),
  effect: permissionEffectSchema,
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

export const permissionPresetSchema = z.enum(["read-only", "implement", "full"]);
export type PermissionPreset = z.infer<typeof permissionPresetSchema>;

/**
 * Bekannte Aktionen (v2-Namen). Der v1-Treiber übersetzt `shell` → `bash`, `subagent` → `task`.
 * `mcp` ist versionsneutral: Ressource ist der Name des MCP-Servers; die Runtime bildet die Regel
 * auf die Tool-Namen `<server>_<tool>` ab.
 */
export const KNOWN_ACTIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "shell",
  "webfetch",
  "websearch",
  "subagent",
  "skill",
  "question",
  "external_directory",
  "mcp",
] as const;

const rule = (action: string, resource: string, effect: PermissionEffect): PermissionRule => ({ action, resource, effect });

const READ_TOOLS = ["read", "glob", "grep", "list"] as const;
const SHELL_READ_ALLOW = ["git diff*", "git log*", "git show*", "git status*"];
const SHELL_DENY = ["git push*", "git reset --hard*", "git checkout*", "rm -rf /*", "sudo*"];

export function presetRules(preset: PermissionPreset): PermissionRule[] {
  const base: PermissionRule[] = [
    ...READ_TOOLS.map((a) => rule(a, "*", "allow")),
    rule("subagent", "*", "deny"),
    rule("question", "*", "deny"),
  ];
  switch (preset) {
    case "read-only":
      return [
        ...base,
        rule("edit", "*", "deny"),
        rule("shell", "*", "deny"),
        ...SHELL_READ_ALLOW.map((r) => rule("shell", r, "allow")),
        rule("webfetch", "*", "deny"),
        rule("websearch", "*", "deny"),
      ];
    case "implement":
      return [
        ...base,
        rule("edit", "*", "allow"),
        rule("shell", "*", "allow"),
        ...SHELL_DENY.map((r) => rule("shell", r, "deny")),
        rule("webfetch", "*", "ask"),
        rule("websearch", "*", "ask"),
      ];
    case "full":
      return [
        ...base,
        rule("edit", "*", "allow"),
        rule("shell", "*", "allow"),
        rule("shell", "git push*", "deny"),
        rule("webfetch", "*", "allow"),
        rule("websearch", "*", "allow"),
      ];
  }
}

export interface McpAccess {
  default: "allow" | "deny";
  allow: readonly string[];
  deny: readonly string[];
}

/** MCP-Zugriff eines Agenten als Regeln (Ressource = Servername). Ein Verbot schlägt eine Erlaubnis. */
export function mcpRules(access: McpAccess): PermissionRule[] {
  return [rule("mcp", "*", access.default), ...access.allow.map((s) => rule("mcp", s, "allow")), ...access.deny.map((s) => rule("mcp", s, "deny"))];
}

/** Glob-Abgleich mit `*` (beliebig) und `?` (ein Zeichen); `**` wie `*`. */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

/** Wertet Regeln aus: die letzte passende Regel gewinnt, ohne Treffer gilt `fallback`. Aktion und Ressource dürfen Muster sein (wie in opencode). */
export function evaluatePermission(
  rules: readonly PermissionRule[],
  action: string,
  resource: string,
  fallback: PermissionEffect = "deny",
): PermissionEffect {
  let effect: PermissionEffect | undefined;
  for (const r of rules) {
    if (matchesPattern(r.action, action) && matchesPattern(r.resource, resource)) effect = r.effect;
  }
  return effect ?? fallback;
}
