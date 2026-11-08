import type { Plugin } from "@opencode/plugin";
import { PluginOptionsSchema } from "../config/schema.ts";
import { ALL_TOOLS, Figr, TOOL } from "../figr.ts";
import { messageOf } from "../util/errors.ts";
import { consoleLogger, systemClock, type HostPorts, type Logger } from "./ports.ts";
import { TOOL_SPECS } from "./tools.ts";

type Context = Plugin.Context;
type Json = Parameters<Context["storage"]["set"]>[1];

const text = (content: string) => ({ content });

/** Aktion für Rückfragen an den Nutzer. Eigener Name, damit allgemeine Regeln sie nicht stillschweigend erlauben. */
export const CONFIRM_ACTION = "figr.confirm";

function logger(): Logger {
  return consoleLogger;
}

/** Bildet den opencode-v2-Plugin-Kontext auf die Ports ab (plan.md 14.3). */
export function portsFromContext(ctx: Context): HostPorts {
  return {
    directory: ctx.location.directory,
    clock: systemClock,
    log: logger(),
    storage: {
      get: (key) => ctx.storage.get(key),
      set: (key, value) => ctx.storage.set(key, value as Json),
    },
    agents: {
      list: async () => {
        const out = await ctx.agent.list();
        return out.data.map((a) => ({ id: a.id, mode: a.mode, hidden: a.hidden, permissions: a.permissions.map((p) => ({ action: p.action, resource: p.resource, effect: p.effect })) }));
      },
    },
    permission: {
      ask: async ({ sessionID, title, detail }) => {
        try {
          await ctx.permission.assert({ sessionID: sessionID, action: CONFIRM_ACTION, resources: [title], metadata: { title, detail, description: `${title}\n\n${detail}` } });
          return { approved: true };
        } catch (error) {
          // Ablehnung mit Feedback → Tool.Error mit Grund; einfache Ablehnung → Fehler ohne verwertbaren Text.
          const tagged = typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "Tool.Error";
          const message = messageOf(error).trim();
          return tagged && message ? { approved: false, feedback: message } : { approved: false };
        }
      },
    },
    sessions: {
      create: async ({ parentID, agent, title, directory }) => {
        const s = await ctx.session.create({ parentID, agent, title, ...(directory ? { location: { directory } } : {}) });
        return s.id;
      },
      prompt: async (sessionID, t) => {
        await ctx.session.prompt({ sessionID, text: t });
      },
      wait: async (sessionID, signal) => {
        if (signal.aborted) return;
        await Promise.race([
          ctx.session.wait({ sessionID }),
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      },
      interrupt: async (sessionID) => {
        await ctx.session.interrupt({ sessionID });
      },
      get: async (sessionID) => {
        const s = await ctx.session.get({ sessionID });
        return { id: s.id, directory: s.location.directory, ...(s.parentID ? { parentID: s.parentID } : {}), ...(s.agent ? { agent: s.agent } : {}) };
      },
      synthetic: async (sessionID, t, opts) => {
        await ctx.session.synthetic({ sessionID, text: t, resume: opts?.resume ?? false });
      },
      lastAssistant: async (sessionID) => {
        const messages = await ctx.session.context({ sessionID });
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m?.type !== "assistant") continue;
          const texts: string[] = [];
          const tools: string[] = [];
          for (const c of m.content) {
            if (c.type === "text") texts.push(c.text);
            else if (c.type === "tool") tools.push(c.name);
          }
          return { text: texts.join("\n"), tools };
        }
        return undefined;
      },
    },
  };
}

/** Setup für opencode v2: Tools, Hooks, Befehle und Ereignisse (plan.md 10, 12). */
export async function setupV2(ctx: Context): Promise<() => Promise<void>> {
  const options = PluginOptionsSchema.parse(ctx.options ?? {});
  const figr = new Figr(portsFromContext(ctx), { ...(options.profile ? { profile: options.profile } : {}), ...(options.config ? { config: options.config } : {}), ...(options.global === false ? { global: false } : {}) });
  await figr.start();
  const stop = new AbortController();

  await ctx.tool.transform((editor) => {
    for (const spec of TOOL_SPECS) {
      editor.add({
        name: spec.name,
        description: spec.description,
        input: spec.input,
        execute: async (input, c) => {
          const raw = (input ?? {}) as Record<string, unknown>;
          const progress = (message: string): void => void c.progress({ title: message }).catch(() => undefined);
          try {
            switch (spec.name) {
              case TOOL.status:
                return text(await figr.toolStatus(c.sessionID, c.agent));
              case TOOL.submit:
                return text(await figr.toolSubmit(c.sessionID, c.agent, raw));
              case TOOL.verdict:
                return text(await figr.toolVerdict(c.sessionID, c.agent, raw));
              case TOOL.report:
                return text(await figr.toolReport(c.sessionID, c.agent, raw));
              case TOOL.review:
                return text(await figr.toolReview(c.sessionID, c.agent, raw, c.signal, progress));
              case TOOL.plan:
                return text(await figr.toolPlan(c.sessionID, c.agent, raw, c.signal, progress));
              case TOOL.bestOfN:
                return text(await figr.toolBestOfN(c.sessionID, c.agent, raw, c.signal, progress));
              default:
                return text(`Unbekanntes FiGr-Tool ${spec.name}`);
            }
          } catch (error) {
            const m = messageOf(error);
            return text(m.startsWith("FiGr") ? m : `FiGr: ${m}`);
          }
        },
      });
    }
  });

  await ctx.permission.hook("evaluate", async (event) => {
    if (event.action === CONFIRM_ACTION) return;
    const result = await figr.evaluatePermission(event.sessionID, event.agent, event.action, event.resources);
    if (result.deny) {
      event.effect = "deny";
      event.message = result.deny;
    }
  });

  await ctx.tool.hook("execute.before", async (event) => {
    if (ALL_TOOLS.includes(event.tool)) return;
    const result = await figr.beforeTool(event.sessionID, event.agent, event.tool, event.input);
    if (result.input !== undefined) event.input = result.input;
  });

  await ctx.tool.hook("execute.after", async (event) => {
    if (ALL_TOOLS.includes(event.tool)) return;
    const output = event.status === "completed" ? resultText(event.result) : "";
    await figr.afterTool(event.sessionID, event.agent, event.tool, event.input, event.status === "completed", output);
  });

  await ctx.session.hook("context", async (event) => {
    const result = await figr.context(event.sessionID, event.agent);
    for (const name of ALL_TOOLS) if (!result.visible.includes(name)) Reflect.deleteProperty(event.tools, name);
    for (const [name, schema] of Object.entries(result.inputs)) {
      const tool = event.tools[name];
      if (tool) tool.input = schema;
    }
    if (result.system) event.system.unshift({ type: "text", text: result.system });
  });

  await ctx.session.hook("prompt", async (event) => {
    await figr.onUserPrompt(event.sessionID, event.prompt.text);
  });

  await ctx.session.hook("experimental.idle", async (event) => {
    const nudge = await figr.idle(event.sessionID, event.background);
    if (nudge) await ctx.session.synthetic({ sessionID: event.sessionID, text: nudge, delivery: "queue" });
  });

  await ctx.command.transform((editor) => {
    const commands: [string, string][] = [
      ["figr", "FiGr: Status anzeigen (/figr on | off schaltet FiGr für diese Session)"],
      ["figr-profile", "FiGr: Profil wechseln (/figr-profile <name>)"],
      ["figr-skip", "FiGr: Gate überspringen (mit Bestätigung, protokolliert)"],
      ["figr-reset", "FiGr: Gate zurücksetzen"],
      ["figr-findings", "FiGr: offene Befunde anzeigen"],
    ];
    for (const [name, description] of commands) {
      editor.add({
        name,
        description,
        execute: async ({ sessionID, prompt }) => {
          const out = await figr.command(name, sessionID, prompt.text).catch((e: unknown) => `FiGr: ${messageOf(e)}`);
          await ctx.session.synthetic({ sessionID, text: out, resume: false });
        },
      });
    }
  });

  // Kind-Sessions früh zuordnen (plan.md 10.5); Fehler im Ereignisstrom sind nicht fatal (Fallback: lazy über session.get).
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ["session.created"] })) {
        if (stop.signal.aborted) break;
        const data = (event as { data?: { sessionID?: string; parentID?: string; agent?: string } }).data;
        if (data?.sessionID) await figr.onSessionCreated(data.sessionID, data.parentID, data.agent).catch(() => undefined);
      }
    } catch (error) {
      consoleLogger.warn("Ereignisstrom beendet", { error: messageOf(error) });
    }
  })();

  return async () => {
    stop.abort();
    await figr.stop();
  };
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
  return "";
}
