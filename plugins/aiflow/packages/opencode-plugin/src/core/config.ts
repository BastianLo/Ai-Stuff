import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PluginOptions {
  /** Adresse des AiFlow-Daemons */
  url: string;
  /** Daemon automatisch starten, wenn er nicht läuft */
  autoStart: boolean;
  /** Befehl, um den Daemon zu starten */
  aiflowCommand: string;
  /** Tools `aiflow_run` / `aiflow_list_workflows` für den Haupt-Agenten anbieten */
  agentTools: boolean;
  /** Datenverzeichnis des Daemons (`--data-dir`), nur beim automatischen Start */
  dataDir?: string;
  /** opencode-Konfiguration für die Agenten (`--opencode-config`), nur beim automatischen Start */
  opencodeConfig?: string;
}

export function resolveOptions(raw: unknown): PluginOptions {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    url: typeof o.url === "string" ? o.url : (process.env.AIFLOW_URL ?? "http://127.0.0.1:5739"),
    autoStart: o.autoStart !== false,
    aiflowCommand: typeof o.aiflowCommand === "string" ? o.aiflowCommand : "aiflow",
    agentTools: o.agentTools !== false,
    ...(typeof o.dataDir === "string" && o.dataDir ? { dataDir: o.dataDir } : {}),
    ...(typeof o.opencodeConfig === "string" && o.opencodeConfig ? { opencodeConfig: o.opencodeConfig } : {}),
  };
}

/** Argumente für den automatischen Daemon-Start. */
export function serveArgs(options: PluginOptions): string[] {
  const port = new URL(options.url).port;
  return [
    "serve",
    "--detach",
    ...(port ? ["--port", port] : []),
    ...(options.dataDir ? ["--data-dir", options.dataDir] : []),
    ...(options.opencodeConfig ? ["--opencode-config", options.opencodeConfig] : []),
  ];
}

export function configDir(): string {
  return process.env.AIFLOW_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aiflow");
}

export function readAuthToken(): string | undefined {
  const file = join(configDir(), "auth-token");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
}

export interface WorkerEnv {
  daemonUrl: string;
  token: string;
}

/** Worker-Rolle: nur im von AiFlow gestarteten opencode (`AIFLOW_WORKER=1`). */
export function workerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv | undefined {
  if (env.AIFLOW_WORKER !== "1" || !env.AIFLOW_DAEMON_URL || !env.AIFLOW_WORKER_TOKEN) return undefined;
  return { daemonUrl: env.AIFLOW_DAEMON_URL, token: env.AIFLOW_WORKER_TOKEN };
}
