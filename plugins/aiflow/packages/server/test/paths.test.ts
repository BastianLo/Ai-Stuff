import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandPath, resolvePaths } from "@aiflow/server";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function configDir(settings?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "aiflow-paths-"));
  roots.push(root);
  const dir = join(root, "config");
  mkdirSync(dir);
  if (settings !== undefined) writeFileSync(join(dir, "config.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return dir;
}

describe("Pfade und Einstellungen", () => {
  it("nutzt XDG-Standards ohne Einstellungen", () => {
    const dir = configDir();
    expect(resolvePaths({}, { AIFLOW_CONFIG_DIR: dir, XDG_DATA_HOME: "/xdg/data" })).toEqual({ config: dir, data: "/xdg/data/aiflow" });
  });

  it("liest config.json und expandiert ~", () => {
    const dir = configDir({ dataDir: "~/aiflow-daten", opencodeConfig: "~/.config/opencode.jsonc" });
    expect(resolvePaths({}, { AIFLOW_CONFIG_DIR: dir })).toEqual({
      config: dir,
      data: join(homedir(), "aiflow-daten"),
      opencodeConfig: join(homedir(), ".config", "opencode.jsonc"),
    });
  });

  it("Vorrang: Option > Umgebung > config.json", () => {
    const dir = configDir({ dataDir: "/aus/datei", opencodeConfig: "/datei/opencode.json" });
    const env = { AIFLOW_CONFIG_DIR: dir, AIFLOW_DATA_DIR: "/aus/env", AIFLOW_OPENCODE_CONFIG: "/env/opencode.json" };
    expect(resolvePaths({}, env)).toMatchObject({ data: "/aus/env", opencodeConfig: "/env/opencode.json" });
    expect(resolvePaths({ dataDir: "/aus/option", opencodeConfig: "/option/oc.jsonc" }, env)).toMatchObject({ data: "/aus/option", opencodeConfig: "/option/oc.jsonc" });
  });

  it("meldet ungültige Einstellungen verständlich", () => {
    expect(() => resolvePaths({}, { AIFLOW_CONFIG_DIR: configDir("{ kaputt") })).toThrow(/kein gültiges JSON/);
    expect(() => resolvePaths({}, { AIFLOW_CONFIG_DIR: configDir({ datadir: "/x" }) })).toThrow(/config\.json/);
  });

  it("macht relative Pfade absolut", () => {
    expect(expandPath("~")).toBe(homedir());
    expect(expandPath("daten")).toBe(join(process.cwd(), "daten"));
  });
});
