import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, configSources, deepMerge, loadConfig, resolveConfig } from "../../src/config/load.ts";
import { validateConfig } from "../../src/config/validate.ts";
import { parseJsonc } from "../../src/util/jsonc.ts";
import { AGENTS, testConfigRaw } from "../fake-host.ts";

const issues = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  return [];
};

describe("resolveConfig", () => {
  it("löst extends auf und ersetzt produce bei anderem pattern", () => {
    const cfg = resolveConfig(testConfigRaw());
    const quick = cfg.profiles.quick!;
    expect(quick.gates.plan?.produce).toEqual({ pattern: "single", agent: "planner", enforce: false });
    expect(quick.gates.plan?.approve?.reviewers).toEqual(["architect-reviewer"]);
    // geerbt
    expect(quick.gates.plan?.approve?.veto).toBe(true);
    expect(quick.gates.implementation?.produce?.pattern).toBe("best-of-n");
    expect(quick.rules.subagents.maxParallel).toBe(4);
    expect(cfg.workDir).toBe(".opencode/figr");
  });

  it("Standardwerte für Regeln", () => {
    const r = resolveConfig({ profiles: { a: {} } }).profiles.a!.rules;
    expect(r.orchestrator.mayEdit).toBe(false);
    expect(r.orchestrator.shell.allow).toContain("git status*");
    expect(r.stopGuard).toEqual({ enabled: true, maxNudges: 3, respectQuestions: true });
  });

  it("unbekannte Schlüssel sind Fehler (mit Pfad)", () => {
    expect(issues(() => resolveConfig({ profiles: { a: { gates: { plan: { aprove: {} } } } } })).join("\n")).toMatch(/profiles\.a\.gates\.plan.*aprove/);
    expect(issues(() => resolveConfig({ profiels: {} })).length).toBeGreaterThan(0);
  });

  it("Zyklen in extends und fehlende Profile", () => {
    expect(issues(() => resolveConfig({ profiles: { a: { extends: "b" }, b: { extends: "a" } } })).join()).toContain("Zyklus");
    expect(issues(() => resolveConfig({ profiles: { a: { extends: "x" } } })).join()).toContain("„x“ existiert nicht");
    expect(issues(() => resolveConfig({ defaultProfile: "x", profiles: { a: {} } })).join()).toContain("defaultProfile");
  });

  it("deepMerge: Arrays ersetzt, Objekte gemischt", () => {
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 3 } })).toEqual({ a: [3], b: { c: 1, d: 3 } });
    expect(deepMerge({ type: "file", path: "x" }, { type: "diff" })).toEqual({ type: "diff" });
  });
});

describe("validateConfig", () => {
  it("gültige Testkonfiguration", () => {
    const r = validateConfig(resolveConfig(testConfigRaw()), AGENTS);
    expect(r.errors).toEqual([]);
  });

  it("findet fehlende Agenten, falschen Modus, Zyklen, unerreichbares Quorum, Unabhängigkeit", () => {
    const cfg = resolveConfig({
      orchestrators: ["explore"],
      profiles: {
        p: {
          gates: {
            a: { requires: ["b"], artifact: { type: "text" }, agents: ["ghost"], approve: { reviewers: ["security-reviewer"], quorum: 2 } },
            b: { requires: ["a"], artifact: { type: "text" }, agents: ["security-reviewer"], approve: { reviewers: ["security-reviewer"] } },
            c: { final: true },
            d: { final: true },
          },
        },
      },
    });
    const r = validateConfig(cfg, AGENTS);
    const text = r.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
    expect(text).toContain("Agent „ghost“ existiert nicht");
    expect(text).toContain("Orchestratoren müssen primary sein");
    expect(text).toContain("Zyklus in requires");
    expect(text).toContain("Quorum 2 ist mit 1 Reviewer(n) nicht erreichbar");
    expect(text).toContain("Höchstens ein Gate darf final sein");
    expect(r.warnings.map((w) => w.message).join()).toContain("nicht unabhängig");
  });

  it("warnt bei Reviewern mit Bearbeitungsrechten", () => {
    const cfg = resolveConfig({ profiles: { p: { gates: { g: { artifact: { type: "text" }, approve: { reviewers: ["security-reviewer"] } } } } } });
    const agents = AGENTS.map((a) => (a.id === "security-reviewer" ? { ...a, permissions: [{ action: "edit", resource: "*", effect: "allow" }] } : a));
    expect(validateConfig(cfg, agents).warnings.map((w) => w.message).join()).toContain("Bearbeitungsrechte");
  });

  it("produce/approve brauchen passende Artefakte", () => {
    const cfg = resolveConfig({ profiles: { p: { gates: { g: { produce: { pattern: "best-of-n", agent: "implementer", judge: "code-judge" }, artifact: { type: "file", path: "x" } }, h: { approve: { reviewers: ["security-reviewer"] } } } } } });
    const text = validateConfig(cfg, AGENTS).errors.map((e) => e.message).join("\n");
    expect(text).toContain("artifact.type = diff");
    expect(text).toContain("approve braucht ein artifact");
  });
});

describe("Dateien", () => {
  it("JSONC mit Kommentaren und Kommas; Syntaxfehler mit Zeile", () => {
    expect(parseJsonc('{ // x\n "a": 1, }', "f")).toEqual({ a: 1 });
    expect(() => parseJsonc('{\n "a": }', "f.jsonc")).toThrow(/f\.jsonc:2/);
  });

  it("global + Projekt, Projekt gewinnt", () => {
    const dir = mkdtempSync(join(tmpdir(), "figr-cfg-"));
    const home = join(dir, "home");
    mkdirSync(join(home, "opencode"), { recursive: true });
    mkdirSync(join(dir, "proj", ".opencode"), { recursive: true });
    writeFileSync(join(home, "opencode", "figr.jsonc"), JSON.stringify({ workDir: "global-dir", profiles: { g: {} } }));
    writeFileSync(join(dir, "proj", ".opencode", "figr.jsonc"), '{ "profiles": { "p": {} }, "defaultProfile": "p" }');
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = home;
    try {
      const cfg = loadConfig(configSources(join(dir, "proj"), {}));
      expect(cfg?.workDir).toBe("global-dir");
      expect(Object.keys(cfg?.profiles ?? {}).sort()).toEqual(["g", "p"]);
      expect(cfg?.defaultProfile).toBe("p");
      expect(loadConfig(configSources(join(dir, "empty"), { global: false }))).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});
