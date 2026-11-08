import { describe, expect, it } from "vitest";
import { workflowSchema, type WorkflowInput } from "@aiflow/core";
import { createHarness, loadDefinitions, examplesDir, sleep, type FakeEntry } from "@aiflow/testkit";

const defs = loadDefinitions(examplesDir);
const approve = { output: { approved: true, findings: [] } };
const reject = { output: { approved: false, findings: [{ severity: "high", file: "src/auth.ts", line: 12, message: "Token wird geloggt" }] } };

const featureReviewHappy: Record<string, FakeEntry> = {
  plan: { docs: { "plan.md": "# Plan\n- Endpunkt\n- Mail" }, output: { tasks: ["Endpunkt", "Mail"] } },
  implement: { writes: { "src/reset.ts": "export const reset = () => true;\n" } },
  security: approve,
  standards: approve,
  tests: approve,
  document: { writes: { "docs/reset.md": "# Passwort-Reset\n" } },
};

function custom(input: Omit<WorkflowInput, "id" | "name">) {
  const workflow = workflowSchema.parse({ id: "custom", name: "Custom", ...input });
  return { ...defs, workflows: { ...defs.workflows, custom: workflow } };
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("Feature mit Multi-Review", () => {
  it("läuft den glücklichen Pfad bis zum Review und übernimmt danach", async () => {
    const h = createHarness({ script: featureReviewHappy });
    const { id, state, events } = await h.run("feature-review", "Passwort-Reset per E-Mail");
    expect(state.status).toBe("review_pending");
    expect(state.outcome).toBe("success");
    const files = state.review?.files.map((f) => f.path) ?? [];
    expect(files).toEqual(expect.arrayContaining(["src/reset.ts", "docs/reset.md"]));
    expect(files.some((f) => f.startsWith("docs/plans/"))).toBe(true);
    expect(types(events)).toEqual(expect.arrayContaining(["token.forked", "token.joined", "run.review_pending"]));
    // Prompt enthält Auftrag, Dokumente und Übergabe-Anweisung
    const implementPrompt = h.runtime.callsFor("implement")[0]?.prompt ?? "";
    expect(implementPrompt).toContain("Passwort-Reset per E-Mail");
    expect(implementPrompt).toContain("plan.md · lesen");
    expect(implementPrompt).toContain("alle Details stehen in plan.md");
    await h.engine.decideReview(id, { action: "apply" });
    expect(h.engine.get(id)?.status).toBe("completed");
    expect(h.workspace.project.get("/project")?.get("src/reset.ts")).toContain("reset");
  });

  it("wiederholt die Umsetzung, wenn Checks fehlschlagen, mit der Skript-Ausgabe als Feedback", async () => {
    const h = createHarness({ script: featureReviewHappy, scripts: (_c, _cwd, call) => (call <= 2 ? { exitCode: 1, output: `FAIL test ${call}` } : { exitCode: 0, output: "ok" }) });
    const { state, events } = await h.run("feature-review");
    expect(state.status).toBe("review_pending");
    expect(h.runtime.callsFor("implement")).toHaveLength(3);
    expect(h.runtime.callsFor("implement")[1]?.prompt).toContain("FAIL test 1");
    expect(h.runtime.callsFor("implement")[1]?.prompt).toContain("Durchlauf 2 von max. 4");
    expect(events.filter((e) => e.type === "loop.iteration")).toHaveLength(2);
  });

  it("sammelt Befunde bei Veto und schickt sie zurück an die Umsetzung", async () => {
    const h = createHarness({ script: { ...featureReviewHappy, security: [reject, approve] } });
    const { state } = await h.run("feature-review");
    expect(state.status).toBe("review_pending");
    const second = h.runtime.callsFor("implement")[1]?.prompt ?? "";
    expect(second).toContain("Token wird geloggt");
    expect(second).toContain("src/auth.ts:12");
    expect(h.runtime.callsFor("security")).toHaveLength(2);
  });

  it("eskaliert nach dem Schleifenlimit an den Menschen und bricht auf Wunsch ab", async () => {
    const h = createHarness({ script: featureReviewHappy, scripts: (_c, _w, call) => ({ exitCode: 1, output: `rot ${call}` }) });
    const id = h.engine.start(h.spec("feature-review"));
    const waiting = await h.engine.wait(id, ["waiting_input"]);
    const item = waiting.inbox.find((i) => i.kind === "human");
    expect(item?.options).toEqual(["weiter-versuchen", "so-uebernehmen", "abbrechen"]);
    expect(item?.question).toContain("4 Durchläufen");
    expect(h.sink.ofRun(id).some((e) => e.type === "loop.limit_reached")).toBe(true);
    h.engine.answer(id, item!.id, "abbrechen");
    const done = await h.engine.wait(id);
    expect(done.status).toBe("cancelled");
    expect(done.outcome).toBe("cancelled");
  });

  it("eskaliert früher, wenn das Feedback stagniert", async () => {
    const h = createHarness({ script: featureReviewHappy, scripts: () => ({ exitCode: 1, output: "FAIL: immer derselbe Test" }) });
    const id = h.engine.start(h.spec("feature-review"));
    await h.engine.wait(id, ["waiting_input"]);
    expect(h.runtime.callsFor("implement")).toHaveLength(2);
    expect(h.sink.ofRun(id).find((e) => e.type === "loop.limit_reached")?.data.reason).toBe("stagnation");
    h.engine.cancel(id);
  });

  it("setzt Schleifenzähler zurück, wenn der Mensch weiter versuchen lässt", async () => {
    let calls = 0;
    const h = createHarness({ script: featureReviewHappy, scripts: () => ({ exitCode: ++calls <= 4 ? 1 : 0, output: `x ${calls}` }) });
    const id = h.engine.start(h.spec("feature-review"));
    const waiting = await h.engine.wait(id, ["waiting_input"]);
    h.engine.answer(id, waiting.inbox[0]!.id, "weiter-versuchen", "Bitte nochmal mit Fokus auf die Tests");
    const done = await h.engine.wait(id);
    expect(done.status).toBe("review_pending");
    expect(h.runtime.callsFor("implement").at(-1)?.prompt).toContain("Bitte nochmal mit Fokus auf die Tests");
  });

  it("schlägt fehl, wenn ein Pflichtdokument nicht geschrieben wird", async () => {
    const h = createHarness({ script: { ...featureReviewHappy, plan: { output: { tasks: [] } } } });
    const { state, events } = await h.run("feature-review");
    expect(state.status).toBe("failed");
    expect(state.error).toContain("Pflichtdokument „plan.md“");
    expect(events.some((e) => e.type === "step.retry")).toBe(true);
  });

  it("setzt unerlaubte Dokumentänderungen und Schreibzugriffe im Nur-lesen-Workspace zurück", async () => {
    const h = createHarness({
      script: {
        ...featureReviewHappy,
        implement: { writes: { "src/reset.ts": "x" }, docs: { "plan.md": "überschrieben!" } },
        security: { ...approve, writes: { "src/hack.ts": "böse" } },
      },
    });
    const { id, state, events } = await h.run("feature-review");
    expect(state.status).toBe("review_pending");
    expect(await h.documents.read(id, "plan.md")).toContain("# Plan");
    const violations = events.filter((e) => e.type === "step.violation").map((e) => e.data.kind);
    expect(violations).toEqual(expect.arrayContaining(["document", "workspace"]));
    expect(state.review?.files.map((f) => f.path)).not.toContain("src/hack.ts");
  });

  it("nimmt Review-Feedback an und arbeitet ab dem letzten schreibenden Agenten weiter", async () => {
    const h = createHarness({ script: featureReviewHappy });
    const { id } = await h.run("feature-review");
    await h.engine.decideReview(id, { action: "request-changes", feedback: "Bitte Rate-Limiting ergänzen" });
    const again = await h.engine.wait(id);
    expect(again.status).toBe("review_pending");
    expect(h.runtime.callsFor("document").at(-1)?.prompt).toContain("Bitte Rate-Limiting ergänzen");
  });
});

describe("Weitere Beispiel-Workflows", () => {
  it("Triage: Mehrheit aus drei Stimmen, kleiner Pfad wird direkt übernommen", async () => {
    const h = createHarness({ script: { triage: { votes: ["klein", "mittel", "klein"] }, quick: { writes: { "src/fix.ts": "fix" } } } });
    const { id, state, events } = await h.run("feature-triage");
    expect(state.status).toBe("completed");
    expect(state.review?.decided?.action).toBe("apply");
    expect(events.find((e) => e.type === "step.decision")?.data).toMatchObject({ winner: "klein", votes: ["klein", "mittel", "klein"] });
    expect(h.workspace.project.get("/project")?.get("src/fix.ts")).toBe("fix");
    expect(h.engine.get(id)?.steps).toBeDefined();
  });

  it("Triage: Gleichstand fällt auf den Fallback-Zweig, mittlerer Pfad läuft als Sub-Workflow", async () => {
    const h = createHarness({ script: { triage: { votes: ["klein", "gross"] }, ...featureReviewHappy } });
    const { state } = await h.run("feature-triage");
    expect(state.status).toBe("review_pending");
    const sub = Object.values(state.steps).find((s) => s.nodeId === "medium");
    expect(sub?.port).toBe("success");
    expect(state.review?.files.map((f) => f.path)).toContain("src/reset.ts");
  });

  it("Best-of-3: Decider wählt einen Kandidaten, nur dessen Änderungen bleiben", async () => {
    const h = createHarness({
      script: {
        plan: { docs: { "plan.md": "# Plan" } },
        "impl-a": { writes: { "src/a.ts": "A" } },
        "impl-b": { writes: { "src/b.ts": "B" } },
        "impl-c": { writes: { "src/c.ts": "C" } },
        decide: { selectedCandidate: "impl-b", summary: "B ist am einfachsten" },
        review: { branch: "approved" },
      },
    });
    const { state } = await h.run("best-of-3");
    expect(state.status).toBe("review_pending");
    const decidePrompt = h.runtime.callsFor("decide")[0]?.prompt ?? "";
    expect(decidePrompt).toContain("## Kandidaten");
    expect(state.review?.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/b.ts"]));
    expect(state.review?.files.map((f) => f.path)).not.toContain("src/a.ts");
  });

  it("Großes Feature: Freigabe, Für-jedes mit Merge, Reviews", async () => {
    const h = createHarness({
      script: {
        architect: { docs: { "architecture.md": "# Arch" } },
        plan: { docs: { "plan.md": "# Plan" }, output: { tasks: ["API", "UI", "Mail"] } },
        "sub:implementer": (req) => ({ writes: { [`src/${req.prompt.match(/: (\w+)/)?.[1] ?? "x"}.ts`]: "impl" } }),
        security: approve,
        "arch-review": approve,
      },
    });
    const id = h.engine.start(h.spec("big-feature"));
    const waiting = await h.engine.wait(id, ["waiting_input"]);
    h.engine.answer(id, waiting.inbox[0]!.id, "freigegeben");
    const state = await h.engine.wait(id);
    expect(state.status).toBe("review_pending");
    const items = Object.values(state.steps).filter((s) => s.nodeType === "map-item");
    expect(items).toHaveLength(3);
    expect(state.review?.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/API.ts", "src/UI.ts", "src/Mail.ts"]));
  });

  it("Großes Feature: Merge-Konflikte gehen an den Integrator", async () => {
    const h = createHarness({
      script: {
        architect: { docs: { "architecture.md": "# Arch" } },
        plan: { docs: { "plan.md": "# Plan" }, output: { tasks: ["A", "B"] } },
        "sub:implementer": (_r, call) => ({ writes: { "src/shared.ts": `Version ${call}` } }),
        integrate: { writes: { "src/shared.ts": "zusammengeführt" } },
        security: approve,
        "arch-review": approve,
      },
    });
    const id = h.engine.start(h.spec("big-feature"));
    const waiting = await h.engine.wait(id, ["waiting_input"]);
    h.engine.answer(id, waiting.inbox[0]!.id, "freigegeben");
    const state = await h.engine.wait(id);
    expect(state.status).toBe("review_pending");
    expect(h.runtime.callsFor("integrate")).toHaveLength(1);
    expect(h.runtime.callsFor("integrate")[0]?.prompt).toContain("Merge-Konflikte in: src/shared.ts");
  });

  it("Bugfix: Test muss erst rot sein", async () => {
    const results = [0, 1, 0];
    const h = createHarness({
      script: { analyse: (_r, call) => ({ docs: { "bug.md": `# Bug (Analyse ${call})` } }), review: { branch: "approved" } },
      scripts: (_c, _w, call) => ({ exitCode: results[call - 1] ?? 0, output: `lauf ${call}` }),
    });
    const { state } = await h.run("bugfix-tdd");
    expect(state.status).toBe("review_pending");
    expect(h.runtime.callsFor("analyse")).toHaveLength(2);
    expect(h.runtime.callsFor("analyse")[1]?.prompt).toContain("reproduziert den Fehler nicht");
  });
});

describe("Sub-Agenten", () => {
  const research = {
    research: {
      delegate: [
        [
          { agent: "code-explorer", task: "Wie ist Auth aufgebaut?" },
          { agent: "docs-explorer", task: "Was sagt die Doku zu Mails?" },
          { agent: "implementer", task: "Nicht erlaubt" },
        ],
        [{ agent: "code-explorer", task: "Wo wird gemailt?" }],
      ],
      docs: { "research.md": "# Recherche" },
    },
    "sub:code-explorer": { output: { findings: ["src/auth.ts"] } },
    "sub:docs-explorer": { output: { findings: ["docs/mail.md"] } },
    plan: { docs: { "plan.md": "# Plan" } },
    verify: { branch: "approved" },
  } satisfies Record<string, FakeEntry>;

  it("delegiert in Wellen, lehnt nicht erlaubte Agenten ab und zeigt Ergebnisse dem Nachfolger", async () => {
    const h = createHarness({ script: research });
    const { state, events } = await h.run("research-feature");
    expect(state.status).toBe("review_pending");
    const [wave1, wave2] = h.runtime.delegationResults;
    expect(wave1?.results.map((r) => r.status)).toEqual(["completed", "completed", "failed"]);
    expect(wave1?.results[2]?.error).toContain("nicht erlaubt");
    expect(wave2?.wave).toBe(2);
    expect(wave2?.remainingRuns).toBe(12);
    const subs = Object.values(state.steps).filter((s) => s.nodeType === "subagent");
    expect(subs).toHaveLength(3);
    expect(subs.every((s) => s.parentStepId)).toBe(true);
    expect(events.filter((e) => e.type === "delegation.wave_completed")).toHaveLength(2);
    const orchestrator = h.runtime.callsFor("research")[0];
    expect(orchestrator?.systemPrompt).toContain("aiflow_delegate");
    expect(orchestrator?.permissions).toContainEqual({ action: "grep", resource: "*", effect: "deny" });
    // Erzwungene Delegation sperrt auch MCP-Tools; andere Agenten behalten ihren MCP-Standard
    expect(orchestrator?.permissions).toContainEqual({ action: "mcp", resource: "*", effect: "deny" });
    expect(h.runtime.callsFor("plan")[0]?.permissions).toContainEqual({ action: "mcp", resource: "*", effect: "allow" });
    expect(h.runtime.callsFor("plan")[0]?.prompt).toContain("Ergebnisse der Sub-Agenten");
  });

  it("erzwingt Delegation", async () => {
    const h = createHarness({ script: { ...research, research: { docs: { "research.md": "x" } } } });
    const { state } = await h.run("research-feature");
    expect(state.status).toBe("failed");
    expect(state.error).toContain("Delegation ist erzwungen");
  });

  it("meldet ein erschöpftes Budget", async () => {
    const wave = Array.from({ length: 10 }, (_, i) => ({ agent: "code-explorer", task: `Frage ${i}` }));
    const h = createHarness({ script: { ...research, research: { delegate: [wave, wave, wave], docs: { "research.md": "x" } } } });
    const { state } = await h.run("research-feature");
    expect(state.status).toBe("review_pending");
    const [, second, third] = h.runtime.delegationResults;
    expect(second?.results.filter((r) => r.status === "skipped")).toHaveLength(5);
    expect(third?.budgetExhausted).toBe(true);
  });

  it("hält die Parallelität ein", async () => {
    let running = 0;
    let peak = 0;
    const wave = Array.from({ length: 8 }, (_, i) => ({ agent: "code-explorer", task: `F${i}` }));
    const h = createHarness({
      script: {
        ...research,
        research: { delegate: [wave], docs: { "research.md": "x" } },
        "sub:code-explorer": () => {
          running++;
          peak = Math.max(peak, running);
          return { delayMs: 20, output: { findings: [] } };
        },
      },
      maxParallelSessions: 3,
    });
    const origRun = h.runtime.runAgentStep.bind(h.runtime);
    h.runtime.runAgentStep = async (req, ctx) => {
      try {
        return await origRun(req, ctx);
      } finally {
        if (req.parentStepId) running--;
      }
    };
    const { state } = await h.run("research-feature");
    expect(state.status).toBe("review_pending");
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("Ablaufsteuerung", () => {
  it("Race: der erste Zweig gewinnt, der andere wird abgebrochen", async () => {
    const definitions = custom({
      nodes: {
        start: { type: "start" },
        fast: { type: "agent", agent: "implementer", workspace: { mode: "isolate" } },
        slow: { type: "agent", agent: "implementer", workspace: { mode: "isolate" } },
        race: { type: "join", wait: "first" },
        done: { type: "end", finalize: "none" },
      },
      edges: [{ from: "start", to: "fast" }, { from: "start", to: "slow" }, { from: "fast", to: "race" }, { from: "slow", to: "race" }, { from: "race", to: "done" }],
    });
    const h = createHarness({ definitions, script: { fast: { delayMs: 5 }, slow: { delayMs: 2000 } } });
    const { state, events } = await h.run("custom");
    expect(state.status).toBe("completed");
    expect(events.some((e) => e.type === "token.cancelled")).toBe(true);
    expect(Object.values(state.steps).find((s) => s.nodeId === "slow")?.status).toBe("cancelled");
  });

  it("Fehlerpfad und Bedingung", async () => {
    const definitions = custom({
      nodes: {
        start: { type: "start" },
        work: { type: "agent", agent: "implementer", retries: 0 },
        rescue: { type: "agent", agent: "fixer" },
        check: { type: "condition", rules: { repaired: { "==": [{ var: "node.rescue.summary" }, "repariert"] } } },
        done: { type: "end", finalize: "none" },
        bad: { type: "end", outcome: "failed" },
      },
      edges: [
        { from: "start", to: "work" },
        { from: "work.next", to: "done" },
        { from: "work.error", to: "rescue" },
        { from: "rescue", to: "check" },
        { from: "check.repaired", to: "done" },
        { from: "check.else", to: "bad" },
      ],
    });
    const h = createHarness({ definitions, script: { work: { fail: "Provider down" }, rescue: { summary: "repariert" } } });
    const { state } = await h.run("custom");
    expect(state.status).toBe("completed");
    expect(Object.values(state.steps).find((s) => s.nodeId === "work")?.port).toBe("error");
    expect(Object.values(state.steps).find((s) => s.nodeId === "check")?.port).toBe("repaired");
  });

  it("bricht bei maxSteps ab", async () => {
    const definitions = custom({
      settings: { limits: { maxSteps: 3 } },
      nodes: { start: { type: "start" }, a: { type: "agent", agent: "implementer" }, b: { type: "agent", agent: "implementer" }, c: { type: "agent", agent: "implementer" }, done: { type: "end" } },
      edges: [{ from: "start", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "done" }],
    });
    const h = createHarness({ definitions });
    const { state } = await h.run("custom");
    expect(state.status).toBe("failed");
    expect(state.error).toContain("Maximale Anzahl Schritte");
  });

  it("lässt sich abbrechen", async () => {
    const h = createHarness({ script: { ...featureReviewHappy, implement: { delayMs: 5000 } } });
    const id = h.engine.start(h.spec("feature-review"));
    await sleep(50);
    h.engine.cancel(id);
    const state = await h.engine.wait(id);
    expect(state.status).toBe("cancelled");
    expect(Object.values(state.steps).some((s) => s.status === "cancelled")).toBe(true);
  });

  it("ist deterministisch", async () => {
    const a = await createHarness({ script: featureReviewHappy }).run("feature-review");
    const b = await createHarness({ script: featureReviewHappy }).run("feature-review");
    expect(types(a.events)).toEqual(types(b.events));
  });
});

describe("Wiederaufnahme nach Absturz", () => {
  it("setzt unterbrochene Schritte neu auf und kommt zum selben Ergebnis", async () => {
    const first = createHarness({ script: { ...featureReviewHappy, implement: { delayMs: 10_000 } } });
    const id = first.engine.start(first.spec("feature-review"));
    while (!Object.values(first.sink.states.get(id)?.steps ?? {}).some((s) => s.nodeId === "implement")) await sleep(5);
    const snapshot = structuredClone(first.sink.states.get(id)!);
    first.engine.cancel(id, "Absturz simuliert");

    const second = createHarness({ script: featureReviewHappy, idNamespace: "r" });
    // Workspace-Zustand des ersten Prozesses übernehmen (bei git liegt er auf der Platte)
    Object.assign(second.workspace, first.workspace);
    Object.assign(second.documents, first.documents);
    await second.engine.restore(snapshot);
    expect(second.engine.get(id)?.status).toBe("interrupted");
    second.engine.resume(id);
    const state = await second.engine.wait(id);
    expect(state.status).toBe("review_pending");
    expect(Object.values(state.steps).filter((s) => s.nodeId === "plan" && s.status === "completed")).toHaveLength(1);
    expect(Object.values(state.steps).some((s) => s.error?.includes("Unterbrochen"))).toBe(true);
  });
});
