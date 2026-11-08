import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config/load.ts";
import { Figr } from "../src/figr.ts";
import { readStatus } from "../src/tui/status-file.ts";
import { FakeHost, gitRepo, noProgress, signal, testConfigRaw } from "./fake-host.ts";

describe("Szenario 5.2: Orchestrator versucht abzukürzen", () => {
  it("blockiert, lenkt und lässt das Ende erst nach allen Gates zu", async () => {
    const dir = gitRepo();
    const host = await FakeHost.create(dir);
    const figr = host.figr;
    const root = host.root();

    // Selbst editieren → abgelehnt (beide Wege)
    await expect(figr.beforeTool(root, "orchestrator", "edit", { filePath: "app.js" })).rejects.toThrow(/Der Orchestrator ändert keine Dateien/);
    expect((await figr.evaluatePermission(root, "orchestrator", "edit", ["app.js"])).deny).toContain("ändert keine Dateien");
    expect((await figr.evaluatePermission(root, "orchestrator", "shell", ["sed -i s/1/2/ app.js"])).deny).toContain("Shell-Befehl");
    expect((await figr.evaluatePermission(root, "orchestrator", "shell", ["git status"])).deny).toBeUndefined();

    // Implementer vor dem Plan → abgelehnt mit nächstem Schritt
    const early = await host.subagent(root, "implementer");
    expect(early.error).toContain("„implementer“ gehört zu Gate „implementation“");

    // Zu früh „fertig“ → Stop-Guard schickt nach (max. 2×), dann Nutzerfrage
    const n1 = await figr.idle(root, []);
    expect(n1).toContain("Noch nicht fertig");
    expect(n1).toContain("research");
    expect(await figr.idle(root, [])).toContain("Noch nicht fertig");
    host.answer = () => ({ approved: false, feedback: "Mach weiter mit dem Plan" });
    expect(await figr.idle(root, [])).toContain("Anweisung des Nutzers: Mach weiter mit dem Plan");
    expect(await figr.idle(root, [])).toBeUndefined();
    // Neue Nutzernachricht setzt den Zähler zurück; FiGr-eigene Nachrichten nicht
    await figr.onUserPrompt(root, "FiGr: Noch nicht fertig …");
    expect(await figr.idle(root, [])).toBeUndefined();
    await figr.onUserPrompt(root, "Weiter bitte");
    expect(await figr.idle(root, [])).toContain("Noch nicht fertig");
    // Frage an den Nutzer → kein Nachschicken; laufende Hintergrund-Sub-Agenten auch nicht
    host.lastAssistant = { text: "Soll ich Variante A oder B nehmen?", tools: [] };
    expect(await figr.idle(root, [])).toBeUndefined();
    host.lastAssistant = undefined;
    expect(await figr.idle(root, [{ kind: "subagent", sessionID: root }])).toBeUndefined();

    // Recherche (Nachweis), dann Plan per figr_submit
    await host.subagent(root, "explore");
    await figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });

    // Reviewer direkt über subagent: Prompt wird angereichert, Urteil zählt
    host.behaviors.set("architect-reviewer", async (c) => {
      expect(c.prompt).toContain('reviewing gate "plan", version p1');
      await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "approved", summary: "ok" });
    });
    const direct = await host.subagent(root, "architect-reviewer", "Prüfe den Plan");
    expect(direct.prompt).toContain("figr_verdict");
    const ctx = await figr.context(direct.sessionID!, "architect-reviewer");
    expect(ctx.visible).toEqual(["figr_verdict"]);
    expect(ctx.system).toContain('You review gate "plan"');
    // Reviewer darf nicht editieren
    expect((await figr.evaluatePermission(direct.sessionID!, "architect-reviewer", "edit", ["x"])).deny).toBeDefined();
    // noch 1/2 → Implementer weiter gesperrt
    expect((await host.subagent(root, "implementer")).error).toContain("(1/2 Freigaben)");

    host.behaviors.set("security-reviewer", async (c) => { await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "approved", summary: "ok" }); });
    expect(await figr.toolReview(root, "orchestrator", { gate: "plan" }, signal(), noProgress)).toContain("passed (2/2 Freigaben)");

    // Implementer jetzt erlaubt; er ändert Code
    host.behaviors.set("implementer", () => writeFileSync(join(dir, "app.js"), "export const x = 99;\n"));
    expect((await host.subagent(root, "implementer")).error).toBeUndefined();
    await figr.afterTool(root, "orchestrator", "edit", {}, true, "");
    expect(await figr.idle(root, [])).toContain("implementation");

    // Implementierungs-Review, dann darf die Session enden
    host.behaviors.set("standards-reviewer", async (c) => { await c.figr.toolVerdict(c.sessionID, c.agent, { verdict: "approved", summary: "sauber" }); });
    expect(await figr.toolReview(root, "orchestrator", { gate: "implementation" }, signal(), noProgress)).toContain("passed");
    expect(await figr.idle(root, [])).toBeUndefined();
    const status = await figr.toolStatus(root, "orchestrator");
    expect(status).toContain("Alle nötigen Gates sind erfüllt");

    // Plan ändert sich nachträglich → Freigabe verfällt, implementation wieder gesperrt
    await figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan geändert" });
    const after = await figr.toolStatus(root, "orchestrator");
    expect(after).toMatch(/▶ plan\s+im Review · p2/);
    expect(after).toMatch(/○ implementation\s+gesperrt/);
  });

  it("nicht geführte Sessions und fremde Tools bleiben unberührt", async () => {
    const host = await FakeHost.create(gitRepo());
    const other = host.root("build");
    expect(await host.figr.beforeTool(other, "build", "edit", {})).toEqual({});
    expect(await host.figr.evaluatePermission(other, "build", "edit", ["x"])).toEqual({});
    expect((await host.figr.context(other, "build")).visible).toEqual([]);
    const root = host.root();
    expect(await host.figr.beforeTool(root, "orchestrator", "skill_search", { q: "x" })).toEqual({});
    expect((await host.figr.context(root, "orchestrator")).visible).toContain("figr_status");
  });
});

describe("Befehle, Persistenz, Statusdatei", () => {
  it("/figr off|on, -skip mit Bestätigung, -reset, -findings", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = host.root();
    await host.figr.context(root, "orchestrator");
    expect(await host.figr.command("figr", root, "off")).toContain("aus");
    expect(await host.figr.beforeTool(root, "orchestrator", "edit", {})).toEqual({});
    expect(await host.figr.command("figr", root, "on")).toContain("an");
    await expect(host.figr.beforeTool(root, "orchestrator", "edit", {})).rejects.toThrow();

    host.answer = () => ({ approved: false });
    expect(await host.figr.command("figr-skip", root, "research")).toContain("nicht übersprungen");
    host.answer = () => ({ approved: true });
    expect(await host.figr.command("figr-skip", root, "research")).toContain("übersprungen");
    expect(await host.figr.command("figr", root, "")).toMatch(/⏭ research/);
    expect(await host.figr.command("figr-reset", root, "research")).toContain("zurückgesetzt");
    expect(await host.figr.command("figr-findings", root, "")).toBe("Keine offenen Befunde.");
    expect(await host.figr.command("figr-skip", root, "gibtsnicht")).toContain("Gate angeben");

    // /figr on in einer beliebigen Session
    const other = host.root("build");
    expect(await host.figr.command("figr", other, "on")).toContain("an");
    await expect(host.figr.beforeTool(other, "build", "edit", {})).rejects.toThrow();
  });

  it("Zustand übersteht einen Neustart; laufende Runden gelten als unterbrochen", async () => {
    const dir = gitRepo();
    const host = await FakeHost.create(dir);
    const root = host.root();
    await host.subagent(root, "explore");
    await host.figr.toolSubmit(root, "orchestrator", { gate: "plan", text: "# Plan" });
    const state = (await host.figr.resolve(root, "orchestrator"))!.state;
    host.figr.ensureRound(state, "plan", (await host.figr.views(state)).find((v) => v.name === "plan")!.version!);
    host.figr.startFanout(state, "review", "plan", []);
    await host.figr.store.flush();

    const fresh = new Figr(host.ports, { inlineConfig: resolveConfig(testConfigRaw()), watch: false });
    await fresh.start();
    host.figr = fresh;
    const status = await fresh.toolStatus(root, "orchestrator");
    expect(status).toMatch(/✔ research/);
    expect(status).toContain("Review-Runde unterbrochen");
  });

  it("schreibt status.json für die TUI", async () => {
    const host = await FakeHost.create(gitRepo());
    const root = host.root();
    const state = (await host.figr.resolve(root, "orchestrator"))!.state;
    await host.figr.writeStatusNow(state);
    const snap = readStatus(host.figr.workDirAbs, root);
    expect(snap?.profile).toBe("strict");
    expect(snap?.gates.map((g) => g.name)).toEqual(["research", "plan", "implementation", "done"]);
    expect(snap?.compact).toMatch(/^FiGr:/);
  });

  it("ungültige Konfiguration: FiGr inaktiv mit Hinweis", async () => {
    const dir = gitRepo();
    const host = new FakeHost(dir);
    host.figr = new Figr(host.ports, { watch: false, global: false });
    await host.figr.start();
    expect(host.figr.configProblem).toContain("Keine figr.jsonc");
    const root = host.root();
    expect(await host.figr.beforeTool(root, "orchestrator", "edit", {})).toEqual({});
    expect(await host.figr.command("figr", root, "")).toContain("inaktiv");
  });
});
