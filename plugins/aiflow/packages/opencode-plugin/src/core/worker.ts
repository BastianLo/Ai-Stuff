import { evaluatePermission, type JsonSchema, type PermissionRule } from "@aiflow/core";
import type { WorkerEnv } from "./config.js";

export interface WorkerSessionInfo {
  runId: string;
  stepId: string;
  label: string;
  systemPrompt: string;
  handoffSchema: JsonSchema;
  delegation?: { allowed: { id: string; name: string; description: string }[]; mode: string; maxParallel: number; remainingRuns: number };
  workspace: { path: string; readOnly: boolean; writeScope?: string[] };
  documents: { name: string; path: string; access: string }[];
  temperature?: number;
  topP?: number;
  permissions: PermissionRule[];
  phase: "work" | "finalize";
  handoffReceived: boolean;
}

/** Zugriff auf die Worker-API des Daemons (nur Worker-Rolle). */
export class WorkerApi {
  private readonly cache = new Map<string, { at: number; info: WorkerSessionInfo | null }>();

  constructor(
    private readonly env: WorkerEnv,
    private readonly fetchImpl: typeof fetch = (i, init) => fetch(i, init),
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T ist der erwartete Antworttyp
  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(`${this.env.daemonUrl}/api/worker${path}`, {
      method,
      headers: { "x-aiflow-worker-token": this.env.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
  }

  /** Session-Infos (gecacht, 2 s). `null`: keine AiFlow-Session. */
  async info(sessionId: string, fresh = false): Promise<WorkerSessionInfo | null> {
    const cached = this.cache.get(sessionId);
    if (!fresh && cached && Date.now() - cached.at < 2000) return cached.info;
    const res = await this.call<WorkerSessionInfo>("GET", `/sessions/${encodeURIComponent(sessionId)}`).catch(() => ({ status: 503, data: undefined }));
    const info = res.status === 200 && res.data ? res.data : null;
    this.cache.set(sessionId, { at: Date.now(), info });
    return info;
  }

  async handoff(sessionId: string, input: unknown): Promise<{ ok: boolean; error?: string }> {
    this.cache.delete(sessionId);
    return (await this.call<{ ok: boolean; error?: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/handoff`, { input })).data;
  }

  async delegate(sessionId: string, tasks: unknown): Promise<unknown> {
    const res = await this.call<unknown>("POST", `/sessions/${encodeURIComponent(sessionId)}/delegate`, { tasks });
    if (res.status !== 200) throw new Error(JSON.stringify(res.data));
    return res.data;
  }

  async progress(sessionId: string, message: string): Promise<void> {
    await this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/progress`, { message });
  }

  async context(sessionId: string, query: string): Promise<string> {
    return (await this.call<{ text: string }>("POST", `/sessions/${encodeURIComponent(sessionId)}/context`, { query })).data.text;
  }
}

/** Welche Rechte-Prüfungen ein Tool-Aufruf auslöst (Toolnamen von v1 und v2). */
export function checksFor(tool: string, input: unknown): { action: string; resource: string }[] {
  const i = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const path = [i.filePath, i.file_path, i.path, i.file].find((v): v is string => typeof v === "string");
  switch (tool) {
    case "read":
      return path ? [{ action: "read", resource: path }] : [];
    case "edit":
    case "write":
    case "patch":
    case "multiedit":
      return path ? [{ action: "edit", resource: path }] : [{ action: "edit", resource: "*" }];
    case "bash":
    case "shell":
      return typeof i.command === "string" ? [{ action: "shell", resource: i.command }] : [];
    case "glob":
    case "grep":
    case "list":
      return [{ action: tool, resource: path ?? "*" }];
    case "webfetch":
      return [{ action: "webfetch", resource: typeof i.url === "string" ? i.url : "*" }];
    case "websearch":
      return [{ action: "websearch", resource: "*" }];
    case "task":
    case "subagent":
      return [{ action: "subagent", resource: "*" }];
    default:
      return [];
  }
}

/** Harte Prüfung eines Tool-Aufrufs gegen die Regeln des Schritts. Gibt eine Fehlermeldung zurück oder `undefined`. */
export function guardToolCall(info: WorkerSessionInfo, tool: string, input: unknown): string | undefined {
  for (const check of checksFor(tool, input)) {
    if (evaluatePermission(info.permissions, check.action, check.resource, "allow") === "deny") {
      return `AiFlow: „${tool}“ auf „${check.resource}“ ist in Schritt „${info.label}“ nicht erlaubt.`;
    }
    if (check.action === "edit" && info.workspace.readOnly && !info.documents.some((d) => d.path === check.resource && d.access !== "read")) {
      return `AiFlow: Schritt „${info.label}“ arbeitet im Nur-lesen-Workspace.`;
    }
  }
  return undefined;
}
