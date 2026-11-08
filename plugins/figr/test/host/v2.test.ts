import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, it } from "vitest";
import plugin from "../../server.ts";
import { ALL_TOOLS } from "../../src/figr.ts";
import { AGENTS, gitRepo, testConfigRaw } from "../fake-host.ts";

type Handler = (event: Record<string, unknown>) => Promise<void>;

function mockContext(dir: string) {
  const hooks = new Map<string, Handler>();
  const tools = new Map<string, { execute: (input: unknown, c: unknown) => Promise<{ content: string }> }>();
  const commands = new Map<string, (i: unknown) => Promise<void>>();
  const synthetic: Record<string, unknown>[] = [];
  const storage = new Map<string, unknown>();
  const sessions: Record<string, { id: string; parentID?: string; agent?: string; location: { directory: string } }> = {
    root: { id: "root", agent: "orchestrator", location: { directory: dir } },
    other: { id: "other", agent: "build", location: { directory: dir } },
  };
  const register = (domain: string) => async (name: string, fn: Handler) => void hooks.set(`${domain}.${name}`, fn);
  const ctx = {
    location: { directory: dir },
    options: { global: false },
    agent: { list: async () => ({ data: AGENTS.map((a) => ({ ...a, name: a.id, hidden: false, request: {}, permissions: a.permissions ?? [] })) }) },
    storage: { get: async (k: string) => storage.get(k), set: async (k: string, v: unknown) => void storage.set(k, v) },
    tool: {
      transform: async (fn: (e: { add: (t: { name: string; execute: never }) => void }) => void) => fn({ add: (t) => void tools.set(t.name, t) }),
      hook: register("tool"),
    },
    permission: { hook: register("permission"), assert: async () => undefined },
    session: {
      hook: register("session"),
      synthetic: async (i: Record<string, unknown>) => void synthetic.push(i),
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions[sessionID];
        if (!s) throw new Error("unknown");
        return s;
      },
      context: async () => [],
    },
    command: { transform: async (fn: (e: { add: (c: { name: string; execute: (i: unknown) => Promise<void> }) => void }) => void) => fn({ add: (c) => void commands.set(c.name, c.execute) }) },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
      }),
    },
  };
  return { ctx: ctx as unknown as Plugin.Context, hooks, tools, commands, synthetic };
}

describe("opencode-v2-Adapter", () => {
  it("registriert Tools, Hooks und Befehle und setzt Regeln durch", async () => {
    const dir = gitRepo();
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", "figr.jsonc"), `// FiGr\n${JSON.stringify(testConfigRaw(), null, 2)}`);
    const m = mockContext(dir);
    const cleanup = await plugin.setup(m.ctx);

    expect([...m.tools.keys()].sort()).toEqual([...ALL_TOOLS].sort());
    expect([...m.hooks.keys()].sort()).toEqual(["permission.evaluate", "session.context", "session.experimental.idle", "session.prompt", "tool.execute.after", "tool.execute.before"]);
    expect([...m.commands.keys()]).toEqual(["figr", "figr-profile", "figr-skip", "figr-reset", "figr-findings"]);

    // evaluate: deny + message
    const ev: Record<string, unknown> = { sessionID: "root", agent: "orchestrator", action: "edit", resources: ["app.js"], effect: "allow" };
    await m.hooks.get("permission.evaluate")!(ev);
    expect(ev.effect).toBe("deny");
    expect(ev.message).toContain("ändert keine Dateien");

    // execute.before: wirft
    await expect(m.hooks.get("tool.execute.before")!({ tool: "subagent", sessionID: "root", agent: "orchestrator", input: { agent: "implementer", prompt: "x" } })).rejects.toThrow(/gehört zu Gate/);

    // context: Orchestrator sieht seine Tools + Systemblock, fremde Session keine FiGr-Tools
    const toolsFor = () => Object.fromEntries(ALL_TOOLS.map((n) => [n, { description: "", input: {} }]));
    const c1 = { sessionID: "root", agent: "orchestrator", tools: toolsFor(), system: [] as { text: string }[], options: {} };
    await m.hooks.get("session.context")!(c1);
    expect(Object.keys(c1.tools).sort()).toEqual(["figr_best_of_n", "figr_plan", "figr_review", "figr_status", "figr_submit"]);
    expect(c1.system[0]?.text).toContain("FiGr guardrails");
    const c2 = { sessionID: "other", agent: "build", tools: { ...toolsFor(), skill_search: { description: "", input: {} } }, system: [], options: {} };
    await m.hooks.get("session.context")!(c2);
    expect(Object.keys(c2.tools)).toEqual(["skill_search"]);

    // idle: Stop-Guard über synthetic (queue)
    await m.hooks.get("session.experimental.idle")!({ sessionID: "root", background: [] });
    expect(m.synthetic[0]).toMatchObject({ sessionID: "root", delivery: "queue" });

    // Tool-Ausführung und Befehl
    const status = await m.tools.get("figr_status")!.execute({}, { sessionID: "root", agent: "orchestrator", signal: new AbortController().signal, progress: async () => undefined });
    expect(status.content).toContain("FiGr · strict");
    const wrong = await m.tools.get("figr_verdict")!.execute({ verdict: "approved", summary: "x" }, { sessionID: "root", agent: "orchestrator", signal: new AbortController().signal, progress: async () => undefined });
    expect(wrong.content).toContain("nur für Reviewer");
    await m.commands.get("figr")!({ sessionID: "root", prompt: { text: "" } });
    expect(m.synthetic.at(-1)).toMatchObject({ sessionID: "root", resume: false });

    if (typeof cleanup === "function") await cleanup();
  });
});
