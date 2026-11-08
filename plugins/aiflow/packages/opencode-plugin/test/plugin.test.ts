import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { checksFor, guardToolCall, WorkerApi, type WorkerSessionInfo } from "../src/core/worker.js";
import { WorkerHooks } from "../src/core/worker-hooks.js";
import { statusLines, formatDuration } from "../src/core/bridge.js";
import { resolveOptions, serveArgs, workerEnv } from "../src/core/config.js";
import { delegateSchema, visibleWorkerTools, WORKER_TOOL_NAMES } from "../src/core/tools.js";
import { createHarness } from "@aiflow/testkit";
import type { RunView } from "@aiflow/client";

const info: WorkerSessionInfo = {
  runId: "run_1",
  stepId: "step_1",
  label: "Security-Reviewer",
  systemPrompt: "Du bist Reviewer",
  handoffSchema: { type: "object" },
  workspace: { path: "/ws", readOnly: true },
  documents: [{ name: "plan.md", path: "/docs/plan.md", access: "read" }],
  permissions: [
    { action: "shell", resource: "*", effect: "deny" },
    { action: "shell", resource: "git diff*", effect: "allow" },
    { action: "edit", resource: "/docs/plan.md", effect: "deny" },
  ],
  phase: "work",
  handoffReceived: false,
  questions: true,
  subSession: false,
};

describe("kombinierter Einstiegspunkt", () => {
  it("hat id, setup (v2) und server (v1)", () => {
    expect(plugin.id).toBe("aiflow");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.server).toBe("function");
  });
});

describe("Guard der Worker-Rolle", () => {
  it("leitet Prüfungen aus Tool-Aufrufen von v1 und v2 ab", () => {
    expect(checksFor("bash", { command: "rm -rf /" })).toEqual([{ action: "shell", resource: "rm -rf /" }]);
    expect(checksFor("write", { filePath: "/ws/a.ts" })).toEqual([{ action: "edit", resource: "/ws/a.ts" }]);
    expect(checksFor("task", {})).toEqual([{ action: "subagent", resource: "*" }]);
  });

  it("blockiert verbotene Befehle, Schreibzugriffe und Dokumente", () => {
    expect(guardToolCall(info, "bash", { command: "npm publish" })).toContain("nicht erlaubt");
    expect(guardToolCall(info, "bash", { command: "git diff HEAD" })).toBeUndefined();
    // MCP-Tools werden über ihren Namen gegen die von der Runtime aufgelösten `<server>_*`-Regeln geprüft
    const mcp = { ...info, permissions: [...info.permissions, { action: "github_*", resource: "*", effect: "deny" as const }] };
    expect(guardToolCall(mcp, "github_create_issue", { title: "x" })).toContain("nicht erlaubt");
    expect(guardToolCall(mcp, "context7_query", {})).toBeUndefined();
    expect(guardToolCall(info, "edit", { filePath: "/docs/plan.md" })).toContain("nicht erlaubt");
    expect(guardToolCall(info, "write", { filePath: "/ws/x.ts" })).toContain("Nur-lesen");
    expect(guardToolCall(info, "read", { filePath: "/ws/x.ts" })).toBeUndefined();
  });
});

describe("Gleichstellung mit normalen Sessions", () => {
  it("lässt Plugin-Tools (z. B. Skill-/Wissenssuche) und Skills ohne Regel durch", () => {
    // u. a. die Lese-Tools von SkillSmith; auch in Kind-Sessions nativer Sub-Agenten
    const tools = ["skill_search", "skill_list", "skill_read", "knowledge_search", "glossary_lookup", "error_lookup", "script_read", "call_script", "docs_search", "history_search", "memory_search", "graph_neighbors", "skill", "todowrite"];
    for (const tool of tools) {
      expect(guardToolCall(info, tool, { query: "auth" })).toBeUndefined();
      expect(guardToolCall({ ...info, subSession: true }, tool, {})).toBeUndefined();
    }
    // Das AiFlow-Plugin blendet in Sessions nur seine eigenen Tools aus, nie Tools anderer Plugins
    expect(WORKER_TOOL_NAMES.every((n) => n.startsWith("aiflow_"))).toBe(true);
    // Nur eine ausdrückliche Regel sperrt ein Plugin-Tool
    const blocked = { ...info, permissions: [...info.permissions, { action: "skill_*", resource: "*", effect: "deny" as const }] };
    expect(guardToolCall(blocked, "skill_search", {})).toContain("nicht erlaubt");
  });

  it("zeigt Kind-Sessions nur Fragen und Fortschritt, dem Schritt alle passenden AiFlow-Tools", () => {
    expect([...visibleWorkerTools(info)].sort()).toEqual(["aiflow_ask", "aiflow_context", "aiflow_handoff", "aiflow_progress"]);
    expect([...visibleWorkerTools({ ...info, delegation: { allowed: [], mode: "optional", maxParallel: 1, remainingRuns: 1 } })]).toContain("aiflow_delegate");
    expect([...visibleWorkerTools({ ...info, subSession: true })].sort()).toEqual(["aiflow_ask", "aiflow_progress"]);
    expect([...visibleWorkerTools({ ...info, questions: false, subSession: true })]).toEqual(["aiflow_progress"]);
    expect(visibleWorkerTools(null).size).toBe(0);
  });
});

describe("Worker-Hooks gegen die Worker-API", () => {
  function fakeFetch(responses: Record<string, unknown>): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const key = `${init?.method ?? "GET"} ${href.replace("http://d/api/worker", "")}`;
      const body = responses[key];
      return new Response(body === undefined ? "" : JSON.stringify(body), { status: body === undefined ? 404 : 200 });
    });
  }

  it("wartet auf lange Aufträge per Abfrage statt einem langen Request (Rückfrage, Delegation)", async () => {
    let polls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (init?.method === "POST" && href.endsWith("/sessions/s1/ask")) {
        expect(JSON.parse(typeof init.body === "string" ? init.body : "")).toEqual({ question: "A oder B?", options: ["A", "B"] });
        return new Response(JSON.stringify({ job: "job_1" }));
      }
      if (href.endsWith("/jobs/job_1")) return new Response(JSON.stringify(++polls < 3 ? { state: "running" } : { state: "done", result: "B" }));
      if (init?.method === "POST" && href.endsWith("/sessions/s1/delegate")) return new Response(JSON.stringify({ job: "job_2" }));
      if (href.endsWith("/jobs/job_2")) return new Response(JSON.stringify({ state: "failed", error: { code: "FORBIDDEN", message: "keine Sub-Agenten" } }));
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const hooks = new WorkerHooks(new WorkerApi({ daemonUrl: "http://d", token: "t" }, fetchImpl, 1));
    expect(await hooks.ask("s1", { question: "A oder B?", options: ["A", "B", 3] })).toBe("Antwort des Nutzers: B");
    expect(polls).toBe(3);
    await expect(hooks.delegate("s1", { tasks: [] })).rejects.toThrow("keine Sub-Agenten");
    await expect(hooks.ask("s1", { question: " " })).rejects.toThrow("question fehlt");
  });

  it("liefert Session-Infos, Umgebung und Nachforderung der Übergabe", async () => {
    const api = new WorkerApi({ daemonUrl: "http://d", token: "t" }, fakeFetch({ "GET /sessions/s1": { ...info, phase: "finalize" }, "POST /sessions/s1/handoff": { ok: false, error: "fehlt" } }));
    const hooks = new WorkerHooks(api);
    expect(await hooks.env("s1")).toMatchObject({ AIFLOW_RUN_ID: "run_1", AIFLOW_DOCS_DIR: "/docs" });
    expect(await hooks.env("unbekannt")).toEqual({});
    expect(await hooks.idleNudge("s1")).toContain("aiflow_handoff");
    await expect(hooks.handoff("s1", {})).rejects.toThrow("fehlt");
    await expect(hooks.guard("s1", "bash", { command: "curl x" })).rejects.toThrow(/nicht erlaubt/);
    expect(await hooks.evaluate("s1", "shell", ["git diff"])).toEqual({ deny: false });
    expect((await hooks.evaluate("s1", "edit", ["/docs/plan.md"])).deny).toBe(true);
  });
});

describe("Konfiguration und Tools", () => {
  it("liest Optionen und Worker-Umgebung", () => {
    expect(resolveOptions({ url: "http://x", autoStart: false })).toMatchObject({ url: "http://x", autoStart: false, agentTools: true });
    expect(workerEnv({ AIFLOW_WORKER: "1", AIFLOW_DAEMON_URL: "http://d", AIFLOW_WORKER_TOKEN: "t" })).toEqual({ daemonUrl: "http://d", token: "t" });
    expect(workerEnv({})).toBeUndefined();
    const withPaths = resolveOptions({ url: "http://127.0.0.1:5800", dataDir: "~/aiflow-daten", opencodeConfig: "~/.config/opencode.jsonc" });
    expect(serveArgs(withPaths)).toEqual(["serve", "--detach", "--port", "5800", "--data-dir", "~/aiflow-daten", "--opencode-config", "~/.config/opencode.jsonc"]);
    expect(serveArgs(resolveOptions({ url: "http://127.0.0.1:5739" }))).toEqual(["serve", "--detach", "--port", "5739"]);
    expect(WORKER_TOOL_NAMES).toContain("aiflow_handoff");
    expect(JSON.stringify(delegateSchema(["code-explorer"]))).toContain("code-explorer");
  });
});

describe("Statusanzeige", () => {
  it("zeigt Schritte, Sub-Agenten und Entscheidungen", async () => {
    const h = createHarness({
      script: {
        research: { delegate: [[{ agent: "code-explorer", task: "A" }]], docs: { "research.md": "x" } },
        plan: { docs: { "plan.md": "p" } },
        verify: { branch: "approved", branchReason: "alles erfüllt" },
      },
    });
    const { state } = await h.run("research-feature");
    const view = { ...state, workflow: state.spec.workflow, steps: Object.values(state.steps) } as unknown as RunView;
    const lines = statusLines(view, state.finishedAt);
    expect(lines[0]).toContain("AiFlow · research-feature");
    expect(lines.some((l) => l.includes("Verifier → approved"))).toBe(true);
    expect(lines.at(-1)).toContain("Review ausstehend");
    expect(formatDuration(125_000)).toBe("2:05");
  });
});
