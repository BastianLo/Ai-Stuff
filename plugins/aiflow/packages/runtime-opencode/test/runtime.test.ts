import { describe, expect, it, vi } from "vitest";
import type { AgentStepContext, AgentStepRequest } from "@aiflow/engine";
import { agentSchema, buildHandoffSchema } from "@aiflow/core";
import { createHarness, sampleFromSchema } from "@aiflow/testkit";
import { expandMcpRules, extractJson, mapV1Event, mapV2Event, mcpToolPrefix, OpencodeRuntime, PERMISSION_OPTIONS, toV1Rules, toV2Rules, V1Driver, V2Driver, WorkerBridge, type V1Client, type V2Client } from "@aiflow/runtime-opencode";

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
    permission: { reply: async (p) => (calls.push({ reply: p }), { data: true }) },
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
    expect(mapV1Event({ type: "message.part.updated", properties: { part: { sessionID: "s", type: "text", text: "fertig", time: { end: 1 } } } })).toEqual({ sessionId: "s", activity: { kind: "text", text: "fertig" } });
    expect(mapV1Event({ type: "session.created", properties: { sessionID: "c", info: { id: "c", parentID: "p" } } })).toEqual({ type: "session.created", sessionId: "c", parentId: "p" });
    expect(mapV1Event({ type: "session.created", properties: { sessionID: "x", info: { id: "x" } } })).toBeUndefined();
    expect(mapV1Event({ type: "permission.asked", properties: { id: "per_1", sessionID: "s", permission: "external_directory", patterns: ["/etc/*"], metadata: {}, always: [] } })).toEqual({
      type: "permission.asked",
      sessionId: "s",
      requestId: "per_1",
      action: "external_directory",
      resources: ["/etc/*"],
    });
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
      permission: { reply: async (i) => void calls.push({ reply: i }) },
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
    expect(vi.mocked(ctx).delegate.mock.calls).toHaveLength(1);
    bridge.bind("t", request(), ctx);
    expect(() => bridge.delegate("t", [])).toThrow(/keine Sub-Agenten/);
  });

  it("mappt v2-Events", () => {
    expect(mapV2Event({ type: "session.tool.called", data: { sessionID: "s", tool: "read" } })).toMatchObject({ activity: { kind: "tool", tool: "read", status: "called" } });
    expect(mapV2Event({ type: "session.text.ended", data: { sessionID: "s", text: "Hallo" } })).toEqual({ sessionId: "s", activity: { kind: "text", text: "Hallo" } });
    expect(mapV2Event({ type: "session.created", data: { sessionID: "c", parentID: "p" } })).toEqual({ type: "session.created", sessionId: "c", parentId: "p" });
    expect(mapV2Event({ type: "permission.asked", data: { id: "per_2", sessionID: "s", action: "skill_search", resources: ["*"] } })).toEqual({
      type: "permission.asked",
      sessionId: "s",
      requestId: "per_2",
      action: "skill_search",
      resources: ["*"],
    });
    expect(mapV2Event({ type: "session.idle", data: {} })).toBeUndefined();
  });

  it("findet JSON in Text", () => {
    expect(extractJson('blabla {"a":1} und ```json\n{"b":2}\n```')).toEqual({ b: 2 });
    expect(extractJson("nichts")).toBeUndefined();
  });
});

describe("Rückfragen von opencode und native Sub-Agenten", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const asked = (sessionId: string, requestId: string, action = "external_directory", resources = ["/home/u/notes/*"]) => ({ type: "permission.asked" as const, sessionId, requestId, action, resources });

  function setup(onAsk: "inbox" | "allow" | "deny", answers: string[] = []) {
    const client = v1Client(() => undefined);
    const bridge = new WorkerBridge();
    const runtime = new OpencodeRuntime(new V1Driver(client), bridge);
    const ask = vi.fn(async () => answers.shift() ?? PERMISSION_OPTIONS.reject);
    const ctx = { ...context(), ask };
    const agent = agentSchema.parse({ id: "impl", name: "Implementer", permissions: { preset: "implement", onAsk } });
    bridge.bind("ses_step", request({ agent }), ctx);
    const replies = () => client.calls.filter((c) => c.reply).map((c) => c.reply as Record<string, unknown>);
    return { client, bridge, runtime, ask, replies };
  }

  it("onAsk=allow erlaubt einmalig, onAsk=deny lehnt mit Begründung für das Modell ab", async () => {
    const allow = setup("allow");
    allow.runtime.handle(asked("ses_step", "per_1"));
    await flush();
    expect(allow.replies()).toEqual([{ requestID: "per_1", reply: "once", directory: "/tmp/ws" }]);
    const deny = setup("deny");
    deny.runtime.handle(asked("ses_step", "per_2"));
    await flush();
    expect(deny.replies()[0]).toMatchObject({ requestID: "per_2", reply: "reject", message: expect.stringContaining("nicht freigegeben") });
    expect(deny.ask).not.toHaveBeenCalled();
  });

  it("onAsk=inbox fragt den Nutzer; „für diesen Schritt“ gilt für weitere gleiche Aktionen, Freitext wird zur Korrektur", async () => {
    const t = setup("inbox", [PERMISSION_OPTIONS.step, "Nicht dort – nimm docs/notes im Repo."]);
    t.runtime.handle(asked("ses_step", "per_1"));
    await flush();
    expect(t.ask).toHaveBeenCalledWith(expect.objectContaining({ kind: "permission", options: Object.values(PERMISSION_OPTIONS) }));
    t.runtime.handle(asked("ses_step", "per_2", "external_directory", ["/other/*"]));
    await flush();
    expect(t.ask).toHaveBeenCalledTimes(1);
    t.runtime.handle(asked("ses_step", "per_3", "read", [".env"]));
    await flush();
    expect(t.replies()).toEqual([
      { requestID: "per_1", reply: "once", directory: "/tmp/ws" },
      { requestID: "per_2", reply: "once", directory: "/tmp/ws" },
      { requestID: "per_3", reply: "reject", directory: "/tmp/ws", message: expect.stringContaining("Nicht dort") },
    ]);
  });

  it("ignoriert Rückfragen fremder Sessions", async () => {
    const t = setup("allow");
    t.runtime.handle(asked("ses_fremd", "per_9"));
    await flush();
    expect(t.replies()).toEqual([]);
  });

  it("ordnet Kind-Sessions nativer Sub-Agenten dem Schritt zu: Regeln, Rückfragen, kein AiFlow-Prompt", async () => {
    const t = setup("allow");
    t.runtime.handle({ type: "session.created", sessionId: "ses_child", parentId: "ses_step" });
    t.runtime.handle({ type: "session.created", sessionId: "ses_grandchild", parentId: "ses_child" });
    t.runtime.handle({ type: "session.created", sessionId: "ses_other", parentId: "ses_unbekannt" });
    expect(t.bridge.info("ses_grandchild")).toMatchObject({ stepId: "step_1", subSession: true });
    expect(t.bridge.info("ses_step").subSession).toBe(false);
    expect(t.bridge.has("ses_other")).toBe(false);
    expect(t.bridge.guard("ses_child", "shell", "git push origin")).toMatchObject({ allow: false });
    t.runtime.handle(asked("ses_child", "per_c"));
    await flush();
    expect(t.replies()).toEqual([{ requestID: "per_c", reply: "once", directory: "/tmp/ws" }]);
    expect(() => t.bridge.submitHandoff("ses_child", {})).toThrow(/keinem laufenden/);
    t.bridge.unbind("ses_step");
    expect(t.bridge.has("ses_child")).toBe(false);
  });

  it("leitet Aktivität der Kind-Sessions an den Schritt weiter und beantwortet Rückfragen per v2-API", async () => {
    const bridge = new WorkerBridge();
    const calls: Record<string, unknown>[] = [];
    const client = { permission: { reply: async (i: Record<string, unknown>) => void calls.push(i) } } as unknown as V2Client;
    const runtime = new OpencodeRuntime(new V2Driver({ ...client, event: { subscribe: () => (async function* () {})() } }), bridge);
    bridge.bind("s", request({ agent: agentSchema.parse({ id: "a", name: "A", permissions: { onAsk: "allow" } }) }), context());
    runtime.handle({ type: "session.created", sessionId: "c", parentId: "s" });
    runtime.handle(asked("c", "per_v2"));
    await flush();
    expect(calls).toEqual([{ sessionID: "c", requestID: "per_v2", decision: "once" }]);
  });

  it("Rückfragen an den Nutzer (aiflow_ask) gehen in die Inbox – auch aus Kind-Sessions, abschaltbar pro Agent", async () => {
    const t = setup("inbox", ["Variante B"]);
    t.runtime.handle({ type: "session.created", sessionId: "ses_child", parentId: "ses_step" });
    expect(await t.bridge.ask("ses_child", "A oder B?", ["A", "B"])).toBe("Variante B");
    const off = new WorkerBridge();
    off.bind("x", request({ agent: agentSchema.parse({ id: "a", name: "A", permissions: { questions: false } }) }), context());
    expect(() => off.ask("x", "?", [])).toThrow(/abgeschaltet/);
  });
});

describe("MCP-Rechte", () => {
  const servers = ["context7", "github", "jira.cloud"];

  it("bildet mcp-Regeln auf die Tool-Namen <server>_* ab (Reihenfolge bleibt)", () => {
    expect(mcpToolPrefix("jira.cloud")).toBe("jira_cloud");
    const rules = expandMcpRules(
      [
        { action: "read", resource: "*", effect: "allow" },
        { action: "mcp", resource: "*", effect: "deny" },
        { action: "mcp", resource: "github", effect: "allow" },
        { action: "mcp", resource: "neu", effect: "allow" },
        { action: "mcp", resource: "jira*", effect: "deny" },
      ],
      servers,
    );
    expect(rules).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "context7_*", resource: "*", effect: "deny" },
      { action: "github_*", resource: "*", effect: "deny" },
      { action: "jira_cloud_*", resource: "*", effect: "deny" },
      { action: "github_*", resource: "*", effect: "allow" },
      { action: "neu_*", resource: "*", effect: "allow" },
      { action: "jira_cloud_*", resource: "*", effect: "deny" },
    ]);
    expect(toV1Rules(rules)[1]).toEqual({ permission: "context7_*", pattern: "*", action: "deny" });
    expect(toV2Rules(rules)[4]).toEqual({ action: "github_*", resource: "*", effect: "allow" });
  });

  it("setzt die aufgelösten Regeln in der Session und in der harten Prüfung der Bridge", async () => {
    const client = v1Client(() => ({ summary: "s", branch: "approved", branchReason: "r" }));
    const directories: unknown[] = [];
    client.mcp.status = async (p) => (directories.push(p), { data: { github: { status: "connected" }, context7: { status: "connected" } } });
    const bridge = new WorkerBridge();
    let guarded: unknown[] = [];
    const runtime = new OpencodeRuntime(new V1Driver(client), bridge);
    const prompt = client.session.prompt.bind(client.session);
    client.session.prompt = async (p, o) => {
      guarded = [bridge.guard(String(p.sessionID), "github_create_issue", "*"), bridge.guard(String(p.sessionID), "context7_query", "*")];
      return prompt(p, o);
    };
    const permissions = [{ action: "mcp", resource: "*", effect: "allow" as const }, { action: "mcp", resource: "github", effect: "deny" as const }];
    await runtime.runAgentStep(request({ permissions }), context());
    expect(directories).toEqual([{ directory: "/tmp/ws" }]);
    const create = client.calls[0]?.create as Record<string, unknown>;
    expect(create.permission).toEqual([
      { permission: "github_*", pattern: "*", action: "allow" },
      { permission: "context7_*", pattern: "*", action: "allow" },
      { permission: "github_*", pattern: "*", action: "deny" },
    ]);
    expect(guarded).toEqual([{ allow: false, message: expect.stringContaining("github_create_issue") }, { allow: true }]);
  });

  it("liest die v2-MCP-Liste ({ location, data }, Status als Objekt) pro Verzeichnis", async () => {
    const inputs: unknown[] = [];
    const client = {
      mcp: { list: async (i?: Record<string, unknown>) => (inputs.push(i), { location: { directory: "/p" }, data: [{ name: "github", status: { status: "connected" } }, { name: "jira", status: { status: "failed", error: "x" } }] }) },
    } as unknown as V2Client;
    expect(await new V2Driver(client).listMcp("/p")).toEqual([{ name: "github", status: "connected" }, { name: "jira", status: "failed" }]);
    expect(inputs).toEqual([{ location: { directory: "/p" } }]);
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
