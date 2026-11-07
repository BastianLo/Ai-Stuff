import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { checksFor, guardToolCall, WorkerApi, type WorkerSessionInfo } from "../src/core/worker.js";
import { WorkerHooks } from "../src/core/worker-hooks.js";
import { statusLines, formatDuration } from "../src/core/bridge.js";
import { resolveOptions, workerEnv } from "../src/core/config.js";
import { delegateSchema, WORKER_TOOL_NAMES } from "../src/core/tools.js";
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
    expect(guardToolCall(info, "edit", { filePath: "/docs/plan.md" })).toContain("nicht erlaubt");
    expect(guardToolCall(info, "write", { filePath: "/ws/x.ts" })).toContain("Nur-lesen");
    expect(guardToolCall(info, "read", { filePath: "/ws/x.ts" })).toBeUndefined();
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
