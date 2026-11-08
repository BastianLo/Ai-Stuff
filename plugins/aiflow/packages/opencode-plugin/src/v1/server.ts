import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { resolveOptions, workerEnv } from "../core/config.js";
import { BridgeService, COMMAND_PREFIX } from "../core/bridge.js";
import { WorkerApi } from "../core/worker.js";
import { WorkerHooks } from "../core/worker-hooks.js";
import { ASK_TOOL } from "../core/tools.js";

/** opencode v1: `server()` liefert ein Hooks-Objekt (PLAN.md 5.5.3). */
export async function serverV1(input: PluginInput, rawOptions?: unknown): Promise<Hooks> {
  const { tool } = await import("@opencode-ai/plugin");
  const z = tool.schema;
  const worker = workerEnv();
  if (worker) {
    const hooks = new WorkerHooks(new WorkerApi(worker));
    return {
      tool: {
        aiflow_delegate: tool({
          description: "AiFlow: Startet eine Welle von Teilaufgaben bei erlaubten Sub-Agenten und liefert alle Ergebnisse gesammelt zurück.",
          args: { tasks: z.array(z.object({ agent: z.string(), task: z.string(), expectedResult: z.string().optional() })).min(1) },
          execute: (args, ctx) => hooks.delegate(ctx.sessionID, args, ctx.abort),
        }),
        aiflow_ask: tool({
          description: ASK_TOOL.description,
          args: { question: z.string(), options: z.array(z.string()).optional() },
          execute: (args, ctx) => hooks.ask(ctx.sessionID, args, ctx.abort),
        }),
        aiflow_progress: tool({
          description: "AiFlow: Kurze Statusmeldung für den Nutzer.",
          args: { message: z.string() },
          execute: (args, ctx) => hooks.progress(ctx.sessionID, args),
        }),
        aiflow_context: tool({
          description: "AiFlow: Abschnitte des Auftrags und der Übergaben nachschlagen.",
          args: { query: z.string().optional() },
          execute: (args, ctx) => hooks.context(ctx.sessionID, args),
        }),
      },
      "tool.execute.before": async (i, o) => {
        await hooks.guard(i.sessionID, i.tool, o.args);
      },
      "chat.params": async (i, o) => {
        const info = await hooks.info(i.sessionID);
        if (!info || info.subSession) return;
        if (info.temperature !== undefined) o.temperature = info.temperature;
        if (info.topP !== undefined) o.topP = info.topP;
      },
      "shell.env": async (i, o) => {
        Object.assign(o.env, await hooks.env(i.sessionID));
      },
      "experimental.session.compacting": async (i, o) => {
        const extra = await hooks.compactionContext(i.sessionID);
        if (extra) o.context.push(extra);
      },
    };
  }

  // Bridge-Rolle
  const options = resolveOptions(rawOptions);
  const bridge = new BridgeService(options, input.worktree || input.directory);
  await bridge.init().catch(() => undefined);
  const hooks: Hooks = {
    config: async (config) => {
      const commands = (config.command ??= {});
      commands["aiflow-configure"] = { template: "AiFlow-Konfiguration geöffnet.", description: "AiFlow: Web-UI für Agenten und Workflows öffnen" };
      for (const w of bridge.workflows) commands[w.command] = { template: "$ARGUMENTS", description: `AiFlow: ${w.description}` };
    },
    "command.execute.before": async (i, o) => {
      let note: string | undefined;
      if (i.command === "aiflow-configure") {
        const url = await bridge.configureUrl();
        bridge.openBrowser(url);
        note = `AiFlow-Konfiguration geöffnet: ${url}`;
      } else if (i.command.startsWith(COMMAND_PREFIX)) {
        const workflow = bridge.workflowForCommand(i.command);
        if (!workflow) note = `AiFlow: Workflow für /${i.command} nicht gefunden.`;
        else {
          const runId = await bridge.start(workflow.id, i.arguments);
          note = `AiFlow-Run ${runId} („${workflow.name}“) gestartet. Fortschritt in der Seitenleiste und unter ${options.url}/runs/${runId}. Antworte nur mit „Gestartet.“`;
        }
      }
      if (note === undefined) return;
      for (const part of o.parts) if (part.type === "text") part.text = note;
    },
  };
  if (options.agentTools) {
    hooks.tool = {
      aiflow_list_workflows: tool({
        description: "Listet die AiFlow-Workflows dieses Projekts.",
        args: {},
        execute: async () => JSON.stringify(await bridge.refreshWorkflows(), null, 2),
      }),
      aiflow_run: tool({
        description: "Startet einen AiFlow-Workflow. Den Auftrag des Nutzers unverändert übernehmen.",
        args: { workflow: z.string(), prompt: z.string() },
        execute: async (args) => {
          const w = bridge.workflowForCommand(args.workflow);
          if (!w) return `Unbekannter Workflow „${args.workflow}“.`;
          return `AiFlow-Run ${await bridge.start(w.id, args.prompt, "api")} gestartet.`;
        },
      }),
    };
  }
  return hooks;
}
