import { describe, expect, it, vi } from "vitest";
import type { AgentStepContext, AgentStepRequest } from "@aiflow/engine";
import { agentSchema, buildHandoffSchema } from "@aiflow/core";
import { createHarness, sampleFromSchema } from "@aiflow/testkit";
import { extractJson, mapV1Event, mapV2Event, OpencodeRuntime, toV1Rules, V1Driver, V2Driver, WorkerBridge, type V1Client, type V2Client } from "@aiflow/runtime-opencode";

const schema = buildHandoffSchema({ branches: [{ port: "approved", description: "ok", instructions: [] }, { port: "rejected", description: "nok", instructions: [] }] });

function request(overrides: Partial<AgentStepRequest> = {}): AgentStepRequest {
  return {
    runId: "run_1",
    stepId: "step_1",
    nodeId: "review",
    label: "Reviewer",
    agent: agentSchema.parse({ id: "reviewer", name: "Reviewer" }),
    systemPrompt: "Du bist Reviewer.",
    prompt: "# Aufgabe\n\n## Dokumente\n- plan.md",
    model: { ref: "deepseek/deepseek-v4.1-flash", variant: "high" },
    workspace: { path: "/tmp/ws", readOnly: true },
    permissions: [{ action: "shell", resource: "git push*", effect: "deny" }],
    handoffSchema: schema,
    votes: 1,
    documents: [],
    timeoutMs: 60_000,
    ...overrides,
  };
}

function context(): AgentStepContext & { activities: unknown[] } {
  const activities: unknown[] = [];
  return {
    activities,
    signal: new AbortController().signal,
    activity: (a) => activities.push(a),
    delegate: vi.fn(async () => ({ wave: 1, results: [], remainingRuns: 3, budgetExhausted: false })),
    ask: vi.fn(async () => "ja"),
  };
}

function v1Client(structured: (n: number) => unknown): V1Client & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let prompts = 0;
  let sessions = 0;
  return {
    calls,
    global: { health: async () => ({ data: { version: "1.19.5" } }) },
    session: {
      create: async (p) => (calls.push({ create: p }), { data: { id: `ses_${++sessions}` } }),
      prompt: async (p) => {
        calls.push({ prompt: p });
        prompts++;
        return { data: { info: { tokens: { input: 10, output: 5 }, ...(p.format ? { structured: structured(prompts) } : {}) }, parts: [{ type: "text", text: "erledigt" }] } };
      },
      fork: async () => ({ data: { id: `ses_fork_${++sessions}` } }),
      abort: async () => ({ data: true }),
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
    provider: { list: async () => ({ data: { all: [{ id: "deepseek", models: { "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" } } }] } }) },
    mcp: { status: async () => ({ data: { context7: { status: "connected" } } }) },
    config: { get: async () => ({ data: { plugin: ["opencode-aiflow"] } }) },
  };
}

describe("V1-Treiber", () => {
  it("legt Sessions mit v1-Rechten an und holt die Übergabe per format: json_schema", async () => {
    const client = v1Client(() => ({ summary: "passt", branch: "approved", branchReason: "keine Befunde" }));
    const runtime = new OpencodeRuntime(new V1Driver(client), new WorkerBridge());
    const result = await runtime.runAgentStep(request(), context());
    expect(result.handoff).toMatchObject({ branch: "approved" });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    const create = client.calls[0]?.create as Record<string, unknown>;
    expect(create).toMatchObject({ directory: "/tmp/ws", metadata: { aiflowStepId: "step_1" }, model: { id: "deepseek-v4.1-flash", providerID: "deepseek", variant: "high" } });
    expect(create.permission).toEqual([{ permission: "bash", pattern: "git push*", action: "deny" }]);
    const finalize = client.calls[2]?.prompt as Record<string, unknown>;
    expect(finalize.format).toMatchObject({ type: "json_schema", retryCount: 2 });
    expect(finalize.system).toBe("Du bist Reviewer.");
  });

  it("forkt für mehrere Stimmen", async () => {
    const client = v1Client((n) => ({ summary: "s", branch: n % 2 ? "approved" : "rejected", branchReason: "r" }));
    const runtime = new OpencodeRuntime(new V1Driver(client), new WorkerBridge());
    const result = await runtime.runAgentStep(request({ votes: 3 }), context());
    expect(result.votes).toHaveLength(3);
  });

  it("fällt auf JSON im Text zurück und listet Modelle, MCP und Plugins", async () => {
    const client = v1Client(() => undefined);
    client.session.prompt = async () => ({ data: { info: { tokens: {} }, parts: [{ type: "text", text: 'Hier:\n```json\n{"summary":"x","branch":"rejected","branchReason":"y"}\n```' }] } });
    const driver = new V1Driver(client);
    const runtime = new OpencodeRuntime(driver, new WorkerBridge());
    expect((await runtime.runAgentStep(request(), context())).handoff).toMatchObject({ branch: "rejected" });
    expect(await driver.listModels()).toEqual([{ providerID: "deepseek", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }]);
    expect(await driver.listMcp()).toEqual([{ name: "context7", status: "connected" }]);
    expect(await driver.listPlugins()).toEqual(["opencode-aiflow"]);
  });

  it("übersetzt Rechte und Events", () => {
    expect(toV1Rules([{ action: "subagent", resource: "*", effect: "deny" }])).toEqual([{ permission: "task", pattern: "*", action: "deny" }]);
    expect(mapV1Event({ type: "message.part.updated", properties: { part: { sessionID: "s", type: "tool", tool: "edit", state: { status: "completed", output: "ok" } } } })).toEqual({
      sessionId: "s",
      activity: { kind: "tool", tool: "edit", status: "succeeded", input: undefined, output: "ok" },
    });
    expect(mapV1Event({ type: "message.part.updated", properties: { part: { sessionID: "s", type: "text", text: "fertig", time: { end: 1 } } } })?.activity).toEqual({ kind: "text", text: "fertig" });
  });
});

describe("V2-Treiber", () => {
  function v2Client(bridge: WorkerBridge, handoff: unknown): V2Client & { calls: Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    let tokens = 0;
    return {
      calls,
      server: { info: async () => ({ version: "2.2.6" }) },
      session: {
        create: async (i) => (calls.push({ create: i }), { id: "ses_v2" }),
        prompt: async (i) => {
          calls.push({ prompt: i });
          // Das Plugin ruft im Worker das Tool aiflow_handoff auf → Worker-API → Bridge
          if (String(i.text).includes("aiflow_handoff")) bridge.submitHandoff(String(i.sessionID), handoff);
          return {};
        },
        fork: async () => ({ id: "ses_fork" }),
        interrupt: async () => ({ interrupted: true }),
        get: async () => ({ id: "ses_v2", tokens: { input: (tokens += 7), output: tokens } }),
      },
      experimental: { session: { wait: async () => undefined } },
      message: { list: async () => ({ data: [{ content: [{ type: "text", text: "Antwort" }] }] }) },
      event: { subscribe: () => (async function* () {})() },
      model: { list: async () => [{ providerID: "deepseek", id: "deepseek-v4.1-flash", name: "Flash" }] },
      plugin: { list: async () => [{ id: "aiflow" }] },
    };
  }

  it("holt die Übergabe über das Tool aiflow_handoff (Bridge) und setzt v2-Rechte", async () => {
    const bridge = new WorkerBridge();
    const client = v2Client(bridge, { summary: "ok", branch: "approved", branchReason: "r" });
    const runtime = new OpencodeRuntime(new V2Driver(client), bridge);
    const result = await runtime.runAgentStep(request(), context());
    expect(result.handoff).toMatchObject({ branch: "approved" });
    const create = client.calls[0]?.create as Record<string, unknown>;
    expect(create).toMatchObject({ location: { directory: "/tmp/ws" }, permissions: [{ action: "shell", resource: "git push*", effect: "deny" }] });
    expect(bridge.has("ses_v2")).toBe(false);
  });

  it("weist ungültige Übergaben mit Fehlermeldung zurück", () => {
    const bridge = new WorkerBridge();
    bridge.bind("s", request(), context());
    const bad = bridge.submitHandoff("s", { summary: "x", branch: "vielleicht" });
    expect(bad.ok).toBe(false);
    expect(bridge.submitHandoff("s", { summary: "x", branch: "approved", branchReason: "r" })).toEqual({ ok: true });
    expect(bridge.info("s")).toMatchObject({ stepId: "step_1", systemPrompt: "Du bist Reviewer." });
    expect(bridge.guard("s", "shell", "git push origin")).toMatchObject({ allow: false });
    expect(bridge.guard("s", "shell", "git status")).toEqual({ allow: true });
    expect(bridge.context("s", "dokumente")).toContain("plan.md");
  });

  it("leitet Delegation an den Schritt weiter", async () => {
    const bridge = new WorkerBridge();
    const ctx = context();
    bridge.bind("s", request({ delegation: { allowed: [], mode: "optional", maxParallel: 2, remainingRuns: 3 } }), ctx);
    await bridge.delegate("s", [{ agent: "code-explorer", task: "x" }]);
    expect(ctx.delegate).toHaveBeenCalled();
    bridge.bind("t", request(), ctx);
    expect(() => bridge.delegate("t", [])).toThrow(/keine Sub-Agenten/);
  });

  it("mappt v2-Events", () => {
    expect(mapV2Event({ type: "session.tool.called", data: { sessionID: "s", tool: "read" } })?.activity).toMatchObject({ kind: "tool", tool: "read", status: "called" });
    expect(mapV2Event({ type: "session.text.ended", data: { sessionID: "s", text: "Hallo" } })?.activity).toEqual({ kind: "text", text: "Hallo" });
    expect(mapV2Event({ type: "session.idle", data: {} })).toBeUndefined();
  });

  it("findet JSON in Text", () => {
    expect(extractJson('blabla {"a":1} und ```json\n{"b":2}\n```')).toEqual({ b: 2 });
    expect(extractJson("nichts")).toBeUndefined();
  });
});

describe("Engine mit opencode-Runtime (gemockter v1-Server)", () => {
  it("führt einen Workflow vollständig über den Treiber aus", async () => {
    const h = createHarness();
    const client = v1Client(() => undefined);
    // Strukturierte Ausgabe passend zum jeweiligen Schema erzeugen
    client.session.prompt = async (p) => {
      const format = p.format as { schema: Record<string, unknown> } | undefined;
      return { data: { info: { tokens: { input: 1, output: 1 }, ...(format ? { structured: { ...(sampleFromSchema(format.schema) as object), summary: "fertig" } } : {}) }, parts: [] } };
    };
    const runtime = new OpencodeRuntime(new V1Driver(client), new WorkerBridge());
    const engine = new (await import("@aiflow/engine")).Engine({ ...h.engine.deps, runtime });
    const id = engine.start(h.spec("feature-triage"));
    const state = await engine.wait(id);
    expect(state.error).toBeUndefined();
    expect(state.status).toBe("completed");
    expect(Object.values(state.steps).find((s) => s.nodeId === "triage")?.votes).toHaveLength(3);
  });
});
