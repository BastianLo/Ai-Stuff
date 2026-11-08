import { AiflowError, splitModelRef } from "@aiflow/core";
import type { RuntimeCapabilities, StepActivity } from "@aiflow/engine";
import type { CreateSessionOptions, ModelInfo, OpencodeDriver, RunOptions, RunResult, DriverEvent, PermissionReply } from "../common/driver.js";
import { toV2Rules } from "../common/permissions.js";
import { num, obj, str } from "../common/util.js";

/** Die Teilmenge der v2-API (`@opencode/client`), die AiFlow nutzt. */
export interface V2Client {
  server: { info(): Promise<unknown> };
  session: {
    create(input: Record<string, unknown>): Promise<unknown>;
    prompt(input: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
    fork(input: Record<string, unknown>): Promise<unknown>;
    interrupt(input: Record<string, unknown>): Promise<unknown>;
    get(input: Record<string, unknown>): Promise<unknown>;
  };
  experimental: { session: { wait(input: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> } };
  message: { list(input: Record<string, unknown>): Promise<unknown> };
  event: { subscribe(input?: Record<string, unknown>, opts?: { signal?: AbortSignal }): AsyncIterable<unknown> };
  model: { list(input?: Record<string, unknown>): Promise<unknown> };
  plugin: { list(input?: Record<string, unknown>): Promise<unknown> };
  mcp?: { list(input?: Record<string, unknown>): Promise<unknown> };
  permission: { reply(input: { sessionID: string; requestID: string; decision: "once" | "always" | "reject"; message?: string }): Promise<unknown> };
}

/**
 * Treiber für opencode v2 (≥ 2.2). Kein `format` mehr: Die Übergabe kommt über das Tool `aiflow_handoff` des Plugins.
 * Sessions nutzen den Standard-Agenten; der AiFlow-System-Prompt wird vom Plugin per `session.hook("context")`
 * vorangestellt (Session-ID → Worker-API).
 */
export class V2Driver implements OpencodeDriver {
  readonly api = "v2" as const;

  constructor(private readonly client: V2Client) {}

  capabilities(): RuntimeCapabilities {
    return { structuredOutput: "tool", sessionFork: true, userQuestions: "form" };
  }

  async health(): Promise<{ version: string }> {
    return { version: str(obj(await this.client.server.info()).version) ?? "2.x" };
  }

  async createSession(o: CreateSessionOptions): Promise<string> {
    const model = o.model ? splitModelRef(o.model.ref) : undefined;
    const info = obj(
      await this.client.session.create({
        title: o.title,
        location: { directory: o.directory },
        metadata: o.metadata,
        permissions: toV2Rules(o.permissions),
        ...(model ? { model: { id: model.modelID, providerID: model.providerID, ...(o.model?.variant ? { variant: o.model.variant } : {}) } } : {}),
        ...(o.parentSessionId ? { parentID: o.parentSessionId } : {}),
      }),
    );
    const id = str(info.id);
    if (!id) throw new AiflowError("RUNTIME", "opencode v2: session.create lieferte keine ID.");
    return id;
  }

  async forkSession(sessionId: string): Promise<string> {
    const id = str(obj(await this.client.session.fork({ sessionID: sessionId })).id);
    if (!id) throw new AiflowError("RUNTIME", "opencode v2: session.fork lieferte keine ID.");
    return id;
  }

  async run(sessionId: string, o: RunOptions, signal: AbortSignal): Promise<RunResult> {
    const before = obj(await this.client.session.get({ sessionID: sessionId }));
    await this.client.session.prompt({ sessionID: sessionId, text: o.text, delivery: "queue" }, { signal });
    await this.client.experimental.session.wait({ sessionID: sessionId }, { signal });
    const after = obj(await this.client.session.get({ sessionID: sessionId }));
    if (after.outcome === "failed") throw new AiflowError("RUNTIME", "opencode v2: Ausführung der Session fehlgeschlagen.");
    const messages = obj(await this.client.message.list({ sessionID: sessionId, type: "assistant", order: "desc", limit: 1 }));
    const list = Array.isArray(messages.data) ? messages.data : Array.isArray(messages.items) ? messages.items : [];
    const text = textOf(list[0]);
    const tb = obj(before.tokens);
    const ta = obj(after.tokens);
    return { text, usage: { inputTokens: Math.max(0, num(ta.input) - num(tb.input)), outputTokens: Math.max(0, num(ta.output) - num(tb.output)) } };
  }

  async abort(sessionId: string): Promise<void> {
    await this.client.session.interrupt({ sessionID: sessionId, resume: false });
  }

  async replyPermission(o: { sessionId: string; requestId: string; reply: PermissionReply; message?: string }): Promise<void> {
    await this.client.permission.reply({ sessionID: o.sessionId, requestID: o.requestId, decision: o.reply, ...(o.message ? { message: o.message } : {}) });
  }

  async *activity(signal: AbortSignal): AsyncIterable<DriverEvent> {
    const types = ["session.text.ended", "session.tool.called", "session.tool.success", "session.tool.failed", "session.tool.progress", "session.created", "permission.asked"];
    for await (const raw of this.client.event.subscribe({ types }, { signal })) {
      const mapped = mapV2Event(raw);
      if (mapped) yield mapped;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.client.model.list();
    const list = Array.isArray(data) ? data : Array.isArray(obj(data).data) ? (obj(data).data as unknown[]) : [];
    return list.map((m) => {
      const model = obj(m);
      return { providerID: str(model.providerID) ?? "", modelID: str(model.id) ?? "", name: str(model.name) ?? str(model.id) ?? "" };
    });
  }

  async listMcp(directory?: string): Promise<{ name: string; status: string }[]> {
    if (!this.client.mcp) return [];
    // Antwort: `{ location, data: McpServer[] }`, Status als `{ status: "connected" | … }`
    const data = await this.client.mcp.list(directory ? { location: { directory } } : undefined);
    const raw = Array.isArray(data) ? data : obj(data).data;
    const list: unknown[] = Array.isArray(raw) ? raw : [];
    return list.map((s) => {
      const server = obj(s);
      return { name: str(server.name) ?? "", status: str(server.status) ?? str(obj(server.status).status) ?? "unknown" };
    });
  }

  async listPlugins(): Promise<string[]> {
    const data = await this.client.plugin.list();
    const list = Array.isArray(data) ? data : Array.isArray(obj(data).data) ? (obj(data).data as unknown[]) : [];
    return list.map((p) => str(obj(p).id) ?? "");
  }
}

function textOf(message: unknown): string {
  const m = obj(message);
  const content = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
  const parts = content.map((c) => obj(c)).filter((c) => c.type === "text").map((c) => str(c.text) ?? "");
  return parts.length > 0 ? parts.join("\n") : (str(m.text) ?? "");
}

/** v2-Events → Aktivität. */
export function mapV2Event(raw: unknown): DriverEvent | undefined {
  const event = obj(raw);
  const data = obj(event.data ?? event.properties);
  const sessionId = str(data.sessionID);
  if (!sessionId) return undefined;
  const type = str(event.type) ?? "";
  if (type === "session.created") {
    const parentId = str(data.parentID);
    return parentId ? { type: "session.created", sessionId, parentId } : undefined;
  }
  if (type === "permission.asked") {
    const requestId = str(data.id);
    const resources = Array.isArray(data.resources) ? data.resources.filter((r): r is string => typeof r === "string") : [];
    return requestId ? { type: "permission.asked", sessionId, requestId, action: str(data.action) ?? "unknown", resources } : undefined;
  }
  if (type === "session.text.ended") {
    const text = str(data.text);
    return text ? { sessionId, activity: { kind: "text", text } } : undefined;
  }
  const toolStatus: Record<string, Extract<StepActivity, { kind: "tool" }>["status"]> = {
    "session.tool.called": "called",
    "session.tool.success": "succeeded",
    "session.tool.failed": "failed",
  };
  const status = toolStatus[type];
  if (status) {
    const output = str(data.output) ?? str(obj(data.error).message);
    return { sessionId, activity: { kind: "tool", tool: str(data.tool) ?? str(data.name) ?? "tool", status, input: data.input, ...(output ? { output } : {}) } };
  }
  if (type === "session.tool.progress") {
    const message = str(obj(data.metadata).status) ?? str(data.title);
    return message ? { sessionId, activity: { kind: "progress", message } } : undefined;
  }
  return undefined;
}
