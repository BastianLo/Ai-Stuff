import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sequentialIds } from "@aiflow/core";
import { Engine } from "@aiflow/engine";
import { FsDocumentStore, SqliteStore } from "@aiflow/store";
import { diskIo, FakeRuntime, loadDefinitions, examplesDir } from "@aiflow/testkit";
import { GitWorkspaceManager, ProcessScriptRunner } from "@aiflow/workspace-git";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiflow-repo-"));
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd: dir });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  // uncommitted + untracked Änderungen des Nutzers
  writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
  writeFileSync(join(dir, "notes.md"), "Notiz\n");
  return dir;
}

const status = (dir: string) => execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });

describe("GitWorkspaceManager", () => {
  it("übernimmt uncommitted und untracked Stand, ohne das Projekt anzufassen", async () => {
    const project = repo();
    const before = status(project);
    const ws = new GitWorkspaceManager(mkdtempSync(join(tmpdir(), "aiflow-data-")));
    const ref = await ws.prepare("run1", project, "working-tree");
    expect(readFileSync(join(ref.path, "app.ts"), "utf8")).toContain("a = 2");
    expect(readFileSync(join(ref.path, "notes.md"), "utf8")).toBe("Notiz\n");
    expect(status(project)).toBe(before);
    expect(execFileSync("git", ["for-each-ref", "refs/aiflow"], { cwd: project, encoding: "utf8" })).toContain("refs/aiflow/runs/run1/base");
    expect(execFileSync("git", ["branch"], { cwd: project, encoding: "utf8" })).not.toContain("aiflow");
  });

  it("checkpointet, berechnet Änderungen, setzt zurück und isoliert", async () => {
    const project = repo();
    const ws = new GitWorkspaceManager(mkdtempSync(join(tmpdir(), "aiflow-data-")));
    let ref = await ws.prepare("run2", project, "working-tree");
    writeFileSync(join(ref.path, "feature.ts"), "export const f = () => 1;\n");
    expect(await ws.diffStat(ref, ref.base)).toEqual({ files: 1, additions: 1, deletions: 0 });
    ref = await ws.checkpoint(ref, "Schritt 1");
    expect(ref.head).not.toBe(ref.base);
    const changes = await ws.changes(ref, ref.base);
    expect(changes).toMatchObject([{ path: "feature.ts", status: "added", additions: 1 }]);
    expect(changes[0]?.patch).toContain("+export const f");
    const iso = await ws.isolate("run2", ref, "Implementer B");
    expect(existsSync(join(iso.path, "feature.ts"))).toBe(true);
    writeFileSync(join(ref.path, "oops.ts"), "x");
    ref = await ws.reset(ref, ref.head);
    expect(existsSync(join(ref.path, "oops.ts"))).toBe(false);
  });

  it("führt Zweige zusammen und meldet Konflikte mit Markern", async () => {
    const project = repo();
    const ws = new GitWorkspaceManager(mkdtempSync(join(tmpdir(), "aiflow-data-")));
    const base = await ws.prepare("run3", project, "working-tree");
    let a = await ws.isolate("run3", base, "a");
    let b = await ws.isolate("run3", base, "b");
    let c = await ws.isolate("run3", base, "c");
    writeFileSync(join(a.path, "a.ts"), "A\n");
    writeFileSync(join(b.path, "b.ts"), "B\n");
    writeFileSync(join(c.path, "a.ts"), "C\n");
    a = await ws.checkpoint(a, "a");
    b = await ws.checkpoint(b, "b");
    c = await ws.checkpoint(c, "c");
    const ok = await ws.merge(base, [a, b], "merge ab");
    expect(ok.conflicts).toEqual([]);
    expect(readFileSync(join(ok.ref.path, "b.ts"), "utf8")).toBe("B\n");
    const bad = await ws.merge(ok.ref, [c], "merge c");
    expect(bad.conflicts).toEqual(["a.ts"]);
    expect(readFileSync(join(bad.ref.path, "a.ts"), "utf8")).toContain("<<<<<<<");
  });

  it("übernimmt Änderungen ins Projekt, legt Branches und Patches an", async () => {
    const project = repo();
    const ws = new GitWorkspaceManager(mkdtempSync(join(tmpdir(), "aiflow-data-")));
    let ref = await ws.prepare("run4", project, "working-tree");
    writeFileSync(join(ref.path, "x.ts"), "x\n");
    writeFileSync(join(ref.path, "y.ts"), "y\n");
    ref = await ws.checkpoint(ref, "s");
    const partial = await ws.apply(ref, project, ["x.ts"]);
    expect(partial).toEqual({ applied: ["x.ts"], conflicts: [] });
    expect(existsSync(join(project, "y.ts"))).toBe(false);
    const branch = await ws.createBranch(ref, project, "aiflow/test");
    expect(execFileSync("git", ["show", "--stat", "--format=%s", branch], { cwd: project, encoding: "utf8" })).toContain("y.ts");
    expect(readFileSync(await ws.patch(ref), "utf8")).toContain("+y");
    await ws.cleanup("run4");
    expect(existsSync(ref.path)).toBe(false);
  });

  it("erkennt Konflikte mit Änderungen des Nutzers", async () => {
    const project = repo();
    const ws = new GitWorkspaceManager(mkdtempSync(join(tmpdir(), "aiflow-data-")));
    let ref = await ws.prepare("run5", project, "working-tree");
    writeFileSync(join(ref.path, "app.ts"), "export const a = 3;\n");
    ref = await ws.checkpoint(ref, "s");
    writeFileSync(join(project, "app.ts"), "export const a = 99;\n");
    expect((await ws.changes(ref, ref.base, project))[0]?.conflict).toBe(true);
    const result = await ws.apply(ref, project);
    expect(result.conflicts).toEqual(["app.ts"]);
  });

  it("verweigert Nicht-git-Verzeichnisse mit klarer Meldung", async () => {
    const ws = new GitWorkspaceManager(mkdtempSync(join(tmpdir(), "aiflow-data-")));
    await expect(ws.prepare("r", mkdtempSync(join(tmpdir(), "plain-")), "working-tree")).rejects.toThrow(/kein git-Repository/);
  });
});

describe("ProcessScriptRunner", () => {
  it("liefert Exit-Code und Ausgabe, beendet bei Zeitlimit", async () => {
    const runner = new ProcessScriptRunner();
    const signal = new AbortController().signal;
    expect(await runner.run("echo hallo; exit 3", { cwd: tmpdir(), timeoutMs: 5000, env: {}, signal })).toMatchObject({ exitCode: 3, output: "hallo\n" });
    const slow = await runner.run("sleep 5", { cwd: tmpdir(), timeoutMs: 100, env: {}, signal });
    expect(slow.exitCode).toBe(124);
    expect(slow.output).toContain("Zeitlimit");
  });
});

describe("Integration: Engine mit git, Dateisystem und echten Skripten", () => {
  it("führt Feature mit Multi-Review auf einem echten Repository aus und übernimmt das Ergebnis", async () => {
    const project = repo();
    mkdirSync(join(project, "src"));
    const data = mkdtempSync(join(tmpdir(), "aiflow-data-"));
    const defs = loadDefinitions(examplesDir);
    const workflow = { ...defs.workflows["feature-review"]!, variables: { checkCommand: "test -f src/reset.ts" } };
    const store = new SqliteStore(join(data, "aiflow.db"));
    const runtime = new FakeRuntime(
      {
        plan: { docs: { "plan.md": "# Plan" } },
        implement: { writes: { "src/reset.ts": "export const reset = () => true;\n" } },
        security: { output: { approved: true, findings: [] } },
        standards: { output: { approved: true, findings: [] } },
        tests: { output: { approved: true, findings: [] } },
        document: { writes: { "docs/reset.md": "# Reset\n" } },
      },
      diskIo,
    );
    const engine = new Engine({
      runtime,
      workspace: new GitWorkspaceManager(data),
      scripts: new ProcessScriptRunner(),
      documents: new FsDocumentStore(data),
      sink: store,
      clock: { now: () => Date.now() },
      ids: sequentialIds(),
    });
    const id = engine.start({ workflow, version: "t", agents: defs.agents, snippets: defs.snippets, workflows: defs.workflows, input: { prompt: "Reset" }, projectDir: project, origin: "api" });
    const state = await engine.wait(id);
    expect(state.error).toBeUndefined();
    expect(state.status).toBe("review_pending");
    expect(state.review?.files.map((f) => f.path).sort()).toEqual(expect.arrayContaining(["docs/reset.md", "src/reset.ts"]));
    expect(existsSync(join(project, "src/reset.ts"))).toBe(false);
    await engine.decideReview(id, { action: "apply" });
    expect(readFileSync(join(project, "src/reset.ts"), "utf8")).toContain("reset");
    expect(store.getState(id)?.status).toBe("completed");
    expect(store.events(id).length).toBeGreaterThan(20);
  });
});
