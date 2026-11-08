import type { Plugin } from "@opencode/plugin";
import { resolveOptions, workerEnv } from "../core/config.js";
import { BridgeService } from "../core/bridge.js";
import { ASK_TOOL, CONTEXT_TOOL, DELEGATE_TOOL, delegateSchema, HANDOFF_TOOL, PROGRESS_TOOL, visibleWorkerTools, WORKER_TOOL_NAMES, LIST_WORKFLOWS_TOOL, RUN_TOOL } from "../core/tools.js";
import { WorkerApi } from "../core/worker.js";
import { WorkerHooks } from "../core/worker-hooks.js";

type Context = Plugin.Context;

const text = (content: string) => ({ content });

/** opencode v2: Registrierung über die Domänen des Kontexts (PLAN.md 5.5.3, 9.3, 10). */
export async function setupV2(ctx: Context): Promise<() => void> {
  const worker = workerEnv();
  if (worker) return setupWorker(ctx, new WorkerHooks(new WorkerApi(worker)));
  return setupBridge(ctx);
}

async function setupWorker(ctx: Context, hooks: WorkerHooks): Promise<() => void> {
  await ctx.tool.transform((editor) => {
    editor.add({ name: HANDOFF_TOOL.name, description: HANDOFF_TOOL.description, input: HANDOFF_TOOL.input, execute: async (input, c) => text(await hooks.handoff(c.sessionID, input)) });
    editor.add({ name: DELEGATE_TOOL.name, description: DELEGATE_TOOL.description, input: DELEGATE_TOOL.input, execute: async (input, c) => text(await hooks.delegate(c.sessionID, input)) });
    editor.add({ name: PROGRESS_TOOL.name, description: PROGRESS_TOOL.description, input: PROGRESS_TOOL.input, execute: async (input, c) => text(await hooks.progress(c.sessionID, input)) });
    editor.add({ name: CONTEXT_TOOL.name, description: CONTEXT_TOOL.description, input: CONTEXT_TOOL.input, execute: async (input, c) => text(await hooks.context(c.sessionID, input)) });
    editor.add({ name: ASK_TOOL.name, description: ASK_TOOL.description, input: ASK_TOOL.input, execute: async (input, c) => text(await hooks.ask(c.sessionID, input)) });
  });
  await ctx.tool.hook("execute.before", async (event) => {
    await hooks.guard(event.sessionID, event.tool, event.input);
  });
  await ctx.permission.hook("evaluate", async (event) => {
    const result = await hooks.evaluate(event.sessionID, event.action, event.resources);
    if (result.deny) {
      event.effect = "deny";
      if (result.message) event.message = result.message;
    }
  });
  await ctx.session.hook("context", async (event) => {
    const info = await hooks.info(event.sessionID);
    const visible = visibleWorkerTools(info);
    for (const name of WORKER_TOOL_NAMES) if (!visible.has(name)) Reflect.deleteProperty(event.tools, name);
    // Kind-Sessions nativer Sub-Agenten behalten ihren eigenen Prompt; es gelten nur die Regeln des Schritts.
    if (!info || info.subSession) return;
    event.system.unshift({ type: "text", text: info.systemPrompt });
    const handoff = event.tools[HANDOFF_TOOL.name];
    if (handoff) handoff.input = info.handoffSchema;
    const delegate = event.tools[DELEGATE_TOOL.name];
    if (delegate && info.delegation) delegate.input = delegateSchema(info.delegation.allowed.map((a) => a.id));
    if (info.temperature !== undefined) event.options.temperature = info.temperature;
    if (info.topP !== undefined) event.options.topP = info.topP;
  });
  await ctx.session.hook("experimental.idle", async (event) => {
    const nudge = await hooks.idleNudge(event.sessionID);
    if (nudge) await ctx.session.synthetic({ sessionID: event.sessionID, text: nudge, delivery: "queue" });
  });
  await ctx.session.hook("compaction", async (event) => {
    const extra = await hooks.compactionContext(event.sessionID);
    if (extra) event.system.push({ type: "text", text: extra });
  });
  await ctx.shell.hook("create.before", async (event) => {
    Object.assign(event.env, await hooks.env(sessionOf(event)));
  });
  return () => undefined;
}

function sessionOf(event: unknown): string | undefined {
  const value = (event as { sessionID?: unknown }).sessionID;
  return typeof value === "string" ? value : undefined;
}

async function setupBridge(ctx: Context): Promise<() => void> {
  const options = resolveOptions(ctx.options);
  const bridge = new BridgeService(options, ctx.location.directory);
  await bridge.init().catch(() => undefined);
  const stop = new AbortController();

  await ctx.command.transform((editor) => {
    editor.add({
      name: "aiflow-configure",
      description: "AiFlow: Web-UI für Agenten und Workflows öffnen",
      execute: async ({ sessionID }) => {
        const url = await bridge.configureUrl();
        bridge.openBrowser(url);
        await ctx.session.synthetic({ sessionID, text: `AiFlow-Konfiguration geöffnet: ${url}`, resume: false });
      },
    });
    for (const w of bridge.workflows) {
      editor.add({
        name: w.command,
        description: `AiFlow: ${w.description}`,
        // Kein LLM-Aufruf: Der Prompt geht unverändert an AiFlow.
        execute: async ({ sessionID, prompt }) => {
          const runId = await bridge.start(w.id, prompt.text);
          await ctx.session.synthetic({ sessionID, text: `AiFlow-Run ${runId} („${w.name}“) gestartet. Fortschritt im AiFlow-Panel (/aiflow-status).`, resume: false });
        },
      });
    }
  });

  if (options.agentTools) {
    await ctx.tool.transform((editor) => {
      editor.add({ name: LIST_WORKFLOWS_TOOL.name, description: LIST_WORKFLOWS_TOOL.description, input: LIST_WORKFLOWS_TOOL.input, execute: async () => text(JSON.stringify(await bridge.refreshWorkflows(), null, 2)) });
      editor.add({
        name: RUN_TOOL.name,
        description: RUN_TOOL.description,
        input: RUN_TOOL.input,
        execute: async (input) => {
          const { workflow, prompt } = input as { workflow: string; prompt: string };
          const w = bridge.workflowForCommand(workflow);
          return text(w ? `AiFlow-Run ${await bridge.start(w.id, prompt, "api")} gestartet.` : `Unbekannter Workflow „${workflow}“.`);
        },
      });
    });
  }

  bridge.watch((event) => {
    if (event.type !== "definitions.changed" || event.kind !== "workflows") return;
    void bridge.refreshWorkflows().then(() => ctx.command.reload());
  }, stop.signal);
  return () => stop.abort();
}
