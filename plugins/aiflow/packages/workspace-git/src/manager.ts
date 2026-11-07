import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { AiflowError, type DiffStat, type FileChange } from "@aiflow/core";
import type { WorkspaceManager, WorkspaceRef } from "@aiflow/engine";
import { git, gitOut } from "./git.js";

interface RunMeta {
  projectDir: string;
}

/** Workspaces als git worktrees außerhalb des Projekts (PLAN.md 7.11). */
export class GitWorkspaceManager implements WorkspaceManager {
  private counter = 0;

  constructor(private readonly dataDir: string) {}

  private runDir(runId: string): string {
    return join(this.dataDir, "worktrees", runId);
  }

  private meta(runId: string): RunMeta {
    const file = join(this.runDir(runId), "meta.json");
    if (!existsSync(file)) throw new AiflowError("WORKSPACE", `Keine Workspace-Daten für Run ${runId}.`);
    return JSON.parse(readFileSync(file, "utf8")) as RunMeta;
  }

  private runIdOf(ref: WorkspaceRef): string {
    const rel = relative(join(this.dataDir, "worktrees"), ref.path).split(sep);
    const runId = rel[0];
    if (!runId || runId === "..") throw new AiflowError("WORKSPACE", `Workspace ${ref.path} gehört zu keinem Run.`);
    return runId;
  }

  async prepare(runId: string, projectDir: string, base: string): Promise<WorkspaceRef> {
    const top = await gitOut(projectDir, ["rev-parse", "--show-toplevel"]).catch(() => {
      throw new AiflowError("WORKSPACE", `„${projectDir}“ ist kein git-Repository. AiFlow braucht git für isolierte Arbeitsverzeichnisse.`);
    });
    mkdirSync(this.runDir(runId), { recursive: true });
    writeFileSync(join(this.runDir(runId), "meta.json"), JSON.stringify({ projectDir: top } satisfies RunMeta));
    const commit = await this.baseCommit(top, base);
    await git(top, ["update-ref", `refs/aiflow/runs/${runId}/base`, commit]);
    const path = join(this.runDir(runId), "main");
    await git(top, ["worktree", "add", "--detach", path, commit]);
    return { id: `${runId}-main`, path, head: commit, base: commit };
  }

  /** Basis-Commit: aktueller Stand inkl. uncommitted/untracked (ohne Index/Arbeitsverzeichnis des Nutzers zu ändern). */
  private async baseCommit(repo: string, base: string): Promise<string> {
    if (base.startsWith("branch:")) return gitOut(repo, ["rev-parse", "--verify", `${base.slice(7)}^{commit}`]);
    const head = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"], { allowFail: true })).stdout.trim();
    if (base === "head") {
      if (!head) throw new AiflowError("WORKSPACE", "Das Repository hat noch keinen Commit.");
      return head;
    }
    const tmp = mkdtempSync(join(tmpdir(), "aiflow-index-"));
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    try {
      if (head) await git(repo, ["read-tree", head], { env });
      await git(repo, ["add", "-A"], { env });
      const tree = await gitOut(repo, ["write-tree"], env);
      return await gitOut(repo, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "aiflow: Basis-Snapshot"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async isolate(runId: string, from: WorkspaceRef, label: string): Promise<WorkspaceRef> {
    const { projectDir } = this.meta(runId);
    const name = `${slug(label)}-${++this.counter}-${Date.now().toString(36)}`;
    const path = join(this.runDir(runId), name);
    await git(projectDir, ["worktree", "add", "--detach", path, from.head]);
    return { id: `${runId}-${name}`, path, head: from.head, base: from.base };
  }

  async scratch(runId: string, label: string): Promise<WorkspaceRef> {
    const path = join(this.runDir(runId), `scratch-${slug(label)}-${++this.counter}`);
    mkdirSync(path, { recursive: true });
    await git(path, ["init", "-q"]);
    await git(path, ["commit", "--allow-empty", "-q", "-m", "aiflow: scratch"]);
    const head = await gitOut(path, ["rev-parse", "HEAD"]);
    return { id: `${runId}-scratch-${this.counter}`, path, head, base: head };
  }

  async checkpoint(ref: WorkspaceRef, message: string): Promise<WorkspaceRef> {
    await git(ref.path, ["add", "-A"]);
    const dirty = (await git(ref.path, ["diff", "--cached", "--quiet", ref.head], { allowFail: true })).code !== 0;
    const current = await gitOut(ref.path, ["rev-parse", "HEAD"]);
    if (!dirty && current === ref.head) return ref;
    if (dirty) await git(ref.path, ["commit", "-q", "--no-verify", "-m", message]);
    const head = await gitOut(ref.path, ["rev-parse", "HEAD"]);
    const runId = this.runIdOf(ref);
    const repo = this.isScratch(ref) ? ref.path : this.meta(runId).projectDir;
    await git(repo, ["update-ref", `refs/aiflow/runs/${runId}/ws/${slug(ref.id)}`, head]);
    return { ...ref, head };
  }

  private isScratch(ref: WorkspaceRef): boolean {
    return ref.id.includes("-scratch-");
  }

  async reset(ref: WorkspaceRef, commit: string): Promise<WorkspaceRef> {
    await git(ref.path, ["reset", "-q", "--hard", commit]);
    await git(ref.path, ["clean", "-fdq"]);
    return { ...ref, head: commit };
  }

  async diffStat(ref: WorkspaceRef, from: string): Promise<DiffStat> {
    await git(ref.path, ["add", "-A"]);
    const out = await gitOut(ref.path, ["diff", "--cached", "--numstat", from]);
    let additions = 0;
    let deletions = 0;
    const lines = out ? out.split("\n") : [];
    for (const line of lines) {
      const [a, d] = line.split("\t");
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
    return { files: lines.length, additions, deletions };
  }

  async changes(ref: WorkspaceRef, from: string, projectDir?: string): Promise<FileChange[]> {
    await git(ref.path, ["add", "-A"]);
    const nameStatus = await gitOut(ref.path, ["diff", "--cached", "--name-status", "--no-renames", from]);
    if (!nameStatus) return [];
    const numstat = new Map<string, [number, number]>();
    for (const line of (await gitOut(ref.path, ["diff", "--cached", "--numstat", "--no-renames", from])).split("\n")) {
      const [a, d, path] = line.split("\t");
      if (path) numstat.set(path, [Number(a) || 0, Number(d) || 0]);
    }
    const userChanged = projectDir ? await this.userChanges(projectDir, ref.base) : new Set<string>();
    const result: FileChange[] = [];
    for (const line of nameStatus.split("\n")) {
      const [code, path] = line.split("\t");
      if (!code || !path) continue;
      const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
      const [additions, deletions] = numstat.get(path) ?? [0, 0];
      const patch = await gitOut(ref.path, ["diff", "--cached", from, "--", path]);
      result.push({ path, status, additions, deletions, patch, ...(userChanged.has(path) ? { conflict: true } : {}) });
    }
    return result;
  }

  /** Dateien, die der Nutzer seit dem Basis-Snapshot im Projekt geändert hat. */
  private async userChanges(projectDir: string, base: string): Promise<Set<string>> {
    const current = await this.baseCommit(projectDir, "working-tree").catch(() => undefined);
    if (!current) return new Set();
    const out = (await git(projectDir, ["diff", "--name-only", base, current], { allowFail: true })).stdout.trim();
    return new Set(out ? out.split("\n") : []);
  }

  async merge(target: WorkspaceRef, sources: WorkspaceRef[], message: string): Promise<{ ref: WorkspaceRef; conflicts: string[] }> {
    let ref = await this.checkpoint(target, message);
    const conflicts = new Set<string>();
    for (const source of sources) {
      if (source.head === ref.head) continue;
      const result = await git(ref.path, ["merge", "--no-ff", "--no-edit", "-m", message, source.head], { allowFail: true });
      if (result.code !== 0) {
        const unmerged = await gitOut(ref.path, ["diff", "--name-only", "--diff-filter=U"]);
        for (const f of unmerged.split("\n").filter(Boolean)) conflicts.add(f);
        // Konfliktmarker bleiben im Commit, damit ein Integrator sie auflösen kann.
        await git(ref.path, ["add", "-A"]);
        await git(ref.path, ["commit", "-q", "--no-verify", "-m", `${message} (mit Konflikten)`]);
      }
      ref = { ...ref, head: await gitOut(ref.path, ["rev-parse", "HEAD"]) };
    }
    return { ref: await this.checkpoint(ref, message), conflicts: [...conflicts] };
  }

  async writeFile(ref: WorkspaceRef, relativePath: string, content: string): Promise<void> {
    const target = resolve(ref.path, normalize(relativePath));
    if (!target.startsWith(resolve(ref.path) + sep)) throw new AiflowError("FORBIDDEN", `Pfad „${relativePath}“ liegt außerhalb des Workspaces.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return Promise.resolve();
  }

  async apply(ref: WorkspaceRef, projectDir: string, files?: string[]): Promise<{ applied: string[]; conflicts: string[] }> {
    const head = await this.checkpoint(ref, "aiflow: Übernahme");
    const changed = (await gitOut(head.path, ["diff", "--name-only", "--no-renames", head.base, head.head])).split("\n").filter(Boolean);
    const selected = files ? changed.filter((f) => files.includes(f)) : changed;
    if (selected.length === 0) return { applied: [], conflicts: [] };
    const patch = (await git(head.path, ["diff", "--binary", "--no-renames", head.base, head.head, "--", ...selected])).stdout;
    const check = await git(projectDir, ["apply", "--check", "--whitespace=nowarn", "-"], { input: patch, allowFail: true });
    if (check.code !== 0) {
      const conflicts = selected.filter((f) => check.stderr.includes(f));
      return { applied: [], conflicts: conflicts.length > 0 ? conflicts : selected };
    }
    await git(projectDir, ["apply", "--whitespace=nowarn", "-"], { input: patch });
    return { applied: selected, conflicts: [] };
  }

  async createBranch(ref: WorkspaceRef, projectDir: string, name: string): Promise<string> {
    const head = await this.checkpoint(ref, "aiflow: Branch");
    const tree = await gitOut(head.path, ["rev-parse", `${head.head}^{tree}`]);
    const parent = await gitOut(projectDir, ["rev-parse", "HEAD"]).catch(() => head.base);
    const commit = await gitOut(projectDir, ["commit-tree", tree, "-p", parent, "-m", `AiFlow: ${name}`]);
    await git(projectDir, ["branch", "-f", name, commit]);
    return name;
  }

  async patch(ref: WorkspaceRef): Promise<string> {
    const head = await this.checkpoint(ref, "aiflow: Patch");
    const content = (await git(head.path, ["diff", "--binary", head.base, head.head])).stdout;
    const file = join(this.dataDir, "patches", `${slug(ref.id)}.patch`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  async cleanup(runId: string): Promise<void> {
    let projectDir: string;
    try {
      projectDir = this.meta(runId).projectDir;
    } catch {
      return;
    }
    const list = await gitOut(projectDir, ["worktree", "list", "--porcelain"]);
    const prefix = this.runDir(runId);
    for (const line of list.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const path = line.slice(9);
      if (path.startsWith(prefix)) await git(projectDir, ["worktree", "remove", "--force", path], { allowFail: true });
    }
    await git(projectDir, ["worktree", "prune"], { allowFail: true });
  }
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return s || createHash("sha1").update(text).digest("hex").slice(0, 8);
}
