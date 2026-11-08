import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { AiflowError } from "@aiflow/core";

export interface AiflowPaths {
  /** Konfiguration und Auth-Token (`~/.config/aiflow`). */
  config: string;
  /** Datenbank, Worktrees, Dokumente, Logs (`~/.local/share/aiflow`, konfigurierbar). */
  data: string;
  /** Zusätzliche opencode-Konfigurationsdatei für den Worker (`OPENCODE_CONFIG`). */
  opencodeConfig?: string;
}

/** Dauerhafte Einstellungen in `<config>/config.json`. */
export const settingsSchema = z
  .object({
    dataDir: z.string().min(1).optional(),
    opencodeConfig: z.string().min(1).optional(),
  })
  .strict();
export type AiflowSettings = z.infer<typeof settingsSchema>;

export interface PathOverrides {
  dataDir?: string | undefined;
  opencodeConfig?: string | undefined;
}

/** `~` und `~/…` auf das Home-Verzeichnis abbilden, dann absolut machen. */
export function expandPath(path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return resolve(expanded);
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AIFLOW_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aiflow");
}

export function readSettings(configDir: string): AiflowSettings {
  const file = join(configDir, "config.json");
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new AiflowError("VALIDATION", `${file} ist kein gültiges JSON.`);
  }
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new AiflowError("VALIDATION", `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(Wurzel)"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/**
 * Verzeichnisse und opencode-Konfiguration. Vorrang: Aufruf-Option > Umgebung (`AIFLOW_DATA_DIR`,
 * `AIFLOW_OPENCODE_CONFIG`) > `<config>/config.json` > XDG-Standard.
 */
export function resolvePaths(overrides: PathOverrides = {}, env: NodeJS.ProcessEnv = process.env): AiflowPaths {
  const config = defaultConfigDir(env);
  const settings = readSettings(config);
  const dataDir = overrides.dataDir ?? env.AIFLOW_DATA_DIR ?? settings.dataDir;
  const opencodeConfig = overrides.opencodeConfig ?? env.AIFLOW_OPENCODE_CONFIG ?? settings.opencodeConfig;
  return {
    config,
    data: dataDir ? expandPath(dataDir) : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "aiflow"),
    ...(opencodeConfig ? { opencodeConfig: expandPath(opencodeConfig) } : {}),
  };
}

/** XDG-konforme Verzeichnisse; per Umgebung und `config.json` überschreibbar. */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env): AiflowPaths {
  return resolvePaths({}, env);
}

/** Auth-Token (0600). Wird beim ersten Start erzeugt. */
export function ensureToken(configDir: string): string {
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, "auth-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}
