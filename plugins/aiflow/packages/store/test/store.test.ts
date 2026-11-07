import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefinitionRepository, FsDocumentStore, SqliteStore } from "@aiflow/store";
import { createHarness, examplesDir } from "@aiflow/testkit";

const tmp = () => mkdtempSync(join(tmpdir(), "aiflow-store-"));

describe("SqliteStore", () => {
  it("speichert Events, Zustände und Zusammenfassungen eines echten Runs", async () => {
    const dir = tmp();
    const store = new SqliteStore(join(dir, "db", "aiflow.db"));
    const h = createHarness({ script: { plan: { docs: { "plan.md": "# P" } } } });
    const { id, events, state } = await h.run("feature-review", "Login mit Passkeys");
    for (const e of events) store.append(e);
    store.saveState(state);
    expect(store.events(id)).toHaveLength(events.length);
    expect(store.events(id, events.length - 2)).toHaveLength(2);
    expect(store.getState(id)?.status).toBe("review_pending");
    const [summary] = store.listRuns({ query: "Passkeys" });
    expect(summary).toMatchObject({ id, workflowId: "feature-review", status: "review_pending" });
    expect(store.unfinishedStates().map((s) => s.id)).toEqual([id]);
    store.deleteRun(id);
    expect(store.listRuns()).toHaveLength(0);
  });

  it("speichert Definitions-Versionen", () => {
    const store = new SqliteStore(":memory:");
    store.saveDefinitionVersion({ kind: "agents", id: "a", scope: "global", version: "v1", createdAt: 1, content: "x" });
    store.saveDefinitionVersion({ kind: "agents", id: "a", scope: "global", version: "v2", createdAt: 2, content: "y" });
    expect(store.definitionVersions("agents", "a").map((v) => v.version)).toEqual(["v2", "v1"]);
  });
});

describe("FsDocumentStore", () => {
  it("legt Dokumente an, liest, schreibt und versioniert", async () => {
    const docs = new FsDocumentStore(tmp());
    await docs.init("r1", [{ name: "plan.md", content: "# Plan" }]);
    expect(await docs.read("r1", "plan.md")).toBe("# Plan");
    await docs.write("r1", "plan.md", "# Neu");
    await docs.recordVersion("r1", "plan.md", { stepId: "s1", ts: 1, content: "# Neu" });
    expect((await docs.versions("r1", "plan.md")).map((v) => v.stepId)).toEqual(["s1"]);
    expect(() => docs.path("r1", "../x")).toThrow(/Ungültiger/);
  });
});

describe("DefinitionRepository", () => {
  it("lädt global und projektbezogen; Projekt verdeckt Global", () => {
    const global = tmp();
    const project = tmp();
    const saved: string[] = [];
    const repo = new DefinitionRepository({ globalDir: global, onSave: (e) => saved.push(`${e.kind}/${e.id}@${e.version}`) });
    expect(repo.seed(examplesDir)).toBeGreaterThan(10);
    const agent = repo.get("agents", "planner").definition!;
    repo.save("agents", { ...agent, name: "Projekt-Planner" }, "project", project);
    expect(repo.get("agents", "planner", project).definition?.name).toBe("Projekt-Planner");
    expect(repo.get("agents", "planner").definition?.name).toBe("Planner");
    expect(repo.list("agents", project).find((e) => e.scope === "global" && e.id === "planner")?.shadowed).toBe(true);
    expect(saved).toHaveLength(1);
    const resolved = repo.resolve(project);
    expect(resolved.workflows["feature-review"]).toBeDefined();
    expect(resolved.agents.planner?.name).toBe("Projekt-Planner");
  });

  it("meldet kaputte Dateien statt abzustürzen und validiert beim Speichern", () => {
    const global = tmp();
    mkdirSync(join(global, "agents"), { recursive: true });
    writeFileSync(join(global, "agents", "kaputt.yaml"), "id: [");
    const repo = new DefinitionRepository({ globalDir: global });
    expect(repo.list("agents")[0]?.error).toContain("kein gültiges YAML");
    expect(() => repo.save("agents", { id: "Böse ID", name: "x" }, "global")).toThrow(/id/);
  });

  it("verlangt erneutes Vertrauen, wenn sich Projekt-Definitionen ändern", () => {
    const repo = new DefinitionRepository({ globalDir: tmp() });
    const project = tmp();
    expect(repo.isTrusted(project)).toBe(true);
    repo.save("snippets", { id: "s", name: "S", content: "a" }, "project", project);
    expect(repo.isTrusted(project)).toBe(false);
    repo.trust(project);
    expect(repo.isTrusted(project)).toBe(true);
    repo.save("snippets", { id: "s", name: "S", content: "b" }, "project", project);
    expect(repo.isTrusted(project)).toBe(false);
  });
});
