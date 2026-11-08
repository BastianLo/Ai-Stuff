import { spawn } from "node:child_process";
import type { CheckResult } from "../core/types.ts";
import { mapLimit } from "../util/semaphore.ts";

export const MAX_CHECK_OUTPUT = 4 * 1024;

/** Kürzt Ausgaben: Anfang und Ende bleiben erhalten (Fehler stehen meist am Ende). */
export function truncate(text: string, max = MAX_CHECK_OUTPUT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head - 40;
  return `${text.slice(0, head)}\n… [${text.length - head - tail} Zeichen gekürzt] …\n${text.slice(-tail)}`;
}

/** Führt einen Prüfbefehl über die Shell aus (Timeout, Ausgabe gekürzt). Die volle Ausgabe geht an `onFull`. */
export function runCheck(command: string, cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal; onFull?: (output: string) => void } = {}): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    const append = (d: Buffer): void => {
      if (output.length < 8 * 1024 * 1024) output += d.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const kill = (): void => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Prozess bereits beendet.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 600_000);
    const onAbort = (): void => kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      opts.onFull?.(output);
      resolve({ command, ok: code === 0 && !timedOut, exitCode: code, output: truncate(output), durationMs: Date.now() - started, timedOut });
    };
    child.on("error", (e) => {
      output += String(e);
      done(127);
    });
    child.on("close", (code) => done(code));
  });
}

export function runChecks(commands: readonly string[], cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal; parallel?: boolean; onFull?: (command: string, output: string) => void } = {}): Promise<CheckResult[]> {
  return mapLimit(commands, opts.parallel ? commands.length : 1, (c) =>
    runCheck(c, cwd, { ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.signal ? { signal: opts.signal } : {}), onFull: (o) => opts.onFull?.(c, o) }),
  );
}
