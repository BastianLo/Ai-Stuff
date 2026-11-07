import { execFile } from "node:child_process";
import { AiflowError } from "@aiflow/core";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const IDENTITY = ["-c", "user.name=AiFlow", "-c", "user.email=aiflow@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** Führt git aus. Wirft bei Exit-Code ≠ 0, außer `allowFail` ist gesetzt. */
export function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...IDENTITY, ...args],
      { cwd, env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (code !== 0 && !opts.allowFail) {
          reject(new AiflowError("WORKSPACE", `git ${args.join(" ")} fehlgeschlagen (${code}): ${stderr.trim() || stdout.trim()}`));
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function gitOut(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  return (await git(cwd, args, env ? { env } : {})).stdout.trim();
}
