import { AiflowError, splitModelRef, type PermissionRule } from "@aiflow/core";
import type { RuntimeCapabilities, StepActivity } from "@aiflow/engine";
import type { CreateSessionOptions, ModelInfo, OpencodeDriver, RunOptions, RunResult, SessionActivity } from "../common/driver.js";
import { toV1Rules } from "../common/permissions.js";
import { num, obj, str } from "../common/util.js";

/** Die Teilmenge der v1-API (`@opencode-ai/sdk/v2`-Client), die AiFlow nutzt. Ergebnisse im Stil `{ data, error }`. */
export interface V1Client {
  global: { health(): Promise<{ data?: unknown; error?: unknown }> };
  session: {
    create(p: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>;
    prompt(p: Record<string, unknown>, o?: { signal?: AbortSignal }): Promise<{ data?: unknown; error?: unknown }>;
    fork(p: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>;
    abort(p: Record<string, unknown>): Promise<{ data?: unknown; error?: unknown }>;
  };
  event: { subscribe(p?: Record<string, unknown>, o?: { signal?: AbortSignal }): Promise<{ stream: AsyncIterable<unknown> }> };
  provider: { list(): Promise<{ data?: unknown }> };
  mcp: { status(): Promise<{ data?: unknown }> };
  config: { get(): Promise<{ data?: unknown }> };
}

function unwrap(result: { data?: unknown; error?: unknown }, what: string): unknown {
  if (result.error !== undefined && result.error !== null) throw new AiflowError("RUNTIME", `opencode v1: ${what} fehlgeschlagen: ${JSON.stringify(result.error).slice(0, 500)}`);
  return result.data;
}

/** Treiber für opencode v1 (≥ 1.18.29). Strukturierte Übergabe per `format: json_schema`. */
export class V1Driver implements OpencodeDriver {
  readonly api = "v1" as const;

  constructor(private readonly client: V1Client) {}

  capabilities(): RuntimeCapabilities {
    return { structuredOutput: "format", sessionFork: true, userQuestions: "question" };
  }

  async health(): Promise<{ version: string }> {
    return { version: str(obj(unwrap(await this.client.global.health(), "health")).version) ?? "1.x" };
  }

  async createSession(o: CreateSessionOptions): Promise<string> {
    const model = o.model ? splitModelRef(o.model.ref) : undefined;
    const data = unwrap(
      await this.client.session.create({
        directory: o.directory,
        title: o.title,
        metadata: o.metadata,
        permission: toV1Rules(o.permissions),
        ...(model ? { model: { id: model.modelID, providerID: model.providerID, ...(o.model?.variant ? { variant: o.model.variant } : {}) } } : {}),
        ...(o.parentSessionId ? { parentID: o.parentSessionId } : {}),
      }),
      "session.create",
    );
    const id = str(obj(data).id);
    if (!id) throw new AiflowError("RUNTIME", "opencode v1: session.create lieferte keine ID.");
    return id;
  }

  async forkSession(sessionId: string, directory: string): Promise<string> {
    const id = str(obj(unwrap(await this.client.session.fork({ sessionID: sessionId, directory }), "session.fork")).id);
    if (!id) throw new AiflowError("RUNTIME", "opencode v1: session.fork lieferte keine ID.");
    return id;
  }

  async run(sessionId: string, o: RunOptions, signal: AbortSignal): Promise<RunResult> {
    const model = o.model ? splitModelRef(o.model.ref) : undefined;
    const data = obj(
      unwrap(
        await this.client.session.prompt(
          {
            sessionID: sessionId,
            directory: o.directory,
            system: o.system,
            parts: [{ type: "text", text: o.text }],
            ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
            ...(o.model?.variant ? { variant: o.model.variant } : {}),
            ...(o.format ? { format: { type: "json_schema", schema: o.format, retryCount: 2 } } : {}),
          },
          { signal },
        ),
        "session.prompt",
      ),
    );
    const info = obj(data.info);
    const parts = Array.isArray(data.parts) ? data.parts : [];
    const text = parts.map((p) => obj(p)).filter((p) => p.type === "text").map((p) => str(p.text) ?? "").join("\n");
    const tokens = obj(info.tokens);
    const error = info.error !== undefined ? JSON.stringify(info.error) : undefined;
    if (error && info.structured === undefined && !o.format) throw new AiflowError("RUNTIME", `opencode v1: Antwort mit Fehler: ${error.slice(0, 500)}`);
    return {
      text,
      ...(info.structured !== undefined ? { structured: info.structured } : {}),
      ...(error ? { structuredError: error } : {}),
      usage: { inputTokens: num(tokens.input), outputTokens: num(tokens.output) },
    };
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.client.session.abort({ sessionID: sessionId, directory });
  }

  async *activity(signal: AbortSignal): AsyncIterable<SessionActivity> {
    const { stream } = await this.client.event.subscribe({}, { signal });
    for await (const raw of stream) {
      const mapped = mapV1Event(raw);
      if (mapped) yield mapped;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = obj((await this.client.provider.list()).data);
    const providers = Array.isArray(data.all) ? data.all : Array.isArray(data.providers) ? data.providers : [];
    return providers.flatMap((p) => {
      const provider = obj(p);
      const providerID = str(provider.id) ?? "";
      return Object.entries(obj(provider.models)).map(([modelID, m]) => ({ providerID, modelID, name: str(obj(m).name) ?? modelID }));
    });
  }

  async listMcp(): Promise<{ name: string; status: string }[]> {
    return Object.entries(obj((await this.client.mcp.status()).data)).map(([name, s]) => ({ name, status: str(obj(s).status) ?? "unknown" }));
  }

  async listPlugins(): Promise<string[]> {
    const plugins = obj((await this.client.config.get()).data).plugin;
    return Array.isArray(plugins) ? plugins.map((p) => (Array.isArray(p) ? String(p[0]) : String(p))) : [];
  }
}

/** v1-Events → Aktivität (Text-Parts nur abgeschlossen, Tool-Parts mit Status). */
export function mapV1Event(raw: unknown): SessionActivity | undefined {
  const event = obj(raw);
  const props = obj(event.properties);
  if (event.type !== "message.part.updated") return undefined;
  const part = obj(props.part);
  const sessionId = str(part.sessionID);
  if (!sessionId) return undefined;
  if (part.type === "text" && obj(part.time).end !== undefined) {
    const text = str(part.text);
    return text ? { sessionId, activity: { kind: "text", text } } : undefined;
  }
  if (part.type === "tool") {
    const state = obj(part.state);
    const status = str(state.status);
    const mapped: Record<string, Extract<StepActivity, { kind: "tool" }>["status"]> = { running: "called", completed: "succeeded", error: "failed" };
    const s = status ? mapped[status] : undefined;
    if (!s) return undefined;
    const output = str(state.output) ?? str(state.error);
    return { sessionId, activity: { kind: "tool", tool: str(part.tool) ?? "tool", status: s, input: state.input, ...(output ? { output } : {}) } };
  }
  return undefined;
}

export type { PermissionRule };
