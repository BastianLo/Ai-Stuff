import { spawn } from "node:child_process";
import type { ScriptResult, ScriptRunner } from "@aiflow/engine";

const MAX_OUTPUT = 1024 * 1024;

/** Führt Befehle per Shell in einer eigenen Prozessgruppe aus (Timeout und Abbruch beenden die ganze Gruppe). */
export class ProcessScriptRunner implements ScriptRunner {
  run(command: string, options: { cwd: string; timeoutMs: number; env: Record<string, string>; signal: AbortSignal }): Promise<ScriptResult> {
    return new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], { cwd: options.cwd, env: { ...process.env, ...options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let truncated = false;
      const collect = (chunk: Buffer): void => {
        if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
        else truncated = true;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      let reason: string | undefined;
      const kill = (why: string): void => {
        reason = why;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Prozess bereits beendet */
        }
      };
      const timer = setTimeout(() => kill(`Zeitlimit (${options.timeoutMs} ms) überschritten`), options.timeoutMs);
      const onAbort = (): void => kill("abgebrochen");
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        const suffix = `${truncated ? "\n[Ausgabe gekürzt]" : ""}${reason ? `\n[${reason}]` : ""}`;
        resolve({ exitCode: reason ? 124 : (code ?? 1), output: output + suffix });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, output: `${output}\n${error.message}` });
      });
    });
  }
}
