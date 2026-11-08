import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { parseJsonc } from "../util/jsonc.ts";
import { ProfileSchema, RawConfigSchema, type FigrConfig, type ProfileConfig, type RawConfig } from "./schema.ts";

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("\n"));
    this.name = "ConfigError";
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Tiefen-Merge: Objekte werden zusammengeführt, Arrays und Skalare ersetzt.
 * Unterscheidet sich ein Diskriminator (`pattern` bei produce, `type` bei artifact), wird das Objekt ersetzt statt gemischt.
 */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isObject(base) || !isObject(over)) return over;
  for (const key of ["pattern", "type"]) {
    if (key in over && key in base && over[key] !== base[key]) return over;
  }
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function zodIssues(error: z.ZodError, prefix: string): ConfigIssue[] {
  return error.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join("."), message: i.message }));
}

/** Löst `extends` auf (ohne Zyklen) und validiert jedes Profil vollständig. */
export function resolveConfig(raw: unknown, file = "figr.jsonc"): FigrConfig {
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(zodIssues(parsed.error, file));
  const cfg: RawConfig = parsed.data;
  const issues: ConfigIssue[] = [];
  const resolved: Record<string, ProfileConfig> = {};
  const merged = new Map<string, unknown>();

  const mergedProfile = (name: string, trail: string[]): unknown => {
    const cached = merged.get(name);
    if (cached !== undefined) return cached;
    const profile = cfg.profiles[name];
    if (!profile) {
      issues.push({ path: `profiles.${trail.at(-1) ?? name}.extends`, message: `Profil „${name}“ existiert nicht` });
      return {};
    }
    if (trail.includes(name)) {
      issues.push({ path: `profiles.${name}.extends`, message: `Zyklus in extends: ${[...trail, name].join(" → ")}` });
      return {};
    }
    const { extends: parent, ...own } = profile;
    const base = parent ? mergedProfile(parent, [...trail, name]) : {};
    const result = deepMerge(base, own);
    merged.set(name, result);
    return result;
  };

  for (const name of Object.keys(cfg.profiles)) {
    const value = mergedProfile(name, []);
    const p = ProfileSchema.safeParse(value);
    if (p.success) resolved[name] = p.data;
    else issues.push(...zodIssues(p.error, `profiles.${name}`));
  }
  if (Object.keys(cfg.profiles).length === 0) issues.push({ path: "profiles", message: "Mindestens ein Profil ist nötig" });
  const defaultProfile = cfg.defaultProfile ?? Object.keys(cfg.profiles)[0] ?? "";
  if (defaultProfile && !cfg.profiles[defaultProfile]) issues.push({ path: "defaultProfile", message: `Profil „${defaultProfile}“ existiert nicht` });
  if (issues.length > 0) throw new ConfigError(issues);
  return { orchestrators: cfg.orchestrators, workDir: cfg.workDir, defaultProfile, profiles: resolved };
}

export interface ConfigSources {
  readonly global?: string;
  readonly project: string;
}

/** Orte laut plan.md 6.1: global, Projekt bzw. der Pfad aus den Plugin-Optionen. */
export function configSources(projectDir: string, options: { config?: string; global?: boolean }): ConfigSources {
  const project = options.config ? (isAbsolute(options.config) ? options.config : resolve(projectDir, options.config)) : join(projectDir, ".opencode", "figr.jsonc");
  if (options.global === false) return { project };
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return { global: join(base, "opencode", "figr.jsonc"), project };
}

/** Lädt globale und Projekt-Konfiguration, führt sie zusammen und löst Profile auf. `undefined`, wenn keine Datei existiert. */
export function loadConfig(sources: ConfigSources): FigrConfig | undefined {
  const files = [sources.global, sources.project].filter((f): f is string => !!f && existsSync(f));
  if (files.length === 0) return undefined;
  let raw: unknown = {};
  for (const f of files) raw = deepMerge(raw, parseJsonc(readFileSync(f, "utf8"), f));
  return resolveConfig(raw, files.at(-1));
}

/** Beobachtet die Konfigurationsdateien (debounced). Fehlende Dateien werden über ihr Verzeichnis beobachtet. */
export function watchConfig(sources: ConfigSources, onChange: () => void, debounceMs = 300): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  for (const file of [sources.global, sources.project]) {
    if (!file) continue;
    const dir = resolve(file, "..");
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, (_event, name) => {
        if (!name || file.endsWith(name)) fire();
      });
      w.unref();
      watchers.push(w);
    } catch {
      // Beobachten ist eine Komfortfunktion; ohne Watcher gilt die Konfiguration bis zum Neustart.
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
