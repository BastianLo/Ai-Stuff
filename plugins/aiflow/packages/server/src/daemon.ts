import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AiflowError,
  agentSchema,
  randomIds,
  sequentialIds,
  systemClock,
  validateWorkflow,
  workflowSchema,
  type InboxItem,
  type RunEvent,
  type RunSummary,
  type Workflow,
} from "@aiflow/core";
import { Engine, summarizeRun, type AgentRuntime, type EventSink, type RunSpec, type RunState } from "@aiflow/engine";
import {
  createV1Client,
  createV2Client,
  OpencodeRuntime,
  OpencodeWorker,
  V1Driver,
  V2Driver,
  WorkerBridge,
  type OpencodeApi,
  type OpencodeDriver,
} from "@aiflow/runtime-opencode";
import { DefinitionRepository, FsDocumentStore, SqliteStore, type DefinitionKind } from "@aiflow/store";
import { FakeScriptRunner, MemoryDocumentStore, MemorySink, MemoryWorkspaceManager, SimulationRuntime } from "@aiflow/testkit";
import { GitWorkspaceManager, ProcessScriptRunner } from "@aiflow/workspace-git";
import { ensureToken, type AiflowPaths } from "./paths.js";
import { ProjectRegistry } from "./projects.js";

export interface DaemonOptions {
  paths: AiflowPaths;
  port: number;
  host?: string;
  /** `opencode` (Standard) oder `simulation` (ohne LLM, für Demos und Tests). */
  runtime: "opencode" | "simulation";
  opencodeBinary?: string;
  opencodeApi?: OpencodeApi | "auto";
  /** Beispiel-Definitionen beim ersten Start übernehmen. */
  seedFrom?: string;
  /** Geschwindigkeit der Simulations-Runtime (1 = realistisch). */
  simulationSpeed?: number;
  maxParallelSessions?: number;
  log?: (message: string) => void;
}

export interface RuntimeStatus {
  id: string;
  api?: OpencodeApi;
  version?: string;
  ready: boolean;
  error?: string;
}

export interface GlobalEvent {
  type: "run.updated" | "definitions.changed" | "inbox.changed" | "hello";
  runId?: string;
  summary?: RunSummary;
  kind?: DefinitionKind;
  projectDir?: string;
}

/** Composition Root: verdrahtet Engine, Store, Workspaces, Runtime und Definitionen. */
export class Daemon {
  readonly token: string;
  readonly workerToken: string;
  readonly store: SqliteStore;
  readonly definitions: DefinitionRepository;
  readonly projects: ProjectRegistry;
  readonly documents: FsDocumentStore;
  readonly bridge = new WorkerBridge();
  readonly engine: Engine;
  runtimeStatus: RuntimeStatus;
  private runtime?: AgentRuntime;
  private driver?: OpencodeDriver;
  private worker?: OpencodeWorker;
  private readonly runListeners = new Map<string, Set<(e: RunEvent) => void>>();
  private readonly globalListeners = new Set<(e: GlobalEvent) => void>();
  private readonly otps = new Map<string, { expires: number; project?: string }>();
  private readonly lastBroadcast = new Map<string, number>();

  constructor(readonly options: DaemonOptions) {
    const { paths } = options;
    this.token = ensureToken(paths.config);
    this.workerToken = randomIds().next("wk");
    this.store = new SqliteStore(join(paths.data, "aiflow.db"));
    this.definitions = new DefinitionRepository({
      globalDir: paths.config,
      onSave: (e) => this.store.saveDefinitionVersion({ kind: e.kind, id: e.id, scope: e.scope, version: e.version, createdAt: Date.now(), content: e.content }),
    });
    if (options.seedFrom && existsSync(options.seedFrom)) this.definitions.seed(options.seedFrom);
    this.projects = new ProjectRegistry(paths.data);
    this.documents = new FsDocumentStore(paths.data);
    this.runtimeStatus = { id: options.runtime, ready: options.runtime === "simulation" };
    const sink: EventSink = {
      append: (event) => {
        this.store.append(event);
        this.dispatch(event);
      },
      saveState: (state) => this.store.saveState(state),
    };
    this.engine = new Engine({
      runtime: { id: "lazy", capabilities: () => this.activeRuntime().capabilities(), runAgentStep: (r, c) => this.activeRuntime().runAgentStep(r, c) },
      workspace: new GitWorkspaceManager(paths.data),
      scripts: new ProcessScriptRunner(),
      documents: this.documents,
      sink,
      clock: systemClock,
      ids: randomIds(),
      maxParallelSessions: options.maxParallelSessions ?? 4,
    });
  }

  private activeRuntime(): AgentRuntime {
    if (this.runtime) return this.runtime;
    throw new AiflowError("RUNTIME", this.runtimeStatus.error ?? "Die Agent-Runtime ist noch nicht bereit.");
  }

  /** Startet die Runtime und lädt unterbrochene Runs. */
  async start(): Promise<void> {
    if (this.options.runtime === "simulation") {
      this.runtime = new SimulationRuntime({ speed: this.options.simulationSpeed ?? 1 });
      this.runtimeStatus = { id: "simulation", ready: true };
    } else {
      void this.startOpencode();
    }
    for (const state of this.store.unfinishedStates()) {
      await this.engine.restore(state).catch((e: unknown) => this.log(`Run ${state.id} konnte nicht geladen werden: ${String(e)}`));
    }
  }

  private async startOpencode(): Promise<void> {
    const host = this.options.host ?? "127.0.0.1";
    this.worker = new OpencodeWorker({
      ...(this.options.opencodeBinary ? { binary: this.options.opencodeBinary } : {}),
      ...(this.options.paths.opencodeConfig ? { configFile: this.options.paths.opencodeConfig } : {}),
      api: this.options.opencodeApi ?? "auto",
      daemonUrl: `http://${host}:${this.options.port}`,
      workerToken: this.workerToken,
      log: (m) => this.log(m),
      onReady: (info) => {
        this.driver = info.api === "v2" ? new V2Driver(createV2Client(info.url, info.password)) : new V1Driver(createV1Client(info.url, info.password));
        this.runtime = new OpencodeRuntime(this.driver, this.bridge);
        this.runtimeStatus = { id: "opencode", api: info.api, version: info.version, ready: true };
        void this.checkPlugin();
      },
    });
    try {
      await this.worker.start();
    } catch (error) {
      this.runtimeStatus = { id: "opencode", ready: false, error: error instanceof Error ? error.message : String(error) };
      this.log(`opencode-Worker nicht verfügbar: ${this.runtimeStatus.error}`);
    }
  }

  private async checkPlugin(): Promise<void> {
    const plugins = await this.driver?.listPlugins().catch(() => [] as string[]);
    if (plugins && !plugins.some((p) => p.includes("aiflow"))) {
      this.runtimeStatus = { ...this.runtimeStatus, error: "Das AiFlow-Plugin ist im Worker nicht aktiv. Bitte `aiflow setup opencode` ausführen." };
    }
  }

  stop(): void {
    this.worker?.stop();
    this.store.close();
  }

  log(message: string): void {
    this.options.log?.(message);
  }

  // ------------------------------------------------------------ Events

  private dispatch(event: RunEvent): void {
    for (const l of this.runListeners.get(event.runId) ?? []) l(event);
    const important = event.type.startsWith("run.") || event.type.startsWith("input.") || event.type === "step.completed" || event.type === "step.started";
    const last = this.lastBroadcast.get(event.runId) ?? 0;
    if (important || Date.now() - last > 500) {
      this.lastBroadcast.set(event.runId, Date.now());
      const state = this.engine.get(event.runId);
      if (state) this.broadcast({ type: "run.updated", runId: event.runId, summary: summarizeRun(state), projectDir: state.spec.projectDir });
      if (event.type.startsWith("input.") || event.type === "run.review_pending") this.broadcast({ type: "inbox.changed", runId: event.runId });
    }
  }

  broadcast(event: GlobalEvent): void {
    for (const l of this.globalListeners) l(event);
  }

  onRun(runId: string, listener: (e: RunEvent) => void): () => void {
    const set = this.runListeners.get(runId) ?? new Set();
    set.add(listener);
    this.runListeners.set(runId, set);
    return () => set.delete(listener);
  }

  onGlobal(listener: (e: GlobalEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  // ------------------------------------------------------------ Login

  createOtp(project?: string): string {
    const otp = randomIds().next("otp");
    this.otps.set(otp, { expires: Date.now() + 5 * 60_000, ...(project ? { project } : {}) });
    return otp;
  }

  consumeOtp(otp: string): { ok: boolean; project?: string } {
    const entry = this.otps.get(otp);
    this.otps.delete(otp);
    if (!entry || entry.expires < Date.now()) return { ok: false };
    return { ok: true, ...(entry.project ? { project: entry.project } : {}) };
  }

  // ------------------------------------------------------------ Runs

  resolveDefinitions(projectDir?: string) {
    return this.definitions.resolve(projectDir);
  }

  assertTrusted(projectDir: string): void {
    if (!this.definitions.isTrusted(projectDir)) {
      throw new AiflowError("FORBIDDEN", "Die Projekt-Definitionen in .aiflow/ sind noch nicht freigegeben (Workspace-Trust). Bitte in der Web-UI bestätigen.", { code: "UNTRUSTED" });
    }
  }

  startRun(input: { workflowId: string; projectDir: string; input: Record<string, unknown>; origin: RunSpec["origin"]; workflowOverride?: Workflow }): string {
    const projectDir = resolve(input.projectDir);
    this.assertTrusted(projectDir);
    this.projects.touch(projectDir);
    const defs = this.resolveDefinitions(projectDir);
    const workflow = input.workflowOverride ?? defs.workflows[input.workflowId];
    if (!workflow) throw new AiflowError("NOT_FOUND", `Workflow „${input.workflowId}“ existiert nicht.`);
    for (const [key, spec] of Object.entries(workflow.inputs)) {
      if (spec.required && (input.input[key] === undefined || input.input[key] === "")) throw new AiflowError("VALIDATION", `Eingabe „${spec.label ?? key}“ fehlt.`);
    }
    return this.engine.start({
      workflow,
      version: defs.versions[`workflows/${workflow.id}`] ?? "ungespeichert",
      agents: defs.agents,
      snippets: defs.snippets,
      workflows: defs.workflows,
      input: input.input,
      projectDir,
      origin: input.origin,
    });
  }

  state(runId: string): RunState {
    const state = this.engine.get(runId) ?? this.store.getState(runId);
    if (!state) throw new AiflowError("NOT_FOUND", `Run „${runId}“ existiert nicht.`);
    return state;
  }

  inbox(projectDir?: string): InboxItem[] {
    return this.engine
      .list()
      .filter((s) => !projectDir || s.spec.projectDir === resolve(projectDir))
      .flatMap((s) => s.inbox.filter((i) => i.answeredAt === undefined && (i.kind !== "review" || s.status === "review_pending")));
  }

  /** Testlauf ohne LLM: In-Memory-Workspace, simulierte Agenten, Zweigwahl vorgebbar (PLAN.md 11.4). */
  async simulate(workflow: Workflow, projectDir: string | undefined, choices: Record<string, string>, scriptExitCode = 0) {
    const defs = this.resolveDefinitions(projectDir);
    const sink = new MemorySink();
    const workspace = new MemoryWorkspaceManager({ "README.md": "# Simulation\n" });
    const documents = new MemoryDocumentStore();
    const engine = new Engine({
      runtime: new SimulationRuntime({ speed: 0, choices, rejectFirst: false, io: { workspace, documents } }),
      workspace,
      scripts: new FakeScriptRunner(() => ({ exitCode: scriptExitCode, output: scriptExitCode === 0 ? "ok" : "simulierter Fehler" })),
      documents,
      sink,
      clock: systemClock,
      ids: sequentialIds("sim"),
    });
    const id = engine.start({ workflow, version: "simulation", agents: defs.agents, snippets: defs.snippets, workflows: defs.workflows, input: { prompt: "Simulierter Auftrag" }, projectDir: "/simulation", origin: "api" });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new AiflowError("TIMEOUT", "Simulation hat zu lange gedauert (Endlosschleife?).")), 10_000));
    let state = await Promise.race([engine.wait(id, ["completed", "failed", "cancelled", "review_pending", "waiting_input"]), timeout]);
    // Mensch-Knoten: erste Option bzw. vorgegebene Wahl
    for (let i = 0; i < 20 && state.status === "waiting_input"; i++) {
      const item = state.inbox.find((x) => x.answeredAt === undefined && x.kind === "human");
      if (!item) break;
      const nodeId = state.steps[item.stepId ?? ""]?.nodeId ?? "";
      engine.answer(id, item.id, choices[nodeId] ?? item.options[0] ?? "", "Simulation");
      state = await Promise.race([engine.wait(id, ["completed", "failed", "cancelled", "review_pending", "waiting_input"]), timeout]);
    }
    if (state.status === "waiting_input") engine.cancel(id, "Simulation beendet");
    const path = state.stepOrder
      .map((s) => state.steps[s])
      .filter((s): s is NonNullable<typeof s> => Boolean(s && !s.parentStepId))
      .map((s) => ({ nodeId: s.nodeId, label: s.label, ...(s.port ? { port: s.port } : {}) }));
    return { status: state.status, ...(state.outcome ? { outcome: state.outcome } : {}), ...(state.error ? { error: state.error } : {}), path, runId: id };
  }

  /** Agent-Playground: einzelner Agent mit Test-Prompt in einem isolierten Workspace. */
  playground(agentId: string, projectDir: string, prompt: string): string {
    const defs = this.resolveDefinitions(projectDir);
    if (!defs.agents[agentId]) throw new AiflowError("NOT_FOUND", `Agent „${agentId}“ existiert nicht.`);
    const workflow = workflowSchema.parse({
      id: "playground",
      name: `Playground: ${defs.agents[agentId].name}`,
      description: "Einzelner Agent im Playground",
      settings: { finalize: "review" },
      nodes: { start: { type: "start" }, agent: { type: "agent", agent: agentId, retries: 0 }, end: { type: "end", finalize: "review" } },
      edges: [
        { from: "start", to: "agent" },
        { from: "agent", to: "end" },
      ],
    });
    return this.startRun({ workflowId: "playground", projectDir, input: { prompt }, origin: "web", workflowOverride: workflow });
  }

  validate(raw: unknown, projectDir?: string) {
    const parsed = workflowSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((i) => ({ code: "schema", severity: "error" as const, message: `${i.path.join(".")}: ${i.message}` })) };
    }
    const defs = this.resolveDefinitions(projectDir);
    return validateWorkflow(parsed.data, { agents: new Map(Object.entries(defs.agents)), workflows: new Map(Object.entries(defs.workflows)), maxParallelSessions: this.options.maxParallelSessions ?? 4 });
  }

  /** Daten aus dem Worker für Editoren und Einstellungen; mit `projectDir` inkl. projektlokaler MCP-Server. */
  async runtimeInfo(projectDir?: string) {
    const caps = this.runtime?.capabilities();
    const { config, data, opencodeConfig } = this.options.paths;
    const paths = { config, data, ...(opencodeConfig ? { opencodeConfig } : {}) };
    const [models, mcp, plugins] = this.driver
      ? await Promise.all([this.driver.listModels().catch(() => []), this.driver.listMcp(projectDir).catch(() => []), this.driver.listPlugins().catch(() => [])])
      : [[{ providerID: "deepseek", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }], [], []];
    return { id: this.runtimeStatus.id, ...(this.runtimeStatus.api ? { api: this.runtimeStatus.api } : {}), ...(caps ? { capabilities: caps } : {}), models, mcp, plugins, paths };
  }

  agentSchemaCheck(raw: unknown) {
    return agentSchema.safeParse(raw);
  }
}
