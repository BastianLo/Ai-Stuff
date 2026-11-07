import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AiflowPaths {
  config: string;
  data: string;
}

/** XDG-konforme Verzeichnisse; per Umgebung überschreibbar (Tests, mehrere Instanzen). */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env): AiflowPaths {
  const home = homedir();
  const config = env.AIFLOW_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "aiflow");
  const data = env.AIFLOW_DATA_DIR ?? join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "aiflow");
  return { config, data };
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
