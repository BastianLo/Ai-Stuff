import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import type { AgentInfo } from "../../src/config/validate.ts";
import { validateConfig } from "../../src/config/validate.ts";
import { parseJsonc } from "../../src/util/jsonc.ts";

const root = join(import.meta.dirname, "..", "..", "examples");

/** Minimaler Frontmatter-Leser für die Beispiel-Agenten (mode + permissions). */
function readAgent(file: string): AgentInfo {
  const text = readFileSync(join(root, "agent", file), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const mode = /^mode: (\w+)/m.exec(fm)?.[1] as AgentInfo["mode"];
  const permissions = [...fm.matchAll(/action: "([^"]+)", resource: "([^"]+)", effect: "(\w+)"/g)].map((m) => ({ action: m[1]!, resource: m[2]!, effect: m[3]! }));
  return { id: file.replace(/\.md$/, ""), mode, permissions };
}

describe("Beispiele", () => {
  const agents = readdirSync(join(root, "agent")).filter((f) => f.endsWith(".md")).map(readAgent);

  it("Agent-Dateien haben gültige Frontmatter", () => {
    expect(agents.length).toBeGreaterThanOrEqual(13);
    for (const a of agents) expect(["primary", "subagent"]).toContain(a.mode);
    expect(agents.find((a) => a.id === "orchestrator")?.mode).toBe("primary");
  });

  it("figr.jsonc ist gültig und passt zu den Agenten (strict, quick, solo)", () => {
    const cfg = resolveConfig(parseJsonc(readFileSync(join(root, "figr.jsonc"), "utf8"), "figr.jsonc"));
    expect(Object.keys(cfg.profiles)).toEqual(["strict", "quick", "solo"]);
    const r = validateConfig(cfg, agents);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(cfg.profiles.quick?.gates.implementation?.produce?.pattern).toBe("single");
    expect(cfg.profiles.solo?.gates).toEqual({});
  });

  it("figr.schema.json ist aktuell erzeugt", () => {
    const schema = JSON.parse(readFileSync(join(root, "..", "figr.schema.json"), "utf8")) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["$schema", "version", "defaultProfile", "orchestrators", "workDir", "profiles"]);
  });
});
