import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { FigrError } from "../util/errors.ts";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const IDENTITY = ["-c", "user.name=FiGr", "-c", "user.email=figr@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

/** Führt git aus (execFile, Timeout). Wirft bei Exit-Code ≠ 0, außer `allowFail`. Aus AiFlow übernommen. */
export function git(cwd: string, args: readonly string[], opts: { input?: string; allowFail?: boolean; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...IDENTITY, ...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 128 * 1024 * 1024, encoding: "utf8", timeout: opts.timeoutMs ?? 120_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (code !== 0 && !opts.allowFail) {
          reject(new FigrError(`git ${args.join(" ")} fehlgeschlagen (${code}): ${stderr.trim() || stdout.trim()}`));
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function gitOut(cwd: string, args: readonly string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })).stdout.trim() === "true";
}

export async function headCommit(dir: string): Promise<string | undefined> {
  const r = await git(dir, ["rev-parse", "HEAD"], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** Pfadspezifikationen, die Verzeichnisse ausschließen (z. B. workDir). */
export function excludeSpecs(paths: readonly string[]): string[] {
  return paths
    .filter((p) => p.length > 0)
    .flatMap((p) => {
      const clean = p.replace(/\/+$/, "");
      // Muster gilt für die Datei bzw. das Verzeichnis selbst und alles darunter.
      return [`:(exclude,glob)${clean}`, `:(exclude,glob)${clean}/**`];
    });
}

/** Binärer Diff des Arbeitsstands (inkl. Index) gegen `base`, ohne untracked Dateien. */
export async function workingDiff(dir: string, base: string, exclude: readonly string[] = []): Promise<string> {
  return (await git(dir, ["diff", "--binary", "--no-color", "--no-ext-diff", base, "--", ".", ...excludeSpecs(exclude)])).stdout;
}

/** Untracked Dateien (respektiert .gitignore). */
export async function untrackedFiles(dir: string, exclude: readonly string[] = []): Promise<string[]> {
  const out = await git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...excludeSpecs(exclude)]);
  return out.stdout.split("\0").filter((f) => f.length > 0).sort();
}

/** Diff inkl. untracked Dateien als ein Patch (`git add -N` in temporärem Index, Arbeitsbaum bleibt unverändert). */
export async function fullDiff(dir: string, base: string, exclude: readonly string[] = []): Promise<string> {
  const untracked = await untrackedFiles(dir, exclude);
  if (untracked.length === 0) return workingDiff(dir, base, exclude);
  const indexFile = (await gitOut(dir, ["rev-parse", "--git-path", "index"])).trim();
  const tmp = mkdtempSync(join(tmpdir(), "figr-idx-"));
  const tmpIndex = join(tmp, "index");
  const src = isAbsolute(indexFile) ? indexFile : join(dir, indexFile);
  if (existsSync(src)) copyFileSync(src, tmpIndex);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex, GIT_TERMINAL_PROMPT: "0" };
    await new Promise<void>((resolve, reject) => {
      execFile("git", [...IDENTITY, "add", "-N", "--", ...untracked], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 }, (e) => (e ? reject(new FigrError(`git add -N fehlgeschlagen: ${e.message}`)) : resolve()));
    });
    return await new Promise<string>((resolve, reject) => {
      execFile("git", [...IDENTITY, "diff", "--binary", "--no-color", "--no-ext-diff", base, "--", ".", ...excludeSpecs(exclude)], { cwd: dir, env, maxBuffer: 128 * 1024 * 1024, encoding: "utf8" }, (e, stdout) =>
        e ? reject(new FigrError(`git diff fehlgeschlagen: ${e.message}`)) : resolve(stdout),
      );
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function diffStat(dir: string, base: string, exclude: readonly string[] = []): Promise<string> {
  const tracked = (await git(dir, ["diff", "--stat", "--no-color", base, "--", ".", ...excludeSpecs(exclude)])).stdout.trim();
  const untracked = await untrackedFiles(dir, exclude);
  return [tracked, ...untracked.map((f) => ` ${f} (neu)`)].filter(Boolean).join("\n");
}

/**
 * Wendet einen Patch an, ohne halb anzuwenden: zuerst `--check`. Mit `threeWay` wird bei Konflikten
 * `--3way` versucht (setzt dann auch den Index); bleiben Konflikte, wird nichts übernommen.
 */
export async function applyPatch(dir: string, patch: string, opts: { threeWay?: boolean } = {}): Promise<void> {
  if (patch.trim().length === 0) return;
  const plain = await git(dir, ["apply", "--check", "--binary", "-"], { input: patch, allowFail: true });
  if (plain.code === 0) {
    await git(dir, ["apply", "--binary", "-"], { input: patch });
    return;
  }
  if (opts.threeWay) {
    const three = await git(dir, ["apply", "--check", "--3way", "--binary", "-"], { input: patch, allowFail: true });
    if (three.code === 0 && !/conflict/i.test(three.stderr)) {
      await git(dir, ["apply", "--3way", "--binary", "-"], { input: patch });
      return;
    }
    throw new FigrError(`Patch kollidiert mit dem Arbeitsstand: ${three.stderr.trim() || plain.stderr.trim()}`);
  }
  throw new FigrError(`Patch lässt sich nicht sauber anwenden: ${plain.stderr.trim() || plain.stdout.trim()}`);
}

export async function addWorktree(repo: string, path: string, commit: string): Promise<void> {
  await git(repo, ["worktree", "add", "--detach", path, commit]);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", path], { allowFail: true });
  await git(repo, ["worktree", "prune"], { allowFail: true });
}
