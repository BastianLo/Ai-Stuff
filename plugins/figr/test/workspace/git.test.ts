import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffVersion } from "../../src/artifacts/version.ts";
import { runCheck, truncate } from "../../src/workspace/checks.ts";
import { addWorktree, applyPatch, fullDiff, headCommit, removeWorktree, untrackedFiles } from "../../src/workspace/git.ts";
import { git, gitRepo } from "../fake-host.ts";

describe("git", () => {
  it("fullDiff enthält untracked Dateien, ändert den Index nicht und schließt workDir aus", async () => {
    const dir = gitRepo();
    const base = (await headCommit(dir))!;
    writeFileSync(join(dir, "app.js"), "export const x = 2;\n");
    writeFileSync(join(dir, "new.js"), "neu\n");
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "work", "plan.md"), "plan\n");
    const patch = await fullDiff(dir, base, ["work"]);
    expect(patch).toContain("new.js");
    expect(patch).toContain("x = 2");
    expect(patch).not.toContain("plan.md");
    expect(git(dir, "status", "--porcelain")).toContain("?? new.js");
    expect(await untrackedFiles(dir, ["work"])).toEqual(["new.js"]);
  });

  it("diffVersion: leer → undefined, Änderung → neue Version, gleich → gleich", async () => {
    const dir = gitRepo();
    const base = (await headCommit(dir))!;
    const loc = { project: dir, sessionDir: join(dir, ".opencode/figr/s"), workDirRel: ".opencode/figr" };
    expect(await diffVersion(loc, base, [])).toBeUndefined();
    writeFileSync(join(dir, "app.js"), "export const x = 3;\n");
    const v1 = await diffVersion(loc, base, []);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(await diffVersion(loc, base, [])).toBe(v1);
    writeFileSync(join(dir, "dist.js"), "built\n");
    expect(await diffVersion(loc, base, ["dist.js"])).toBe(v1);
    expect(await diffVersion(loc, base, [])).not.toBe(v1);
  });

  it("Worktree, Patch übertragen und zurück anwenden; Konflikt wendet nichts an", async () => {
    const dir = gitRepo();
    const base = (await headCommit(dir))!;
    const wt = join(tmpdir(), `figr-wt-${Date.now()}`);
    await addWorktree(dir, wt, base);
    writeFileSync(join(wt, "app.js"), "export const x = 42;\n");
    writeFileSync(join(wt, "b.js"), "b\n");
    const patch = await fullDiff(wt, base);
    await applyPatch(dir, patch, { threeWay: true });
    expect(readFileSync(join(dir, "app.js"), "utf8")).toContain("42");
    expect(existsSync(join(dir, "b.js"))).toBe(true);
    await removeWorktree(dir, wt);
    expect(existsSync(wt)).toBe(false);

    const other = gitRepo();
    writeFileSync(join(other, "app.js"), "völlig anders\n");
    await expect(applyPatch(other, patch, { threeWay: true })).rejects.toThrow();
    expect(readFileSync(join(other, "app.js"), "utf8")).toBe("völlig anders\n");
    expect(existsSync(join(other, "b.js"))).toBe(false);
  });
});

describe("checks", () => {
  it("Exit-Code, Ausgabe und Zeitlimit", async () => {
    const dir = gitRepo();
    expect(await runCheck("echo ok", dir)).toMatchObject({ ok: true, exitCode: 0 });
    const bad = await runCheck("echo kaputt >&2; exit 3", dir);
    expect(bad).toMatchObject({ ok: false, exitCode: 3 });
    expect(bad.output).toContain("kaputt");
    const slow = await runCheck("sleep 5", dir, { timeoutMs: 200 });
    expect(slow).toMatchObject({ ok: false, timedOut: true });
  });

  it("truncate behält Anfang und Ende", () => {
    const t = truncate(`${"a".repeat(5000)}ENDE`, 1000);
    expect(t.length).toBeLessThan(1100);
    expect(t.endsWith("ENDE")).toBe(true);
    expect(t).toContain("gekürzt");
  });
});
