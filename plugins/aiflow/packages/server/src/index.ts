import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { Daemon, type DaemonOptions } from "./daemon.js";

export { Daemon, type DaemonOptions, type GlobalEvent, type RuntimeStatus } from "./daemon.js";
export { createApp, toRunView } from "./app.js";
export { defaultPaths, ensureToken, expandPath, readSettings, resolvePaths, settingsSchema, type AiflowPaths, type AiflowSettings, type PathOverrides } from "./paths.js";

export const defaultWebDir = fileURLToPath(new URL("../../web/dist", import.meta.url));
export const examplesDir = fileURLToPath(new URL("../../../examples", import.meta.url));

export interface RunningDaemon {
  daemon: Daemon;
  url: string;
  close(): Promise<void>;
}

/** Startet Daemon und HTTP-Server. Eine Lock-Datei verhindert Doppelstarts. */
export async function startDaemon(options: DaemonOptions & { webDir?: string; allowAnyHost?: boolean }): Promise<RunningDaemon> {
  mkdirSync(options.paths.data, { recursive: true });
  const lock = join(options.paths.data, "daemon.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (pid && isAlive(pid)) throw new Error(`AiFlow-Daemon läuft bereits (PID ${pid}).`);
  }
  writeFileSync(lock, String(process.pid));
  const daemon = new Daemon(options);
  await daemon.start();
  const app = createApp(daemon, { webDir: options.webDir ?? defaultWebDir, ...(options.allowAnyHost ? { allowAnyHost: true } : {}) });
  const host = options.host ?? "127.0.0.1";
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: options.port, hostname: host }, () => resolve(s));
    s.once("error", reject);
  });
  return {
    daemon,
    url: `http://${host}:${options.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        daemon.stop();
        rmSync(lock, { force: true });
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
