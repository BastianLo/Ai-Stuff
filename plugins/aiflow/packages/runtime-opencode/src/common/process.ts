import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { AiflowError } from "@aiflow/core";
import type { OpencodeApi } from "./driver.js";

export interface WorkerOptions {
  binary?: string;
  api?: OpencodeApi | "auto";
  daemonUrl: string;
  workerToken: string;
  /** Wird bei jedem (Neu-)Start mit der neuen Adresse aufgerufen. */
  onReady?: (info: WorkerInfo) => void;
  log?: (message: string) => void;
}

export interface WorkerInfo {
  url: string;
  password: string;
  api: OpencodeApi;
  version: string;
}

export async function detectOpencode(binary = "opencode"): Promise<{ version: string; api: OpencodeApi }> {
  const version = await new Promise<string>((resolve, reject) => {
    execFile(binary, ["--version"], { timeout: 15_000 }, (error, stdout) => {
      if (error) reject(new AiflowError("RUNTIME", `opencode nicht gefunden („${binary} --version“ schlug fehl). Installiere opencode oder setze opencode.binary.`));
      else resolve(stdout.trim().split(/\s+/).pop() ?? "");
    });
  });
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return { version, api: major >= 2 ? "v2" : "v1" };
}

export function apiFromVersion(version: string): OpencodeApi {
  return Number(version.replace(/^v/, "").split(".")[0]) >= 2 ? "v2" : "v1";
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("kein Port"))));
    });
  });
}

/** Startet und überwacht `opencode serve` als Agent-Worker (PLAN.md 9.1). */
export class OpencodeWorker {
  private child?: ChildProcess;
  private stopped = false;
  private restarts = 0;
  info?: WorkerInfo;

  constructor(private readonly options: WorkerOptions) {}

  async start(): Promise<WorkerInfo> {
    const binary = this.options.binary ?? "opencode";
    const detected = await detectOpencode(binary);
    const api = this.options.api && this.options.api !== "auto" ? this.options.api : detected.api;
    const port = await freePort();
    const password = randomBytes(18).toString("base64url");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AIFLOW_WORKER: "1",
      AIFLOW_DAEMON_URL: this.options.daemonUrl,
      AIFLOW_WORKER_TOKEN: this.options.workerToken,
      ...(api === "v2" ? { OPENCODE_PASSWORD: password } : { OPENCODE_SERVER_PASSWORD: password }),
    };
    const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.options.log?.(`[opencode] ${d.toString().trim()}`));
    child.stderr?.on("data", (d: Buffer) => this.options.log?.(`[opencode] ${d.toString().trim()}`));
    child.on("exit", (code) => {
      this.options.log?.(`opencode-Worker beendet (${code ?? "Signal"})`);
      if (!this.stopped) void this.restart();
    });
    const url = `http://127.0.0.1:${port}`;
    await this.waitHealthy(url, password);
    this.info = { url, password, api, version: detected.version };
    this.options.onReady?.(this.info);
    return this.info;
  }

  private async waitHealthy(url: string, password: string): Promise<void> {
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(url, { headers: { authorization: auth } });
        if (res.status < 500) return;
      } catch {
        /* noch nicht bereit */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new AiflowError("RUNTIME", "opencode-Worker wurde nicht rechtzeitig bereit.");
  }

  private async restart(): Promise<void> {
    this.restarts++;
    const delay = Math.min(30_000, 500 * 2 ** this.restarts);
    await new Promise((r) => setTimeout(r, delay));
    if (!this.stopped) await this.start().catch((e: unknown) => this.options.log?.(`Neustart fehlgeschlagen: ${String(e)}`));
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill("SIGTERM");
  }
}
