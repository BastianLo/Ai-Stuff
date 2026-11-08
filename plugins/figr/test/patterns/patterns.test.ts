import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeHost, gitRepo, noProgress, signal, testConfigRaw } from "../fake-host.ts";

const pathFrom = (prompt: string): string => /Markdown to: (\S+)/.exec(prompt)?.[1] ?? "";
const dirFrom = (prompt: string): string => /working directory: (\S+)/.exec(prompt)?.[1] ?? "";

async function researched(host: FakeHost): Promise<string> {
  const root = host.root();
  host.behaviors.set("explore", () => undefined);
  const r = await host.subagent(root, "explore");
  expect(r.error).toBeUndefined();
  return root;
}

function approveAll(host: FakeHost, agents: string[]): void {
  for (const a of agents) host.behaviors.set(a, async (c) => { await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "approved", summary: "ok", findings: [] }); });
}

describe("figr_review", () => {
  it("Runde 1 changes_requested, neue Version, Runde 2 passed", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan v1" });
    approveAll(host, ["architect-reviewer"]);
    host.behaviors.set("security-reviewer", async (c) => {
      const ok = readFileSync(join(host.figr.sessionDir(root), "plan.md"), "utf8").includes("Token-Ablauf");
      await c.figr.toolVerdict(c.sessionID, c.agent, ok ? { verdict: "approved", summary: "gut" } : { verdict: "changes_requested", summary: "fehlt", findings: [{ severity: "major", message: "Token-Ablauf fehlt" }] });
    });
    const r1 = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(r1).toContain("Runde 1: changes_requested (1/2 Freigaben)");
    expect(r1).toContain("[major] Token-Ablauf fehlt");
    // gleiche Version erneut: Ergebnis der Runde, kein neuer Fan-out
    const count = host.sessions.size;
    expect(await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress)).toContain("Runde 1");
    expect(host.sessions.size).toBe(count);

    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan v2\nToken-Ablauf: 15 min" });
    const r2 = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(r2).toContain("p2 · Runde 2: passed (2/2 Freigaben)");
    expect(await host.figr.toolStatus(root, "orchestrator")).toMatch(/✔ plan\s+abgenommen · p2/);
  });

  it("Reviewer ohne Urteil: Nachforderungen, dann missing", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });
    approveAll(host, ["architect-reviewer"]);
    host.behaviors.set("security-reviewer", () => undefined);
    const r = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(r).toContain("security-reviewer: kein Urteil (missing)");
    const sec = [...host.sessions.values()].find((s) => s.agent === "security-reviewer")!;
    expect(sec.prompts.length).toBe(3);
    expect(sec.prompts[1]).toContain("figr_verdict");
  });

  it("approved mit Blocker wird zurückgewiesen; Veto blockiert", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });
    approveAll(host, ["architect-reviewer"]);
    const replies: string[] = [];
    host.behaviors.set("security-reviewer", async (c) => {
      replies.push(await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "approved", summary: "x", findings: [{ severity: "blocker", message: "SQL-Injection" }] }).catch((e: unknown) => (e as Error).message));
      if (c.turn === 1) return;
      await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "rejected", summary: "unsicher", findings: [{ severity: "blocker", message: "SQL-Injection" }] });
    });
    const r = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(replies[0]).toContain("Widerspruch");
    expect(r).toContain("rejected (1/2 Freigaben)");
  });

  it("Stagnation eskaliert an den Nutzer; Zustimmung nimmt das Gate ab", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    approveAll(host, ["architect-reviewer"]);
    host.behaviors.set("security-reviewer", async (c) => { await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "changes_requested", summary: "nein", findings: [{ severity: "major", message: "Immer dasselbe" }] }); });
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# v1" });
    await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# v2" });
    host.answer = () => ({ approved: true });
    const r = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(host.asked[0]?.title).toContain("eskaliert");
    expect(host.asked[0]?.detail).toContain("Stagnation");
    expect(r).toContain("trotz offener Befunde freigegeben");
    expect(await host.figr.toolStatus(root, "orchestrator")).toMatch(/✔ plan/);
  });

  it("Checks laufen mit und machen die Runde rot", async () => {
    const raw = testConfigRaw();
    const strict = (raw.profiles as Record<string, { gates: Record<string, { approve?: Record<string, unknown> }> }>).strict!;
    strict.gates.plan!.approve!.checks = ["test -f ok.txt"];
    const dir = gitRepo();
    const host = await FakeHost.create(dir, raw);
    const root = await researched(host);
    approveAll(host, ["architect-reviewer", "security-reviewer"]);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });
    const r = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(r).toContain("changes_requested");
    expect(r).toContain("test -f ok.txt ⨯ Exit 1");
  });

  it("menschliche Freigabe (approve.human)", async () => {
    const raw = testConfigRaw();
    const strict = (raw.profiles as Record<string, { gates: Record<string, { approve?: Record<string, unknown> }> }>).strict!;
    strict.gates.plan!.approve!.human = true;
    const host = await FakeHost.create(gitRepo(), raw);
    const root = await researched(host);
    approveAll(host, ["architect-reviewer", "security-reviewer"]);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });
    host.answer = () => ({ approved: false, feedback: "Bitte noch Monitoring ergänzen" });
    const r = await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    expect(r).toContain("Anweisung des Nutzers: Bitte noch Monitoring ergänzen");
    host.answer = () => ({ approved: true });
    expect(await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress)).toContain("freigegeben");
  });
});

describe("figr_plan", () => {
  it("Multi-Plan: unabhängige Pläne, Synthese, Version p1", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    for (const a of ["planner-a", "planner-b"]) {
      host.behaviors.set(a, async (c) => {
        const path = pathFrom(c.prompt);
        writeFileSync(path, `# Plan von ${a}\n`);
        await c.figr.toolReport(c.sessionID, c.agent, { planPath: path, summary: `Ansatz ${a}`, risks: ["r"], openQuestions: [] });
      });
    }
    host.behaviors.set("plan-synthesizer", async (c) => {
      expect(c.prompt).toContain("planner-a");
      expect(c.prompt).toContain("planner-b");
      const path = pathFrom(c.prompt);
      writeFileSync(path, "# Gemeinsamer Plan\n");
      await c.figr.toolReport(c.sessionID, c.agent, { planPath: path, decisions: [{ topic: "DB", chosen: "Postgres", from: ["planner-a"], reason: "vorhanden" }], conflicts: [] });
    });
    const r = await host.figr.toolPlan(root, "orchestrator", { task: "Passwort-Reset" }, signal(), noProgress);
    expect(r).toContain("2/2 Pläne");
    expect(r).toContain("Version p1");
    expect(r).toContain("DB: Postgres");
    expect(readFileSync(join(host.figr.sessionDir(root), "plan.md"), "utf8")).toBe("# Gemeinsamer Plan\n");
    expect(readdirSync(join(host.figr.sessionDir(root), "plans")).sort()).toEqual(["planner-a.md", "planner-b.md"]);
  });

  it("vor research gesperrt; Report ohne Datei wird abgewiesen", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = host.root();
    await expect(host.figr.toolPlan(root, "orchestrator", { task: "x" }, signal(), noProgress)).rejects.toThrow(/gesperrt/);
    await host.subagent(root, "explore");
    host.behaviors.set("planner-a", async (c) => {
      await expect(c.figr.toolReport(c.sessionID, c.agent, { planPath: "/nicht/da.md", summary: "s" })).rejects.toThrow(/existiert nicht/);
    });
    host.behaviors.set("planner-b", () => undefined);
    await expect(host.figr.toolPlan(root, "orchestrator", { task: "x" }, signal(), noProgress)).rejects.toThrow(/Kein Planer/);
  });

  it("single (Profil quick)", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    expect(await host.figr.command("figr-profile", root, "quick")).toContain("Profil „quick“ aktiv");
    host.behaviors.set("planner", async (c) => {
      const path = pathFrom(c.prompt);
      writeFileSync(path, "# Einzelplan\n");
      await c.figr.toolReport(c.sessionID, c.agent, { planPath: path, summary: "einfach" });
    });
    expect(await host.figr.toolPlan(root, "orchestrator", { task: "x" }, signal(), noProgress)).toContain("FiGr Plan (planner)");
  });
});

describe("figr_best_of_n", () => {
  async function planned(raw = testConfigRaw()) {
    const dir = gitRepo();
    const host = await FakeHost.create(dir, raw);
    const root = await researched(host);
    approveAll(host, ["architect-reviewer", "security-reviewer"]);
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });
    await host.figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress);
    return { dir, host, root };
  }

  it("Kandidaten in Worktrees, Richter wählt, Gewinner wird übernommen, Aufräumen", async () => {
    const { dir, host, root } = await planned();
    writeFileSync(join(dir, "wip.txt"), "ungespeichert\n");
    host.behaviors.set("implementer", async (c) => {
      const wd = dirFrom(c.prompt);
      expect(readFileSync(join(wd, "wip.txt"), "utf8")).toBe("ungespeichert\n");
      const label = /candidate (\w)/.exec(c.prompt)?.[1] ?? "?";
      writeFileSync(join(wd, "app.js"), `export const x = "${label}";\n`);
      await c.figr.toolReport(c.sessionID, c.agent, { summary: `Kandidat ${label}` });
    });
    host.behaviors.set("code-judge", async (c) => {
      expect(c.prompt).toContain("## Candidate A");
      expect(c.prompt).toContain("## Candidate B");
      await c.figr.toolReport(c.sessionID, c.agent, { winner: "b", ranking: ["B", "A"], reasons: "B ist besser" });
    });
    const r = await host.figr.toolBestOfN(root, "orchestrator", { task: "x ändern" }, signal(), noProgress);
    expect(r).toContain("Gewinner B");
    expect(readFileSync(join(dir, "app.js"), "utf8")).toBe('export const x = "B";\n');
    expect(existsSync(join(host.figr.sessionDir(root), "candidates", "A.patch"))).toBe(true);
    const leftovers = join(tmpdir(), "figr", root);
    expect(existsSync(leftovers) ? readdirSync(leftovers) : []).toEqual([]);
    expect(await host.figr.toolStatus(root, "orchestrator")).toMatch(/▶ implementation\s+im Review · i1/);
  });

  it("roter Gewinner bei grünen Alternativen wird zurückgewiesen", async () => {
    const raw = testConfigRaw();
    const strict = (raw.profiles as Record<string, { gates: Record<string, { produce?: Record<string, unknown> }> }>).strict!;
    strict.gates.implementation!.produce!.checks = ["test -f ok.txt"];
    const { dir, host, root } = await planned(raw);
    host.behaviors.set("implementer", async (c) => {
      const wd = dirFrom(c.prompt);
      const label = /candidate (\w)/.exec(c.prompt)?.[1] ?? "?";
      writeFileSync(join(wd, "app.js"), `export const x = "${label}";\n`);
      if (label === "A") writeFileSync(join(wd, "ok.txt"), "ok\n");
      await c.figr.toolReport(c.sessionID, c.agent, { summary: label });
    });
    const answers: string[] = [];
    host.behaviors.set("code-judge", async (c) => {
      const winner = c.turn === 1 ? "B" : "A";
      answers.push(await c.figr.toolReport(c.sessionID, c.agent, { winner, ranking: [winner], reasons: "r" }).catch((e: unknown) => (e as Error).message));
    });
    const r = await host.figr.toolBestOfN(root, "orchestrator", { task: "x" }, signal(), noProgress);
    expect(answers[0]).toContain("rote Checks");
    expect(r).toContain("Gewinner A");
    expect(readFileSync(join(dir, "ok.txt"), "utf8")).toBe("ok\n");
  });

  it("vor Plan-Abnahme gesperrt", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = await researched(host);
    await expect(host.figr.toolBestOfN(root, "orchestrator", { task: "x" }, signal(), noProgress)).rejects.toThrow(/gesperrt/);
  });
});
