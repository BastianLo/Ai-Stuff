import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiflowClient, ApiError, type GlobalEvent } from "@aiflow/client";
import type { RunEvent } from "@aiflow/core";
import { examplesDir, startDaemon, type RunningDaemon } from "@aiflow/server";
import { createDemoProject } from "@aiflow/testkit";

let running: RunningDaemon;
let client: AiflowClient;
let project: string;
let root: string;
const port = 40000 + Math.floor(Math.random() * 20000);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aiflow-daemon-"));
  running = await startDaemon({ paths: { config: join(root, "config"), data: join(root, "data") }, port, runtime: "simulation", simulationSpeed: 0, seedFrom: examplesDir, webDir: "/nicht-vorhanden" });
  client = new AiflowClient({ baseUrl: running.url, token: running.daemon.token });
  project = createDemoProject();
});

afterAll(async () => {
  await running.close();
  rmSync(root, { recursive: true, force: true });
});

const raw = (path: string, init: RequestInit = {}) => fetch(`${running.url}${path}`, init);

async function waitFor(id: string, statuses: string[]) {
  for (let i = 0; i < 200; i++) {
    const run = await client.run(id);
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Run ${id} erreicht ${statuses.join("/")} nicht`);
}

describe("Sicherheit", () => {
  it("verlangt Authentifizierung", async () => {
    expect((await raw("/api/health")).status).toBe(401);
    await expect(new AiflowClient({ baseUrl: running.url, token: "falsch" }).health()).rejects.toBeInstanceOf(ApiError);
  });

  it("lehnt fremde Host-Header und Origins ab (DNS-Rebinding, CSRF)", async () => {
    const auth = { authorization: `Bearer ${running.daemon.token}` };
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port, path: "/api/health", headers: { ...auth, host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end();
    });
    expect(status).toBe(403);
    expect((await raw("/api/runs", { method: "POST", headers: { ...auth, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(403);
  });

  it("meldet per Einmal-Link mit HttpOnly-Cookie an; Links sind nur einmal gültig", async () => {
    const { url } = await client.createLogin(project);
    const res = await fetch(url, { redirect: "manual" });
    expect(res.status).toBe(302);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(res.headers.get("location")).toContain(`project=${encodeURIComponent(project)}`);
    expect((await raw("/api/health", { headers: { cookie: cookie.split(";")[0] ?? "" } })).status).toBe(200);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(401);
  });

  it("schützt die Worker-API mit eigenem Token", async () => {
    expect((await raw("/api/worker/sessions/x")).status).toBe(403);
    expect((await raw("/api/worker/sessions/x", { headers: { "x-aiflow-worker-token": running.daemon.workerToken } })).status).toBe(404);
  });
});

describe("Definitionen", () => {
  it("listet Beispiele, speichert, versioniert und löscht", async () => {
    const workflows = await client.workflows();
    expect(workflows.map((w) => w.id)).toEqual(expect.arrayContaining(["feature-review", "research-feature"]));
    const agent = (await client.getDefinition<Record<string, unknown>>("agents", "planner")).definition!;
    const saved = await client.saveDefinition("agents", "planner-kopie", { ...agent, id: "planner-kopie", name: "Planner (Kopie)" }, "global");
    expect(saved.version).toHaveLength(12);
    expect((await client.definitionVersions("agents", "planner-kopie")).length).toBe(1);
    await expect(client.saveDefinition("agents", "x", { id: "y", name: "x" }, "global")).rejects.toThrow(/ID/);
    await client.deleteDefinition("agents", "planner-kopie", "global");
    await expect(client.getDefinition("agents", "planner-kopie")).rejects.toThrow(/existiert nicht/);
  });

  it("validiert Workflows serverseitig", async () => {
    const wf = (await client.getDefinition("workflows", "feature-review")).definition;
    expect((await client.validateWorkflow(wf)).ok).toBe(true);
    const broken = { ...(wf as object), edges: [] };
    const result = await client.validateWorkflow(broken);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "port.unconnected")).toBe(true);
  });

  it("verlangt Workspace-Trust für Projekt-Definitionen", async () => {
    const other = createDemoProject();
    const snippet = { id: "lokal", name: "Lokal", content: "x" };
    running.daemon.definitions.save("snippets", snippet, "project", other);
    await expect(client.startRun({ workflowId: "feature-review", projectDir: other, input: { prompt: "x" } })).rejects.toMatchObject({ code: "UNTRUSTED" });
    expect((await client.trustProject(other)).trusted).toBe(true);
  });
});

describe("Runs", () => {
  it("führt einen Run aus, streamt Events, Review und Übernahme", async () => {
    await client.registerProject(project);
    const stop = new AbortController();
    const global: GlobalEvent[] = [];
    void client.subscribeGlobal((e) => global.push(e), stop.signal);
    const { id } = await client.startRun({ workflowId: "feature-review", projectDir: project, input: { prompt: "Passwort-Reset per E-Mail" }, origin: "web" });
    const events: RunEvent[] = [];
    void client.subscribeRun(id, (e) => events.push(e), stop.signal);
    const run = await waitFor(id, ["review_pending", "failed"]);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("review_pending");
    expect(run.steps.some((s) => s.nodeId === "security" && s.visit === 2)).toBe(true);
    expect(run.review?.files.map((f) => f.path)).toEqual(expect.arrayContaining(["src/passwort-reset-per-e-mail.js", "test/passwort-reset-per-e-mail.test.js"]));
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((e) => e.type === "run.review_pending")).toBe(true);
    expect(global.some((e) => e.type === "run.updated" && e.runId === id)).toBe(true);
    const docs = await client.runDocuments(id);
    expect(docs.find((d) => d.name === "plan.md")?.content).toContain("# Plan");
    const implement = run.steps.find((s) => s.nodeId === "implement");
    expect((await client.stepDiff(id, implement!.id)).length).toBeGreaterThan(0);
    expect((await client.inbox(project)).some((i) => i.kind === "review" && i.runId === id)).toBe(true);
    await client.review(id, { action: "apply" });
    expect((await client.run(id)).status).toBe("completed");
    expect((await client.runs({ project })).find((r) => r.id === id)?.status).toBe("completed");
    stop.abort();
  });

  it("beantwortet Mensch-Knoten über die Inbox", async () => {
    const { id } = await client.startRun({ workflowId: "big-feature", projectDir: project, input: { prompt: "Bestellhistorie" } });
    await waitFor(id, ["waiting_input"]);
    const item = (await client.inbox(project)).find((i) => i.runId === id && i.kind === "human");
    expect(item?.options).toEqual(["freigegeben", "aendern"]);
    await client.answer(id, item!.id, "freigegeben", "Passt");
    const run = await waitFor(id, ["review_pending", "failed"]);
    expect(run.error).toBeUndefined();
    expect(run.steps.filter((s) => s.nodeType === "map-item")).toHaveLength(3);
  });

  it("bricht ab und löscht Runs", async () => {
    const { id } = await client.startRun({ workflowId: "big-feature", projectDir: project, input: { prompt: "Abbruch" } });
    await waitFor(id, ["waiting_input"]);
    await expect(client.deleteRun(id)).rejects.toThrow(/abbrechen/);
    await client.cancelRun(id);
    expect((await client.run(id)).status).toBe("cancelled");
    await client.deleteRun(id);
    await expect(client.run(id)).rejects.toThrow();
  });

  it("verweigert unbekannte Workflows und fehlende Eingaben", async () => {
    await expect(client.startRun({ workflowId: "gibt-es-nicht", projectDir: project, input: { prompt: "x" } })).rejects.toThrow(/existiert nicht/);
    await expect(client.startRun({ workflowId: "feature-review", projectDir: project, input: {} })).rejects.toThrow(/fehlt/);
  });
});

describe("Testlauf und Playground", () => {
  it("simuliert einen Workflow mit vorgegebenen Zweigen", async () => {
    const result = await client.simulate("feature-triage", { choices: { triage: "klein" } });
    expect(result.status).toBe("completed");
    expect(result.path.map((p) => p.nodeId)).toEqual(["start", "triage", "quick", "quickchecks", "applied"]);
    const failing = await client.simulate("feature-review", { scriptExitCode: 1, choices: { escalate: "abbrechen" } });
    // Gleiche Fehlerausgabe → Stagnation: nach dem ersten Wiederholversuch wird eskaliert
    expect(failing.path.filter((p) => p.nodeId === "implement").length).toBe(2);
    const retry = await client.simulate("feature-review", { scriptExitCode: 1 });
    expect(retry.path.filter((p) => p.nodeId === "implement").length).toBe(4);
    expect(failing.status).toBe("cancelled");
  });

  it("startet einen einzelnen Agenten im Playground", async () => {
    const { runId } = await client.playground("implementer", { project, prompt: "Schreibe eine Hilfsfunktion" });
    const run = await waitFor(runId, ["review_pending", "failed"]);
    expect(run.workflow.id).toBe("playground");
    expect(run.review?.files.length).toBeGreaterThan(0);
  });

  it("liefert Runtime-Infos", async () => {
    const info = await client.runtime();
    expect(info.id).toBe("simulation");
    expect(info.models.length).toBeGreaterThan(0);
  });
});
