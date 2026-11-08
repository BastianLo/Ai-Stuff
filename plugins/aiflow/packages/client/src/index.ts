import type {
  AgentDefinition,
  FileChange,
  InboxItem,
  ReviewData,
  RunEvent,
  RunStatus,
  RunSummary,
  Snippet,
  StepRecord,
  ValidationIssue,
  Workflow,
} from "@aiflow/core";

export type DefinitionKind = "agents" | "workflows" | "snippets";
export type Scope = "global" | "project";

export interface DefinitionEntry<T = unknown> {
  kind: DefinitionKind;
  id: string;
  scope: Scope;
  file: string;
  version: string;
  definition?: T;
  error?: string;
  shadowed?: boolean;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  runtime: { id: string; api?: string; version?: string; ready: boolean; error?: string };
}

export interface ProjectInfo {
  path: string;
  name: string;
  trusted: boolean;
  lastUsed: number;
}

/** Run-Ansicht für Clients (Zustand ohne interne Felder). */
export interface RunView {
  id: string;
  status: RunStatus;
  outcome?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  workflow: Workflow;
  agents: Record<string, AgentDefinition>;
  input: Record<string, unknown>;
  projectDir: string;
  origin: string;
  parentRunId?: string;
  steps: StepRecord[];
  activeNodes: string[];
  edgeCounts: Record<string, number>;
  inbox: InboxItem[];
  review?: ReviewData;
  children: string[];
}

export interface RuntimeInfo {
  id: string;
  api?: string;
  capabilities?: unknown;
  models: { providerID: string; modelID: string; name: string }[];
  mcp: { name: string; status: string }[];
  plugins: string[];
  paths: { config: string; data: string; opencodeConfig?: string };
}

export interface SimulationResult {
  status: RunStatus;
  outcome?: string;
  error?: string;
  path: { nodeId: string; label: string; port?: string }[];
  runId: string;
}

export interface StartRunInput {
  workflowId: string;
  projectDir: string;
  input: Record<string, unknown>;
  origin?: "web" | "cli" | "tui" | "api";
}

export type ReviewAction =
  | { action: "apply"; files?: string[] }
  | { action: "discard" }
  | { action: "branch"; name?: string }
  | { action: "request-changes"; feedback: string; nodeId?: string };

export interface GlobalEvent {
  type: "run.updated" | "definitions.changed" | "inbox.changed" | "hello";
  runId?: string;
  summary?: RunSummary;
  kind?: DefinitionKind;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  /** Browser: Cookie-Authentifizierung mitsenden. */
  credentials?: "include" | "same-origin" | "omit";
}

/** Typisierter Client für die AiFlow-HTTP-API (Browser, Node und Bun). */
export class AiflowClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, "");
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}), ...extra };
  }

  async request<T>(method: string, path: string, body?: unknown, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const res = await this.fetchImpl(`${this.baseUrl}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(this.options.credentials ? { credentials: this.options.credentials } : {}),
    });
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (data ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
      throw new ApiError(res.status, err.error?.code ?? "HTTP", err.error?.message ?? `HTTP ${res.status}`, err.error?.details);
    }
    return data as T;
  }

  health = () => this.request<HealthInfo>("GET", "/api/health");

  // Projekte
  projects = () => this.request<ProjectInfo[]>("GET", "/api/projects");
  registerProject = (path: string) => this.request<ProjectInfo>("POST", "/api/projects", { path });
  trustProject = (path: string) => this.request<ProjectInfo>("POST", "/api/projects/trust", { path });

  // Definitionen
  listDefinitions = <T>(kind: DefinitionKind, project?: string) => this.request<DefinitionEntry<T>[]>("GET", `/api/definitions/${kind}`, undefined, { project });
  agents = (project?: string) => this.listDefinitions<AgentDefinition>("agents", project);
  workflows = (project?: string) => this.listDefinitions<Workflow>("workflows", project);
  snippets = (project?: string) => this.listDefinitions<Snippet>("snippets", project);
  getDefinition = <T>(kind: DefinitionKind, id: string, project?: string) => this.request<DefinitionEntry<T>>("GET", `/api/definitions/${kind}/${id}`, undefined, { project });
  saveDefinition = <T>(kind: DefinitionKind, id: string, definition: unknown, scope: Scope, project?: string) =>
    this.request<DefinitionEntry<T>>("PUT", `/api/definitions/${kind}/${id}`, definition, { scope, project });
  deleteDefinition = (kind: DefinitionKind, id: string, scope: Scope, project?: string) => this.request<{ ok: true }>("DELETE", `/api/definitions/${kind}/${id}`, undefined, { scope, project });
  definitionVersions = (kind: DefinitionKind, id: string) =>
    this.request<{ version: string; createdAt: number; scope: string; content: string }[]>("GET", `/api/definitions/${kind}/${id}/versions`);
  validateWorkflow = (workflow: unknown, project?: string) => this.request<{ ok: boolean; issues: ValidationIssue[] }>("POST", "/api/workflows/validate", { workflow, project });
  simulate = (workflowId: string, body: { project?: string; workflow?: unknown; choices?: Record<string, string>; scriptExitCode?: number }) =>
    this.request<SimulationResult>("POST", `/api/workflows/${workflowId}/simulate`, body);
  playground = (agentId: string, body: { project: string; prompt: string }) => this.request<{ runId: string }>("POST", `/api/agents/${agentId}/playground`, body);

  // Runs
  startRun = (input: StartRunInput) => this.request<{ id: string }>("POST", "/api/runs", input);
  runs = (filter: { project?: string; status?: string; q?: string; workflow?: string; limit?: number } = {}) => this.request<RunSummary[]>("GET", "/api/runs", undefined, filter);
  run = (id: string) => this.request<RunView>("GET", `/api/runs/${id}`);
  runEvents = (id: string, after = 0) => this.request<RunEvent[]>("GET", `/api/runs/${id}/events`, undefined, { after });
  runDocuments = (id: string) => this.request<{ name: string; description: string; content: string; versions: { stepId: string; ts: number; content: string }[] }[]>("GET", `/api/runs/${id}/documents`);
  pauseRun = (id: string) => this.request<{ ok: true }>("POST", `/api/runs/${id}/pause`);
  resumeRun = (id: string) => this.request<{ ok: true }>("POST", `/api/runs/${id}/resume`);
  cancelRun = (id: string) => this.request<{ ok: true }>("POST", `/api/runs/${id}/cancel`);
  deleteRun = (id: string) => this.request<{ ok: true }>("DELETE", `/api/runs/${id}`);
  review = (id: string, action: ReviewAction) => this.request<{ ok: true; status: RunStatus }>("POST", `/api/runs/${id}/review`, action);
  stepDiff = (id: string, stepId: string) => this.request<FileChange[]>("GET", `/api/runs/${id}/steps/${stepId}/diff`);

  // Inbox
  inbox = (project?: string) => this.request<InboxItem[]>("GET", "/api/inbox", undefined, { project });
  answer = (runId: string, itemId: string, option: string, text?: string) => this.request<{ ok: true }>("POST", `/api/inbox/${runId}/${itemId}`, { option, text });

  // Runtime
  /** Mit `project` enthält die MCP-Liste auch die projektlokale opencode-Konfiguration. */
  runtime = (project?: string) => this.request<RuntimeInfo>("GET", "/api/runtime", undefined, { project });
  loginUrl = (otp: string) => `${this.baseUrl}/login?otp=${encodeURIComponent(otp)}`;
  createLogin = (project?: string) => this.request<{ url: string }>("POST", "/api/login-links", { project });

  /** Abonniert einen SSE-Endpunkt. Verbindet nach Abbrüchen neu (mit Last-Event-ID). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T ist der Ereignistyp des Streams
  subscribe<T>(path: string, onEvent: (event: T, id?: string) => void, signal: AbortSignal): Promise<void> {
    return streamSse(this.fetchImpl, `${this.baseUrl}${path}`, this.headers(), this.options.credentials, onEvent, signal);
  }

  subscribeRun = (id: string, onEvent: (e: RunEvent) => void, signal: AbortSignal) => this.subscribe<RunEvent>(`/api/runs/${id}/stream`, onEvent, signal);
  subscribeGlobal = (onEvent: (e: GlobalEvent) => void, signal: AbortSignal, project?: string) =>
    this.subscribe<GlobalEvent>(`/api/events${project ? `?project=${encodeURIComponent(project)}` : ""}`, onEvent, signal);
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T ist der Ereignistyp des Streams
async function streamSse<T>(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  credentials: "include" | "same-origin" | "omit" | undefined,
  onEvent: (event: T, id?: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let lastId: string | undefined;
  while (!signal.aborted) {
    try {
      const res = await fetchImpl(url, {
        headers: { ...headers, accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
        signal,
        ...(credentials ? { credentials } : {}),
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let data = "";
          let id: string | undefined;
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data:")) data += line.slice(5).trimStart();
            else if (line.startsWith("id:")) id = line.slice(3).trim();
          }
          if (id) lastId = id;
          if (data) onEvent(JSON.parse(data) as T, id);
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
