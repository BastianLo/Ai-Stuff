import {
  AiflowError,
  assertValidWorkflow,
  buildHandoffSchema,
  errorMessage,
  evaluateBooleanVote,
  evaluateCondition,
  getPath,
  majorityVote,
  matchesPattern,
  parseDuration,
  parseHandoff,
  presetRules,
  renderTemplate,
  slugify,
  TERMINAL_RUN_STATUSES,
  truncateMiddle,
  truthy,
  WorkflowGraph,
  ERROR_PORT,
  CONFLICT_PORT,
  DEFAULT_PORT,
  type AgentDefinition,
  type BranchOption,
  type ContextInclude,
  type DocumentAccess,
  type Handoff,
  type InboxItem,
  type NodeOf,
  type PermissionRule,
  type ResolvedEdge,
  type ReviewData,
  type RunEvent,
  type RunEventType,
  type RunStatus,
  type Snippet,
  type StepRecord,
  type SubagentSettings,
  type WorkflowNode,
} from "@aiflow/core";
import { buildStepPrompt, buildSystemPrompt, type JournalEntry } from "./context.js";
import type {
  AgentStepContext,
  AgentStepRequest,
  DelegationOffer,
  DelegationResult,
  DelegationResultItem,
  DelegationTask,
  DocumentGrant,
  EngineDeps,
  StepActivity,
  WorkspaceRef,
} from "./ports.js";
import { mapLimit, Semaphore } from "./semaphore.js";
import { activeTokens, lastStepOf, type Candidate, type ForkState, type Inbound, type RunSpec, type RunState, type Token } from "./state.js";

interface NodeResult {
  port: string;
  handoff: Handoff;
}

class CancelledError extends AiflowError {
  constructor(message = "Schritt abgebrochen") {
    super("CANCELLED", message);
  }
}

type Listener = (event: RunEvent) => void;

/**
 * Die Workflow-Engine. Hält alle Runs im Speicher, schreibt Events und Zustands-Snapshots über den EventSink
 * und führt Knoten über die Ports (Runtime, Workspace, Skripte, Dokumente) aus.
 */
export class Engine {
  private readonly runs = new Map<string, RunController>();
  private readonly listeners = new Set<Listener>();
  readonly sessions: Semaphore;

  constructor(readonly deps: EngineDeps) {
    this.sessions = new Semaphore(deps.maxParallelSessions ?? 8);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal */
  publish(event: RunEvent): void {
    this.deps.sink.append(event);
    for (const l of this.listeners) l(event);
  }

  /** Startet einen Run. Kehrt nach dem Anlegen zurück; der Run läuft asynchron weiter. */
  start(spec: RunSpec): string {
    assertValidWorkflow(spec.workflow, { agents: new Map(Object.entries(spec.agents)), workflows: new Map(Object.entries(spec.workflows)) });
    const controller = new RunController(this, spec);
    this.runs.set(controller.state.id, controller);
    void controller.begin();
    return controller.state.id;
  }

  /** Lädt einen gespeicherten Run (z. B. nach einem Neustart). Laufende Schritte werden als unterbrochen markiert. */
  async restore(state: RunState): Promise<void> {
    const controller = RunController.fromState(this, state);
    this.runs.set(state.id, controller);
    await controller.markInterrupted();
  }

  get(runId: string): RunState | undefined {
    return this.runs.get(runId)?.state;
  }

  list(): RunState[] {
    return [...this.runs.values()].map((c) => c.state);
  }

  private controller(runId: string): RunController {
    const c = this.runs.get(runId);
    if (!c) throw new AiflowError("NOT_FOUND", `Run „${runId}“ existiert nicht.`);
    return c;
  }

  /** Wartet, bis der Run einen der Status erreicht (Standard: beendet oder Review ausstehend). */
  wait(runId: string, statuses: readonly RunStatus[] = [...TERMINAL_RUN_STATUSES, "review_pending"]): Promise<RunState> {
    return this.controller(runId).waitFor(statuses);
  }

  answer(runId: string, itemId: string, option: string, text?: string): void {
    this.controller(runId).answer(itemId, option, text);
  }

  pause(runId: string): void {
    this.controller(runId).pause();
  }

  resume(runId: string): void {
    this.controller(runId).resume();
  }

  cancel(runId: string, reason = "Vom Nutzer abgebrochen"): void {
    this.controller(runId).cancel(reason);
  }

  decideReview(runId: string, decision: ReviewDecision): Promise<void> {
    return this.controller(runId).decideReview(decision);
  }
}

export type ReviewDecision =
  | { action: "apply"; files?: string[] }
  | { action: "discard" }
  | { action: "branch"; name?: string }
  | { action: "request-changes"; feedback: string; nodeId?: string };

class RunController {
  state: RunState;
  private graph: WorkflowGraph;
  private readonly aborts = new Map<string, AbortController>();
  private readonly pendingAnswers = new Map<string, (answer: { option: string; text?: string }) => void>();
  private readonly waiters: { statuses: readonly RunStatus[]; resolve: (s: RunState) => void }[] = [];
  private readonly runSessions: Semaphore;
  private readonly snippets: Map<string, Snippet>;
  private readonly childRuns = new Map<string, string>();
  private deadline?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly engine: Engine,
    spec: RunSpec,
    existing?: RunState,
  ) {
    const { clock, ids } = engine.deps;
    this.state = existing ?? {
      id: ids.next("run"),
      spec,
      status: "running",
      createdAt: clock.now(),
      tokens: [],
      steps: {},
      stepOrder: [],
      edgeCounts: {},
      nodeVisits: {},
      forks: {},
      inbox: [],
      sessions: {},
      seq: 0,
    };
    this.graph = new WorkflowGraph(spec.workflow);
    this.runSessions = new Semaphore(spec.workflow.settings.limits.maxParallelSessions);
    this.snippets = new Map(Object.entries(spec.snippets));
  }

  static fromState(engine: Engine, state: RunState): RunController {
    return new RunController(engine, state.spec, state);
  }

  private get deps(): EngineDeps {
    return this.engine.deps;
  }

  private get workflow() {
    return this.state.spec.workflow;
  }

  // ---------------------------------------------------------------- Lebenszyklus

  async begin(): Promise<void> {
    const { spec } = this.state;
    this.emit("run.created", { workflowId: spec.workflow.id, prompt: spec.input.prompt ?? "", parentRunId: spec.parentRunId });
    try {
      const base = spec.baseWorkspace ?? (await this.deps.workspace.prepare(this.state.id, spec.projectDir, spec.workflow.settings.workspace.base));
      this.state.baseWorkspace = base;
      if (!spec.baseWorkspace && spec.workflow.settings.workspace.setup) {
        const setup = await this.deps.scripts.run(spec.workflow.settings.workspace.setup, {
          cwd: base.path,
          timeoutMs: parseDuration("20m"),
          env: {},
          signal: new AbortController().signal,
        });
        this.emit("log", { level: setup.exitCode === 0 ? "info" : "warn", message: `Setup-Befehl beendet mit ${setup.exitCode}`, output: truncateMiddle(setup.output, 4000) });
      }
      await this.deps.documents.init(
        this.state.id,
        Object.entries(spec.workflow.documents).map(([name, d]) => ({ name, content: this.documentTemplate(d.template) })),
      );
      const startId = this.graph.startId;
      if (!startId) throw new AiflowError("VALIDATION", "Workflow hat keinen Start-Knoten.");
      this.state.tokens.push({ id: this.deps.ids.next("tok"), nodeId: startId, status: "ready", forkStack: [], workspace: base, inbound: {} });
      this.state.startedAt = this.deps.clock.now();
      this.armDeadline();
      this.emit("run.started", {});
      this.save();
      this.pump();
    } catch (error) {
      this.fail(error);
    }
  }

  private documentTemplate(template: string | undefined): string {
    if (!template) return "";
    const snippet = this.snippets.get(template);
    return snippet ? snippet.content : template;
  }

  private armDeadline(): void {
    const ms = parseDuration(this.workflow.settings.limits.maxDuration);
    const started = this.state.startedAt ?? this.deps.clock.now();
    const remaining = Math.max(1000, started + ms - this.deps.clock.now());
    this.deadline = setTimeout(() => this.fail(new AiflowError("LIMIT", `Maximale Laufzeit (${this.workflow.settings.limits.maxDuration}) überschritten.`)), remaining);
    this.deadline.unref?.();
  }

  async markInterrupted(): Promise<void> {
    if (TERMINAL_RUN_STATUSES.includes(this.state.status) || this.state.status === "review_pending") return;
    for (const token of this.state.tokens) {
      if (token.status !== "running" && token.status !== "waiting") continue;
      const step = token.stepId ? this.state.steps[token.stepId] : undefined;
      if (step && (step.status === "running" || step.status === "waiting")) {
        step.status = "failed";
        step.error = "Unterbrochen (Neustart des Daemons)";
        step.finishedAt = this.deps.clock.now();
        if (step.checkpointBefore) token.workspace = await this.deps.workspace.reset(token.workspace, step.checkpointBefore);
      }
      // Sub-Schritte des unterbrochenen Schritts ebenfalls schließen
      for (const s of Object.values(this.state.steps)) {
        if (s.parentStepId === token.stepId && s.status === "running") {
          s.status = "failed";
          s.error = "Unterbrochen";
        }
      }
      token.status = "ready";
      delete token.stepId;
    }
    this.state.inbox = this.state.inbox.filter((i) => i.answeredAt !== undefined || i.kind === "review");
    this.setStatus("interrupted");
    this.emit("run.interrupted", {});
    this.save();
  }

  waitFor(statuses: readonly RunStatus[]): Promise<RunState> {
    if (statuses.includes(this.state.status)) return Promise.resolve(this.state);
    return new Promise((resolve) => this.waiters.push({ statuses, resolve }));
  }

  private setStatus(status: RunStatus): void {
    if (this.state.status === status) return;
    this.state.status = status;
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w && w.statuses.includes(status)) {
        this.waiters.splice(i, 1);
        w.resolve(this.state);
      }
    }
  }

  pause(): void {
    if (this.state.status !== "running" && this.state.status !== "waiting_input") return;
    this.setStatus("paused");
    this.emit("run.paused", {});
    this.save();
  }

  resume(): void {
    if (this.state.status !== "paused" && this.state.status !== "interrupted") return;
    if (!this.deadline) this.armDeadline();
    this.setStatus("running");
    this.emit("run.resumed", {});
    this.save();
    this.pump();
  }

  cancel(reason: string): void {
    if (TERMINAL_RUN_STATUSES.includes(this.state.status)) return;
    this.abortAll(reason);
    this.state.outcome = "cancelled";
    this.finish("cancelled", "run.cancelled", { reason });
  }

  private abortAll(reason: string): void {
    for (const [, c] of this.aborts) c.abort(new CancelledError(reason));
    for (const [, childId] of this.childRuns) {
      try {
        this.engine.cancel(childId, reason);
      } catch {
        /* Kind-Run existiert nicht mehr */
      }
    }
    for (const t of activeTokens(this.state)) t.status = "cancelled";
  }

  private fail(error: unknown): void {
    if (TERMINAL_RUN_STATUSES.includes(this.state.status)) return;
    const message = errorMessage(error);
    this.abortAll(message);
    this.state.error = message;
    this.state.outcome = "failed";
    this.finish("failed", "run.failed", { error: message });
  }

  private finish(status: RunStatus, event: RunEventType, data: Record<string, unknown>): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.state.finishedAt = this.deps.clock.now();
    for (const step of Object.values(this.state.steps)) {
      if (step.status === "running" || step.status === "waiting") {
        step.status = "cancelled";
        step.finishedAt = this.state.finishedAt;
      }
    }
    this.setStatus(status);
    this.emit(event, { ...data, outcome: this.state.outcome });
    this.save();
  }

  // ---------------------------------------------------------------- Scheduler

  private pump(): void {
    if (this.state.status !== "running" && this.state.status !== "waiting_input") return;
    for (const token of this.state.tokens) {
      if (token.status !== "ready") continue;
      token.status = "running";
      void this.execute(token).catch((error: unknown) => {
        if (error instanceof CancelledError) return;
        this.fail(error);
      });
    }
    this.checkProgress();
  }

  private checkProgress(): void {
    if (this.state.status !== "running" && this.state.status !== "waiting_input") return;
    const active = activeTokens(this.state);
    if (active.length === 0) {
      void this.finalize().catch((error: unknown) => this.fail(error));
      return;
    }
    const waiting = active.every((t) => t.status === "waiting");
    if (waiting && this.state.status === "running") {
      this.setStatus("waiting_input");
      this.emit("run.waiting_input", {});
      this.save();
    } else if (!waiting && this.state.status === "waiting_input") {
      this.setStatus("running");
      this.save();
    }
  }

  private async execute(token: Token): Promise<void> {
    const node = this.graph.node(token.nodeId);
    if (node.type === "join") return this.arriveAtJoin(token, node);
    if (node.type === "end") return this.reachEnd(token, node);
    if (node.type === "note") throw new AiflowError("INVALID_STATE", `Notiz-Knoten „${token.nodeId}“ ist nicht ausführbar.`);

    const topLevel = this.state.stepOrder.filter((id) => !this.state.steps[id]?.parentStepId).length;
    if (topLevel >= this.workflow.settings.limits.maxSteps) {
      throw new AiflowError("LIMIT", `Maximale Anzahl Schritte (${this.workflow.settings.limits.maxSteps}) erreicht.`);
    }
    const visit = (this.state.nodeVisits[token.nodeId] ?? 0) + 1;
    this.state.nodeVisits[token.nodeId] = visit;
    const step = this.newStep(token, node, visit);
    if (node.type === "agent" && node.maxVisits !== undefined && visit > node.maxVisits) {
      return this.failStep(token, step, new AiflowError("LIMIT", `„${step.label}“ wurde öfter als ${node.maxVisits}-mal besucht.`));
    }

    let result: NodeResult;
    try {
      result = await this.runNode(token, node, step);
    } catch (error) {
      if (error instanceof CancelledError || token.status === "cancelled") {
        if (step.status === "running" || step.status === "waiting") {
          step.status = "cancelled";
          step.finishedAt = this.deps.clock.now();
        }
        throw new CancelledError();
      }
      return this.failStep(token, step, error);
    } finally {
      this.aborts.delete(step.id);
    }
    if (token.status === "cancelled") return;
    this.completeStep(step, result);
    await this.route(token, step, result.port);
  }

  private newStep(token: Token, node: WorkflowNode, visit: number, parent?: StepRecord): StepRecord {
    const step: StepRecord = {
      id: this.deps.ids.next("step"),
      runId: this.state.id,
      nodeId: token.nodeId,
      nodeType: node.type,
      label: node.label ?? (node.type === "agent" ? (this.state.spec.agents[node.agent]?.name ?? token.nodeId) : token.nodeId),
      tokenId: token.id,
      status: "running",
      attempt: 1,
      visit,
      startedAt: this.deps.clock.now(),
      metrics: {},
      workspaceId: token.workspace.id,
      checkpointBefore: token.workspace.head,
    };
    if (node.type === "agent") step.agentId = node.agent;
    if (parent) step.parentStepId = parent.id;
    this.state.steps[step.id] = step;
    this.state.stepOrder.push(step.id);
    token.stepId = step.id;
    this.emit("step.started", { nodeId: step.nodeId, nodeType: step.nodeType, label: step.label, visit, agentId: step.agentId }, step.id);
    this.save();
    return step;
  }

  private completeStep(step: StepRecord, result: NodeResult): void {
    step.status = "completed";
    step.port = result.port;
    step.handoff = result.handoff;
    step.finishedAt = this.deps.clock.now();
    step.metrics.durationMs = step.finishedAt - step.startedAt;
    this.emit("step.completed", { nodeId: step.nodeId, label: step.label, port: result.port, summary: result.handoff.summary, durationMs: step.metrics.durationMs }, step.id);
    this.save();
  }

  private async failStep(token: Token, step: StepRecord, error: unknown): Promise<void> {
    step.status = "failed";
    step.error = errorMessage(error);
    step.finishedAt = this.deps.clock.now();
    step.metrics.durationMs = step.finishedAt - step.startedAt;
    this.emit("step.failed", { nodeId: step.nodeId, label: step.label, error: step.error }, step.id);
    if (this.graph.out(token.nodeId, ERROR_PORT).length > 0) {
      step.port = ERROR_PORT;
      step.handoff = { summary: `Fehler: ${step.error}`, handoff: step.error };
      this.save();
      await this.route(token, step, ERROR_PORT);
      return;
    }
    this.save();
    throw new AiflowError("RUNTIME", `Schritt „${step.label}“ ist fehlgeschlagen: ${step.error}`);
  }

  // ---------------------------------------------------------------- Routing

  private async route(token: Token, step: StepRecord, port: string): Promise<void> {
    const edges = this.graph.out(token.nodeId, port);
    if (edges.length === 0) throw new AiflowError("INVALID_STATE", `Port „${port}“ von „${step.label}“ ist nicht verbunden.`);
    const moves = edges.map((edge) => this.traverse(edge, step));
    if (moves.length === 1) {
      const move = moves[0];
      if (!move) return;
      token.nodeId = move.to;
      token.inbound = move.inbound;
      token.status = "ready";
      delete token.stepId;
    } else {
      const fork: ForkState = { id: this.deps.ids.next("fork"), fromNode: token.nodeId, total: moves.length, baseWorkspace: token.workspace, arrivals: [], fired: false };
      this.state.forks[fork.id] = fork;
      moves.forEach((move, branch) => {
        this.state.tokens.push({
          id: this.deps.ids.next("tok"),
          nodeId: move.to,
          status: "ready",
          forkStack: [...token.forkStack, { forkId: fork.id, branch, total: moves.length }],
          workspace: token.workspace,
          inbound: move.inbound,
        });
      });
      token.status = "done";
      this.emit("token.forked", { forkId: fork.id, from: step.nodeId, port, targets: moves.map((m) => m.to) }, step.id);
    }
    this.save();
    this.pump();
  }

  private traverse(edge: ResolvedEdge, step: StepRecord): { to: string; inbound: Inbound } {
    const e = edge.edge;
    const inbound: Inbound = { fromStepId: step.id, edgeIndex: edge.index };
    if (e.handoff?.instruction) inbound.instruction = renderTemplate(e.handoff.instruction, this.contextData(), { strict: false });
    if (e.handoff?.include) inbound.include = e.handoff.include;
    if (e.handoff?.exclude) inbound.exclude = e.handoff.exclude;
    if (e.workspace) inbound.workspaceMode = e.workspace;
    const feedback = this.feedbackOf(step);
    if (feedback) inbound.feedback = feedback;

    if (e.resetLoopCounters) {
      for (const other of this.graph.edges) if (other.edge.loop && other.to === edge.to) this.state.edgeCounts[other.key] = 0;
    }
    if (e.loop) {
      const count = this.state.edgeCounts[edge.key] ?? 0;
      if (count >= e.loop.max) {
        this.emit("loop.limit_reached", { edge: `${edge.from}.${edge.port}->${edge.to}`, max: e.loop.max, escalateTo: e.loop.onExceeded }, step.id);
        inbound.exceeded = true;
        inbound.feedback = `${inbound.feedback ? `${inbound.feedback}\n\n` : ""}Schleifenlimit erreicht (${e.loop.max}× ${edge.from} → ${edge.to}).`;
        return { to: e.loop.onExceeded, inbound };
      }
      this.state.edgeCounts[edge.key] = count + 1;
      inbound.loop = { iteration: count + 2, max: e.loop.max + 1 };
      this.emit("loop.iteration", { edge: `${edge.from}.${edge.port}->${edge.to}`, iteration: count + 1, max: e.loop.max }, step.id);
    }
    return { to: edge.to, inbound };
  }

  private feedbackOf(step: StepRecord): string | undefined {
    if (step.script) return `Ausgabe von \`${step.script.command}\` (Exit-Code ${step.script.exitCode}):\n${step.script.output}`;
    const combined = step.combined as { feedback?: string } | undefined;
    if (combined?.feedback) return combined.feedback;
    if (step.nodeType === "human" && step.handoff?.handoff) return `Antwort des Nutzers: ${step.handoff.handoff}`;
    return undefined;
  }

  // ---------------------------------------------------------------- Knoten

  private async runNode(token: Token, node: Exclude<WorkflowNode, { type: "join" | "end" | "note" }>, step: StepRecord): Promise<NodeResult> {
    switch (node.type) {
      case "start":
        return { port: DEFAULT_PORT, handoff: { summary: "Run gestartet." } };
      case "agent":
        return this.runAgent(token, node, step);
      case "script":
        return this.runScript(token, node, step);
      case "condition": {
        const data = this.contextData();
        for (const [port, rule] of Object.entries(node.rules)) {
          if (truthy(evaluateCondition(rule, data))) return { port, handoff: { summary: `Bedingung „${port}“ erfüllt.` } };
        }
        return { port: "else", handoff: { summary: "Keine Bedingung erfüllt (sonst)." } };
      }
      case "human":
        return this.runHuman(token, node, step);
      case "map":
        return this.runMap(token, node, step);
      case "subworkflow":
        return this.runSubworkflow(token, node, step);
    }
  }

  private signalFor(step: StepRecord, timeoutMs?: number): AbortSignal {
    const controller = new AbortController();
    this.aborts.set(step.id, controller);
    return timeoutMs === undefined ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  }

  private async runScript(token: Token, node: NodeOf<"script">, step: StepRecord): Promise<NodeResult> {
    const command = renderTemplate(node.command, this.contextData());
    const signal = this.signalFor(step, parseDuration(node.timeout));
    const result = await this.deps.scripts.run(command, {
      cwd: token.workspace.path,
      timeoutMs: parseDuration(node.timeout),
      env: { ...node.env, AIFLOW_RUN_ID: this.state.id, AIFLOW_STEP_ID: step.id },
      signal,
    });
    step.script = { command, exitCode: result.exitCode, output: truncateMiddle(result.output, 20000) };
    let port: string | undefined;
    if (node.ports) {
      const data = { ...this.contextData(), exitCode: result.exitCode, output: result.output };
      for (const [name, spec] of Object.entries(node.ports)) {
        if (spec.when !== undefined && truthy(evaluateCondition(spec.when, data))) {
          port = name;
          break;
        }
      }
      port ??= Object.entries(node.ports).find(([, s]) => s.else)?.[0];
      if (!port) throw new AiflowError("INVALID_STATE", `Skript „${step.label}“: keine Port-Regel passt.`);
    } else port = result.exitCode === 0 ? "passed" : "failed";
    token.workspace = await this.deps.workspace.checkpoint(token.workspace, `aiflow: ${step.label} · Schritt ${this.stepNumber(step)}`);
    step.checkpointAfter = token.workspace.head;
    return { port, handoff: { summary: `\`${command}\` beendet mit Exit-Code ${result.exitCode}.` } };
  }

  private runHuman(token: Token, node: NodeOf<"human">, step: StepRecord): Promise<NodeResult> {
    const item: InboxItem = {
      id: this.deps.ids.next("inbox"),
      runId: this.state.id,
      stepId: step.id,
      kind: "human",
      title: step.label,
      question: renderTemplate(node.question, { ...this.contextData(), edge: { feedback: token.inbound.feedback ?? "" } }, { strict: false }),
      options: [...node.ports],
      allowFreeText: node.allowFreeText,
      createdAt: this.deps.clock.now(),
    };
    this.state.inbox.push(item);
    step.status = "waiting";
    token.status = "waiting";
    this.emit("input.requested", { itemId: item.id, question: item.question, options: item.options }, step.id);
    this.save();
    this.checkProgress();
    return new Promise<NodeResult>((resolve, reject) => {
      const signal = this.signalFor(step);
      signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (node.timeout && node.defaultPort) {
        const fallback = node.defaultPort;
        timer = setTimeout(() => this.answer(item.id, fallback, "(Zeitüberschreitung, Standardantwort)"), parseDuration(node.timeout));
        timer.unref?.();
      }
      this.pendingAnswers.set(item.id, (answer) => {
        if (timer) clearTimeout(timer);
        step.status = "running";
        token.status = "running";
        resolve({
          port: answer.option,
          handoff: { summary: `Antwort: ${answer.option}${answer.text ? ` – ${answer.text}` : ""}`, ...(answer.text ? { handoff: answer.text } : {}) },
        });
      });
    });
  }

  answer(itemId: string, option: string, text?: string): void {
    const item = this.state.inbox.find((i) => i.id === itemId);
    if (!item) throw new AiflowError("NOT_FOUND", `Eingabe „${itemId}“ existiert nicht.`);
    if (item.answeredAt !== undefined) throw new AiflowError("CONFLICT", "Diese Frage wurde bereits beantwortet.");
    if (!item.options.includes(option) && item.kind !== "question") throw new AiflowError("VALIDATION", `Unbekannte Antwort „${option}“. Möglich: ${item.options.join(", ")}.`);
    const pending = this.pendingAnswers.get(itemId);
    if (!pending) throw new AiflowError("INVALID_STATE", "Auf diese Frage wartet kein Schritt mehr.");
    item.answeredAt = this.deps.clock.now();
    item.answer = text ? { option, text } : { option };
    this.pendingAnswers.delete(itemId);
    this.emit("input.answered", { itemId, option, text }, item.stepId);
    pending(item.answer);
    this.checkProgress();
  }

  private async runSubworkflow(token: Token, node: NodeOf<"subworkflow">, step: StepRecord): Promise<NodeResult> {
    const { spec } = this.state;
    const child = spec.workflows[node.workflow];
    if (!child) throw new AiflowError("NOT_FOUND", `Sub-Workflow „${node.workflow}“ fehlt im Run-Snapshot.`);
    const prompt = renderTemplate(node.prompt, this.contextData(), { strict: false });
    const childId = this.engine.start({
      ...spec,
      workflow: child,
      input: { prompt },
      parentRunId: this.state.id,
      parentStepId: step.id,
      baseWorkspace: token.workspace,
      finalizeOverride: "none",
    });
    this.childRuns.set(step.id, childId);
    this.emit("log", { level: "info", message: `Sub-Workflow „${child.name}“ gestartet`, childRunId: childId }, step.id);
    const signal = this.signalFor(step);
    const final = await new Promise<RunState>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new CancelledError()), { once: true });
      void this.engine.wait(childId, TERMINAL_RUN_STATUSES).then(resolve, reject);
    });
    this.childRuns.delete(step.id);
    if (final.finalWorkspace) token.workspace = await this.deps.workspace.checkpoint(final.finalWorkspace, `aiflow: ${step.label}`);
    step.combined = { childRunId: childId };
    const port = final.outcome === "success" ? "success" : final.outcome === "rejected" ? "rejected" : "failed";
    return { port, handoff: { summary: `Sub-Workflow „${child.name}“ beendet: ${final.outcome ?? final.status}.`, details: final.error ?? final.review?.report ?? "" } };
  }

  // ---------------------------------------------------------------- Agent-Schritte

  private async runAgent(token: Token, node: NodeOf<"agent">, step: StepRecord): Promise<NodeResult> {
    const agent = this.agent(node.agent);
    const mode = token.inbound.workspaceMode ?? node.workspace?.mode ?? "continue";
    if (mode === "isolate") token.workspace = await this.deps.workspace.isolate(this.state.id, token.workspace, step.label);
    if (mode === "scratch") token.workspace = await this.deps.workspace.scratch(this.state.id, step.label);
    step.workspaceId = token.workspace.id;
    step.checkpointBefore = token.workspace.head;
    const readOnly = mode === "read-only";
    const writeScope = node.workspace?.writeScope;

    const branches = this.branchesFor(token.nodeId, node);
    const candidates = token.candidates;
    const handoffSchema = buildHandoffSchema({ branches, output: agent.output, ...(candidates ? { candidates: candidates.map((c) => c.id) } : {}) });
    const grants = this.documentGrants(node.documents);
    const delegationSettings = this.delegationSettings(agent, node);
    const delegationState = { waves: 0, runs: 0 };
    const offer: DelegationOffer | undefined = delegationSettings
      ? {
          allowed: delegationSettings.allowed.map((id) => ({ id, name: this.agent(id).name, description: this.agent(id).description })),
          mode: delegationSettings.mode,
          maxParallel: delegationSettings.maxParallel,
          remainingRuns: delegationSettings.maxRuns,
        }
      : undefined;
    if (delegationSettings) step.delegation = { waves: 0, runs: 0, budget: delegationSettings.maxRuns, running: 0 };

    const contextMode = node.contextMode ?? agent.contextMode;
    const session: AgentStepRequest["session"] = {};
    const previousSession = this.state.sessions[token.nodeId];
    if (contextMode === "resume" && previousSession) session.resume = previousSession;
    const fromStep = token.inbound.fromStepId ? this.state.steps[token.inbound.fromStepId] : undefined;
    if (contextMode === "fork" && fromStep?.sessionId) session.forkFrom = fromStep.sessionId;

    const diffStat = await this.deps.workspace.diffStat(token.workspace, token.workspace.base);
    const include = this.includeSet(token.inbound);
    const prompt = buildStepPrompt({
      workflowName: this.workflow.name,
      workflowDescription: this.workflow.description,
      stepNumber: this.stepNumber(step),
      nodeId: token.nodeId,
      nodeLabel: step.label,
      visit: step.visit,
      ...(token.inbound.loop ? { loop: token.inbound.loop } : {}),
      userPrompt: String(this.state.spec.input.prompt ?? ""),
      task: node.instructions ? renderTemplate(node.instructions, this.contextData(), { strict: false }) : agent.description,
      include,
      journal: this.journal(),
      ...(fromStep
        ? { inbound: this.inboundView(fromStep, token.inbound) }
        : token.inbound.feedback
          ? { inbound: { fromLabel: "Nutzer", feedback: token.inbound.feedback } }
          : {}),
      documents: grants,
      workspace: { path: token.workspace.path, readOnly, ...(writeScope ? { writeScope } : {}), diffStat },
      ...(candidates ? { candidates: candidates.map((c) => ({ id: c.id, label: c.label, path: c.workspace.path, ...(c.summary ? { summary: c.summary } : {}) })) } : {}),
      branches: branches.map((b) => ({ port: b.port, description: b.description })),
    });
    const systemPrompt = buildSystemPrompt(agent, this.snippets, offer);
    step.prompt = prompt;
    step.systemPrompt = systemPrompt;
    this.emit("step.context_built", { promptChars: prompt.length }, step.id);

    const permissions = this.permissionsFor(agent, { readOnly, grants, candidates, writeScope, workspacePath: token.workspace.path, delegation: delegationSettings });
    const retries = node.retries ?? agent.limits.retries;
    const timeoutMs = parseDuration(node.timeout ?? agent.limits.timeout);
    const votes = node.decision?.votes ?? agent.decision.votes;

    let lastError: unknown;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      step.attempt = attempt;
      const docsBefore = await this.readDocuments();
      const signal = this.signalFor(step, timeoutMs);
      const release = await this.acquireSession(signal);
      let releaseHeld: (() => void) | undefined = release;
      try {
        const request: AgentStepRequest = {
          runId: this.state.id,
          stepId: step.id,
          nodeId: token.nodeId,
          label: step.label,
          agent,
          systemPrompt,
          prompt,
          ...(node.model ?? agent.model ? { model: node.model ?? agent.model } : {}),
          workspace: { path: token.workspace.path, readOnly, ...(writeScope ? { writeScope } : {}) },
          permissions,
          handoffSchema,
          votes: branches.length > 1 ? votes : 1,
          documents: grants,
          ...(offer ? { delegation: { ...offer, remainingRuns: (delegationSettings?.maxRuns ?? 0) - delegationState.runs } } : {}),
          ...(session.resume || session.forkFrom ? { session } : {}),
          timeoutMs,
        };
        const context: AgentStepContext = {
          signal,
          activity: (a) => this.activity(step, a),
          delegate: async (tasks) => {
            if (!delegationSettings) throw new AiflowError("FORBIDDEN", "Dieser Knoten darf keine Sub-Agenten starten.");
            releaseHeld?.();
            releaseHeld = undefined;
            try {
              return await this.delegate(token, step, delegationSettings, delegationState, tasks, signal);
            } finally {
              releaseHeld = await this.acquireSession(signal);
            }
          },
          ask: (q) => this.askFromAgent(step, q),
        };
        const result = await this.deps.runtime.runAgentStep(request, context);
        releaseHeld?.();
        releaseHeld = undefined;
        step.sessionId = result.sessionId;
        if (result.usage) {
          step.metrics.inputTokens = (step.metrics.inputTokens ?? 0) + result.usage.inputTokens;
          step.metrics.outputTokens = (step.metrics.outputTokens ?? 0) + result.usage.outputTokens;
        }
        let handoff = parseHandoff(handoffSchema, result.handoff);
        if (result.votes && result.votes.length > 1 && branches.length > 1) {
          const parsed = result.votes.map((v) => parseHandoff(handoffSchema, v));
          const branchVotes = parsed.map((v) => v.branch ?? "");
          const outcome = majorityVote(branchVotes, node.decision?.fallback);
          step.votes = branchVotes;
          handoff = parsed.find((v) => v.branch === outcome.winner) ?? { ...handoff, branch: outcome.winner };
          this.emit("step.decision", { votes: branchVotes, winner: outcome.winner, tie: outcome.tie, reasons: parsed.map((p) => p.branchReason) }, step.id);
        } else if (handoff.branch) {
          this.emit("step.decision", { winner: handoff.branch, reason: handoff.branchReason }, step.id);
        }
        await this.postCheck(token, step, { grants, docsBefore, readOnly, writeScope, delegation: delegationSettings, delegationRuns: delegationState.runs });
        if (contextMode === "resume") this.state.sessions[token.nodeId] = result.sessionId;
        if (handoff.selectedCandidate && candidates) {
          const chosen = candidates.find((c) => c.id === handoff.selectedCandidate);
          if (chosen) token.workspace = chosen.workspace;
          delete token.candidates;
        }
        if (!readOnly) {
          token.workspace = await this.deps.workspace.checkpoint(token.workspace, `aiflow: ${step.label} · Schritt ${this.stepNumber(step)}`);
          step.checkpointAfter = token.workspace.head;
          this.emit("step.checkpoint", { commit: token.workspace.head }, step.id);
        }
        this.emit("step.handoff", { summary: handoff.summary, branch: handoff.branch, output: handoff.output }, step.id);
        const port = branches.length > 1 ? (handoff.branch ?? branches[0]?.port ?? DEFAULT_PORT) : (branches[0]?.port ?? DEFAULT_PORT);
        return { port, handoff };
      } catch (error) {
        releaseHeld?.();
        if (signal.aborted && signal.reason instanceof CancelledError) throw signal.reason;
        if (token.status === "cancelled") throw new CancelledError();
        lastError = signal.aborted ? new AiflowError("TIMEOUT", `Zeitlimit (${node.timeout ?? agent.limits.timeout}) überschritten.`) : error;
        step.metrics.retries = attempt - 1;
        if (attempt <= retries) {
          this.emit("step.retry", { attempt, error: errorMessage(lastError) }, step.id);
          if (!readOnly && step.checkpointBefore) token.workspace = await this.deps.workspace.reset(token.workspace, step.checkpointBefore);
        }
      } finally {
        this.aborts.delete(step.id);
      }
    }
    throw lastError instanceof Error ? lastError : new AiflowError("RUNTIME", errorMessage(lastError));
  }

  private async acquireSession(signal: AbortSignal): Promise<() => void> {
    const global = await this.engine.sessions.acquire(signal);
    try {
      const local = await this.runSessions.acquire(signal);
      return () => {
        local();
        global();
      };
    } catch (error) {
      global();
      throw error;
    }
  }

  private activity(step: StepRecord, a: StepActivity): void {
    switch (a.kind) {
      case "text":
        this.emit("step.text", { text: a.text }, step.id);
        return;
      case "tool":
        if (a.status === "called") step.metrics.toolCalls = (step.metrics.toolCalls ?? 0) + 1;
        this.emit("step.tool", { tool: a.tool, status: a.status, input: a.input, output: a.output ? truncateMiddle(a.output, 2000) : undefined }, step.id);
        return;
      case "progress":
        this.emit("step.progress", { message: a.message }, step.id);
        return;
      case "usage":
        step.metrics.inputTokens = (step.metrics.inputTokens ?? 0) + a.inputTokens;
        step.metrics.outputTokens = (step.metrics.outputTokens ?? 0) + a.outputTokens;
        return;
    }
  }

  private askFromAgent(step: StepRecord, q: { question: string; options: string[] }): Promise<string> {
    const item: InboxItem = {
      id: this.deps.ids.next("inbox"),
      runId: this.state.id,
      stepId: step.id,
      kind: "question",
      title: `Rückfrage von ${step.label}`,
      question: q.question,
      options: q.options,
      allowFreeText: true,
      createdAt: this.deps.clock.now(),
    };
    this.state.inbox.push(item);
    this.emit("input.requested", { itemId: item.id, question: item.question, options: item.options, kind: "question" }, step.id);
    this.save();
    return new Promise((resolve) => {
      this.pendingAnswers.set(item.id, (answer) => resolve(answer.text ?? answer.option));
    });
  }

  private branchesFor(nodeId: string, node: NodeOf<"agent">): BranchOption[] {
    const ports = node.ports && Object.keys(node.ports).length > 0 ? Object.entries(node.ports) : [[DEFAULT_PORT, { description: "" }] as const];
    return ports.map(([port, spec]) => ({
      port,
      description: spec.description,
      instructions: this.graph
        .out(nodeId, port)
        .map((e) => e.edge.handoff?.instruction)
        .filter((i): i is string => Boolean(i))
        .map((i) => renderTemplate(i, this.contextData(), { strict: false })),
    }));
  }

  private includeSet(inbound: Inbound): Set<ContextInclude> {
    const set = new Set<ContextInclude>(this.workflow.settings.context);
    for (const i of inbound.include ?? []) set.add(i);
    for (const i of inbound.exclude ?? []) set.delete(i);
    return set;
  }

  private inboundView(fromStep: StepRecord, inbound: Inbound) {
    const subagentResults = Object.values(this.state.steps)
      .filter((s) => s.parentStepId === fromStep.id)
      .map((s) => ({ agent: s.agentId ?? s.label, task: s.prompt?.split("\n")[0] ?? "", status: s.status, ...(s.handoff?.summary ? { summary: s.handoff.summary } : {}) }));
    return {
      fromLabel: fromStep.label,
      ...(fromStep.port ? { port: fromStep.port } : {}),
      ...(inbound.instruction ? { instruction: inbound.instruction } : {}),
      ...(fromStep.handoff?.summary ? { summary: fromStep.handoff.summary } : {}),
      ...(fromStep.handoff?.details ? { details: fromStep.handoff.details } : {}),
      ...(fromStep.handoff?.handoff ? { handoff: fromStep.handoff.handoff } : {}),
      ...(fromStep.handoff?.output !== undefined ? { output: fromStep.handoff.output } : {}),
      ...(inbound.feedback ? { feedback: inbound.feedback } : {}),
      ...(subagentResults.length > 0 ? { subagentResults } : {}),
    };
  }

  private journal(): JournalEntry[] {
    return this.state.stepOrder
      .map((id) => this.state.steps[id])
      .filter((s): s is StepRecord => Boolean(s && !s.parentStepId && s.status === "completed" && s.nodeType !== "start"))
      .map((s) => ({ label: s.label, ...(s.agentId ? { agent: s.agentId } : {}), summary: s.handoff?.summary ?? "", ...(s.port ? { port: s.port } : {}) }));
  }

  private documentGrants(access: Record<string, DocumentAccess>): DocumentGrant[] {
    return Object.entries(access)
      .filter((entry): entry is [string, Exclude<DocumentAccess, "none">] => entry[1] !== "none")
      .map(([name, a]) => ({ name, path: this.deps.documents.path(this.state.id, name), access: a, description: this.workflow.documents[name]?.description ?? "" }));
  }

  private async readDocuments(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const name of Object.keys(this.workflow.documents)) map.set(name, await this.deps.documents.read(this.state.id, name));
    return map;
  }

  private permissionsFor(
    agent: AgentDefinition,
    opts: {
      readOnly: boolean;
      grants: DocumentGrant[];
      candidates: Candidate[] | undefined;
      writeScope: string[] | undefined;
      workspacePath: string;
      delegation: SubagentSettings | undefined;
    },
  ): PermissionRule[] {
    const rules: PermissionRule[] = [...presetRules(agent.permissions.preset), ...agent.permissions.rules];
    if (agent.permissions.questions) rules.push({ action: "question", resource: "*", effect: "allow" });
    if (opts.readOnly) rules.push({ action: "edit", resource: "*", effect: "deny" });
    if (opts.writeScope) {
      rules.push({ action: "edit", resource: "*", effect: "deny" });
      for (const scope of opts.writeScope) rules.push({ action: "edit", resource: `${opts.workspacePath}/${scope}`, effect: "allow" });
    }
    if (opts.delegation?.mode === "enforced") {
      for (const action of ["read", "glob", "grep", "list", "edit", "shell", "webfetch", "websearch"]) {
        if (!opts.delegation.keepTools.includes(action)) rules.push({ action, resource: "*", effect: "deny" });
      }
    }
    rules.push({ action: "subagent", resource: "*", effect: "deny" });
    rules.push({ action: "external_directory", resource: "*", effect: "deny" });
    // Dokumente: Zugriff ausschließlich nach Freigabe
    for (const name of Object.keys(this.workflow.documents)) {
      const path = this.deps.documents.path(this.state.id, name);
      const grant = opts.grants.find((g) => g.name === name);
      if (!grant) {
        rules.push({ action: "read", resource: path, effect: "deny" }, { action: "edit", resource: path, effect: "deny" });
        continue;
      }
      rules.push({ action: "external_directory", resource: path, effect: "allow" }, { action: "read", resource: path, effect: "allow" });
      rules.push({ action: "edit", resource: path, effect: grant.access === "read" ? "deny" : "allow" });
    }
    for (const c of opts.candidates ?? []) {
      rules.push({ action: "external_directory", resource: `${c.workspace.path}/*`, effect: "allow" }, { action: "read", resource: `${c.workspace.path}/*`, effect: "allow" });
    }
    return rules;
  }

  private async postCheck(
    token: Token,
    step: StepRecord,
    o: {
      grants: DocumentGrant[];
      docsBefore: Map<string, string>;
      readOnly: boolean;
      writeScope: string[] | undefined;
      delegation: SubagentSettings | undefined;
      delegationRuns: number;
    },
  ): Promise<void> {
    if (o.delegation?.mode === "enforced" && o.delegationRuns === 0) {
      throw new AiflowError("VALIDATION", "Delegation ist erzwungen, aber es wurde keine Teilaufgabe delegiert.");
    }
    for (const [name, before] of o.docsBefore) {
      const after = await this.deps.documents.read(this.state.id, name);
      const grant = o.grants.find((g) => g.name === name);
      if (after === before) {
        if (grant?.access === "write-required") throw new AiflowError("VALIDATION", `Pflichtdokument „${name}“ wurde nicht geschrieben.`);
        continue;
      }
      const allowed = grant && (grant.access === "write" || grant.access === "write-required" || (grant.access === "append" && after.startsWith(before)));
      if (!allowed) {
        await this.deps.documents.write(this.state.id, name, before);
        this.emit("step.violation", { kind: "document", document: name, message: `Unerlaubte Änderung an „${name}“ zurückgesetzt.` }, step.id);
        continue;
      }
      await this.deps.documents.recordVersion(this.state.id, name, { stepId: step.id, ts: this.deps.clock.now(), content: after });
      this.emit("step.document_written", { document: name, chars: after.length }, step.id);
    }
    if (o.readOnly || o.writeScope) {
      const changes = await this.deps.workspace.changes(token.workspace, step.checkpointBefore ?? token.workspace.head);
      if (o.readOnly && changes.length > 0) {
        token.workspace = await this.deps.workspace.reset(token.workspace, step.checkpointBefore ?? token.workspace.head);
        this.emit("step.violation", { kind: "workspace", message: `Schreibzugriff im Nur-lesen-Workspace zurückgesetzt (${changes.length} Dateien).` }, step.id);
      } else if (o.writeScope) {
        const outside = changes.filter((c) => !o.writeScope?.some((scope) => matchesPattern(scope, c.path)));
        if (outside.length > 0) {
          throw new AiflowError("FORBIDDEN", `Änderungen außerhalb des Schreibbereichs (${o.writeScope.join(", ")}): ${outside.map((c) => c.path).join(", ")}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- Sub-Agenten und Für-jedes

  private delegationSettings(agent: AgentDefinition, node: NodeOf<"agent">): SubagentSettings | undefined {
    const merged = { ...(agent.subagents ?? {}), ...(node.subagents ?? {}) } as Partial<SubagentSettings>;
    if (!merged.enabled) return undefined;
    return {
      enabled: true,
      allowed: merged.allowed ?? [],
      mode: merged.mode ?? "optional",
      maxParallel: merged.maxParallel ?? 4,
      maxRuns: merged.maxRuns ?? 12,
      ...(merged.maxWaves !== undefined ? { maxWaves: merged.maxWaves } : {}),
      depth: merged.depth ?? 0,
      workspace: merged.workspace ?? "read-only",
      documents: merged.documents ?? "read",
      context: merged.context ?? ["input.prompt", "documents"],
      timeoutPerAgent: merged.timeoutPerAgent ?? "20m",
      keepTools: merged.keepTools ?? [],
    };
  }

  private async delegate(
    token: Token,
    step: StepRecord,
    settings: SubagentSettings,
    counters: { waves: number; runs: number },
    tasks: DelegationTask[],
    signal: AbortSignal,
  ): Promise<DelegationResult> {
    const remaining = settings.maxRuns - counters.runs;
    if (settings.maxWaves !== undefined && counters.waves >= settings.maxWaves) {
      this.emit("delegation.budget_exhausted", { reason: "waves" }, step.id);
      return { wave: counters.waves, results: [], remainingRuns: remaining, budgetExhausted: true, message: `Maximale Anzahl Wellen (${settings.maxWaves}) erreicht. Schließe mit dem bisherigen Stand ab.` };
    }
    if (remaining <= 0) {
      this.emit("delegation.budget_exhausted", { reason: "runs" }, step.id);
      return { wave: counters.waves, results: [], remainingRuns: 0, budgetExhausted: true, message: "Budget erschöpft. Schließe mit dem bisherigen Stand ab." };
    }
    counters.waves++;
    const wave = counters.waves;
    const results: DelegationResultItem[] = [];
    const runnable: { task: DelegationTask; index: number }[] = [];
    tasks.forEach((task, index) => {
      if (!settings.allowed.includes(task.agent)) {
        results[index] = { agent: task.agent, task: task.task, status: "failed", error: `Agent nicht erlaubt. Erlaubt: ${settings.allowed.join(", ")}` };
      } else if (runnable.length >= remaining) {
        results[index] = { agent: task.agent, task: task.task, status: "skipped", error: "Budget erschöpft" };
      } else runnable.push({ task, index });
    });
    counters.runs += runnable.length;
    if (step.delegation) step.delegation = { ...step.delegation, waves: wave, runs: counters.runs, running: runnable.length };
    this.emit("delegation.wave_started", { wave, tasks: runnable.map((r) => ({ agent: r.task.agent, task: r.task.task })), remaining: settings.maxRuns - counters.runs }, step.id);
    const subWorkspaces: WorkspaceRef[] = [];
    const outcomes = await mapLimit(runnable, settings.maxParallel, async ({ task, index }) => {
      const taskText = [task.task, task.expectedResult ? `Erwartetes Ergebnis: ${task.expectedResult}` : ""].filter(Boolean).join("\n\n");
      const outcome = await this.runSubStep(token, step, task.agent, taskText, {
        isolate: settings.workspace === "isolate",
        readDocuments: settings.documents === "read",
        includePrompt: settings.context.includes("input.prompt"),
        includeGoal: settings.context.includes("goal"),
        timeoutMs: parseDuration(settings.timeoutPerAgent),
        nodeType: "subagent",
        wave,
        label: `${this.agent(task.agent).name}`,
        signal,
      });
      if (outcome.workspace) subWorkspaces.push(outcome.workspace);
      return { index, item: outcome.item };
    });
    for (const o of outcomes) results[o.index] = o.item;
    if (settings.workspace === "isolate" && subWorkspaces.length > 0) {
      const merged = await this.deps.workspace.merge(token.workspace, subWorkspaces, `aiflow: Sub-Agenten Welle ${wave}`);
      token.workspace = merged.ref;
      if (merged.conflicts.length > 0) this.emit("log", { level: "warn", message: `Konflikte beim Zusammenführen: ${merged.conflicts.join(", ")}` }, step.id);
    }
    if (step.delegation) step.delegation = { ...step.delegation, running: 0 };
    const remainingRuns = settings.maxRuns - counters.runs;
    this.emit("delegation.wave_completed", { wave, completed: results.filter((r) => r.status === "completed").length, failed: results.filter((r) => r.status !== "completed").length, remaining: remainingRuns }, step.id);
    this.save();
    return { wave, results, remainingRuns, budgetExhausted: remainingRuns <= 0 };
  }

  private async runSubStep(
    token: Token,
    parent: StepRecord,
    agentId: string,
    task: string,
    o: {
      isolate: boolean;
      readDocuments: boolean;
      includePrompt: boolean;
      includeGoal: boolean;
      timeoutMs: number;
      nodeType: "subagent" | "map-item";
      wave?: number;
      label: string;
      signal: AbortSignal;
    },
  ): Promise<{ item: DelegationResultItem; workspace?: WorkspaceRef }> {
    const agent = this.agent(agentId);
    const workspace = o.isolate ? await this.deps.workspace.isolate(this.state.id, token.workspace, `${parent.label}-${o.label}`) : token.workspace;
    const step: StepRecord = {
      id: this.deps.ids.next("step"),
      runId: this.state.id,
      nodeId: parent.nodeId,
      nodeType: o.nodeType,
      label: o.label,
      agentId,
      parentStepId: parent.id,
      status: "running",
      attempt: 1,
      visit: 1,
      ...(o.wave !== undefined ? { wave: o.wave } : {}),
      startedAt: this.deps.clock.now(),
      metrics: {},
      workspaceId: workspace.id,
      checkpointBefore: workspace.head,
    };
    this.state.steps[step.id] = step;
    this.state.stepOrder.push(step.id);
    this.emit("step.started", { nodeId: step.nodeId, nodeType: step.nodeType, label: step.label, agentId, parentStepId: parent.id, wave: o.wave }, step.id);
    const grants: DocumentGrant[] = o.readDocuments
      ? Object.entries(this.workflow.documents).map(([name, d]) => ({ name, path: this.deps.documents.path(this.state.id, name), access: "read" as const, description: d.description }))
      : [];
    const handoffSchema = buildHandoffSchema({ output: agent.output });
    const promptParts = [task];
    if (o.includePrompt) promptParts.push(`## Gesamtauftrag (zur Einordnung)\n${String(this.state.spec.input.prompt ?? "")}`);
    if (o.includeGoal && this.workflow.description) promptParts.push(`## Ziel des Workflows\n${this.workflow.description}`);
    if (grants.length > 0) promptParts.push(`## Dokumente (nur lesen)\n${grants.map((g) => `- ${g.name}: ${g.path}`).join("\n")}`);
    promptParts.push(`## Arbeitsverzeichnis\n${workspace.path} (${o.isolate ? "eigener Workspace, schreibbar" : "nur lesen"})`);
    step.prompt = promptParts.join("\n\n");
    step.systemPrompt = buildSystemPrompt(agent, this.snippets);
    const controller = new AbortController();
    this.aborts.set(step.id, controller);
    const signal = AbortSignal.any([controller.signal, o.signal, AbortSignal.timeout(o.timeoutMs)]);
    let release: (() => void) | undefined;
    try {
      release = await this.acquireSession(signal);
      const result = await this.deps.runtime.runAgentStep(
        {
          runId: this.state.id,
          stepId: step.id,
          nodeId: parent.nodeId,
          parentStepId: parent.id,
          label: step.label,
          agent,
          systemPrompt: step.systemPrompt,
          prompt: step.prompt,
          ...(agent.model ? { model: agent.model } : {}),
          workspace: { path: workspace.path, readOnly: !o.isolate },
          permissions: this.permissionsFor(agent, { readOnly: !o.isolate, grants, candidates: undefined, writeScope: undefined, workspacePath: workspace.path, delegation: undefined }),
          handoffSchema,
          votes: 1,
          documents: grants,
          timeoutMs: o.timeoutMs,
        },
        {
          signal,
          activity: (a) => this.activity(step, a),
          delegate: () => Promise.reject(new AiflowError("FORBIDDEN", "Sub-Agenten dürfen keine weiteren Sub-Agenten starten (Verschachtelungstiefe 0).")),
          ask: (q) => this.askFromAgent(step, q),
        },
      );
      release();
      release = undefined;
      const handoff = parseHandoff(handoffSchema, result.handoff);
      step.sessionId = result.sessionId;
      step.handoff = handoff;
      if (result.usage) step.metrics = { ...step.metrics, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens };
      step.status = "completed";
      step.port = DEFAULT_PORT;
      let finalWorkspace: WorkspaceRef | undefined;
      if (o.isolate) {
        finalWorkspace = await this.deps.workspace.checkpoint(workspace, `aiflow: ${step.label}`);
        step.checkpointAfter = finalWorkspace.head;
      } else {
        const changes = await this.deps.workspace.changes(workspace, workspace.head);
        if (changes.length > 0) {
          await this.deps.workspace.reset(workspace, workspace.head);
          this.emit("step.violation", { kind: "workspace", message: "Sub-Agent hat im Nur-lesen-Workspace geschrieben; zurückgesetzt." }, step.id);
        }
      }
      step.finishedAt = this.deps.clock.now();
      step.metrics.durationMs = step.finishedAt - step.startedAt;
      this.emit("step.completed", { nodeId: step.nodeId, label: step.label, summary: handoff.summary, parentStepId: parent.id, durationMs: step.metrics.durationMs }, step.id);
      this.save();
      return {
        item: { agent: agentId, task, status: "completed", summary: handoff.summary, ...(handoff.output !== undefined ? { output: handoff.output } : {}), stepId: step.id },
        ...(finalWorkspace ? { workspace: finalWorkspace } : {}),
      };
    } catch (error) {
      release?.();
      step.status = o.signal.aborted ? "cancelled" : "failed";
      step.error = errorMessage(error);
      step.finishedAt = this.deps.clock.now();
      this.emit("step.failed", { nodeId: step.nodeId, label: step.label, error: step.error, parentStepId: parent.id }, step.id);
      this.save();
      if (o.signal.aborted) throw new CancelledError();
      return { item: { agent: agentId, task, status: "failed", error: step.error, stepId: step.id } };
    } finally {
      this.aborts.delete(step.id);
    }
  }

  private async runMap(token: Token, node: NodeOf<"map">, step: StepRecord): Promise<NodeResult> {
    const data = this.contextData();
    const items = getPath(data, node.items);
    if (!Array.isArray(items)) throw new AiflowError("VALIDATION", `„${node.items}“ ist keine Liste (Für-jedes „${step.label}“).`);
    const signal = this.signalFor(step);
    const subWorkspaces: WorkspaceRef[] = [];
    const outcomes = await mapLimit(items, node.maxParallel, async (item, index) => {
      const task = renderTemplate(node.task, { ...data, item, index: index + 1 }, { strict: false });
      const result = await this.runSubStep(token, step, node.agent, task, {
        isolate: node.workspace === "isolate",
        readDocuments: true,
        includePrompt: true,
        includeGoal: true,
        timeoutMs: parseDuration(this.agent(node.agent).limits.timeout),
        nodeType: "map-item",
        label: `${this.agent(node.agent).name} #${index + 1}`,
        signal,
      });
      if (result.workspace) subWorkspaces[index] = result.workspace;
      return result.item;
    });
    const ok = outcomes.filter((o) => o.status === "completed").length;
    step.combined = { results: outcomes };
    if (ok === 0 && items.length > 0) throw new AiflowError("RUNTIME", `Alle ${items.length} Teilaufgaben sind fehlgeschlagen.`);
    let port = DEFAULT_PORT;
    if (node.workspace === "isolate" && node.merge === "git-merge") {
      const merged = await this.deps.workspace.merge(token.workspace, subWorkspaces.filter(Boolean), `aiflow: ${step.label}`);
      token.workspace = merged.ref;
      if (merged.conflicts.length > 0) {
        port = CONFLICT_PORT;
        step.combined = { results: outcomes, conflicts: merged.conflicts, feedback: `Merge-Konflikte in: ${merged.conflicts.join(", ")}` };
      }
    }
    token.workspace = await this.deps.workspace.checkpoint(token.workspace, `aiflow: ${step.label}`);
    step.checkpointAfter = token.workspace.head;
    return { port, handoff: { summary: `${ok} von ${items.length} Teilaufgaben erfolgreich.`, output: outcomes.map((o) => ({ task: o.task, status: o.status, summary: o.summary })) } };
  }

  // ---------------------------------------------------------------- Join und Ende

  private async arriveAtJoin(token: Token, node: NodeOf<"join">): Promise<void> {
    const frame = token.forkStack[token.forkStack.length - 1];
    if (!frame) throw new AiflowError("INVALID_STATE", `Token erreicht Zusammenführung „${token.nodeId}“ ohne parallelen Zweig.`);
    const fork = this.state.forks[frame.forkId];
    if (!fork) throw new AiflowError("INVALID_STATE", `Unbekannte Parallelisierung ${frame.forkId}.`);
    token.status = "done";
    if (fork.fired) {
      this.emit("token.cancelled", { tokenId: token.id, reason: "verspätet" });
      this.save();
      this.pump();
      return;
    }
    fork.arrivals.push({ tokenId: token.id, branch: frame.branch, ...(token.inbound.fromStepId ? { stepId: token.inbound.fromStepId } : {}), workspace: token.workspace });
    const needed = node.wait === "all" ? fork.total : node.wait === "first" ? 1 : Math.min(node.n ?? fork.total, fork.total);
    if (fork.arrivals.length < needed) {
      this.save();
      this.pump();
      return;
    }
    fork.fired = true;
    // übrige Zweige abbrechen
    for (const t of this.state.tokens) {
      if (t.status === "done" || t.status === "cancelled") continue;
      if (t.forkStack.some((f) => f.forkId === fork.id)) {
        t.status = "cancelled";
        if (t.stepId) this.aborts.get(t.stepId)?.abort(new CancelledError("Zweig durch Zusammenführung beendet"));
        this.emit("token.cancelled", { tokenId: t.id, reason: "Zusammenführung bereits erfolgt" });
      }
    }
    const visit = (this.state.nodeVisits[token.nodeId] ?? 0) + 1;
    this.state.nodeVisits[token.nodeId] = visit;
    const next: Token = {
      id: this.deps.ids.next("tok"),
      nodeId: token.nodeId,
      status: "running",
      forkStack: token.forkStack.slice(0, -1),
      workspace: fork.baseWorkspace,
      inbound: {},
    };
    this.state.tokens.push(next);
    const step = this.newStep(next, node, visit);
    try {
      const result = await this.combineJoin(next, node, fork, step);
      this.completeStep(step, result);
      this.emit("token.joined", { forkId: fork.id, arrivals: fork.arrivals.length, port: result.port }, step.id);
      await this.route(next, step, result.port);
    } catch (error) {
      await this.failStep(next, step, error);
    }
  }

  private async combineJoin(token: Token, node: NodeOf<"join">, fork: ForkState, step: StepRecord): Promise<NodeResult> {
    const arrivals = [...fork.arrivals].sort((a, b) => a.branch - b.branch);
    const arrivedSteps = arrivals.map((a) => (a.stepId ? this.state.steps[a.stepId] : undefined));
    const branchSteps = arrivals.map((a) => this.lastAgentStepOfToken(a.tokenId, a.stepId));
    let port = DEFAULT_PORT;
    let summary = `${arrivals.length} von ${fork.total} Zweigen zusammengeführt.`;
    let feedback: string | undefined;
    const combined: Record<string, unknown> = {
      branches: arrivals.map((a, i) => ({ branch: a.branch, nodeId: arrivedSteps[i]?.nodeId, summary: branchSteps[i]?.handoff?.summary, output: branchSteps[i]?.handoff?.output })),
    };
    if (node.combine.strategy === "vote") {
      const field = node.combine.field ?? "output.approved";
      const values = branchSteps.map((s) => getPath(s?.handoff ?? {}, field));
      const bools = values.map((v) => v === true);
      const result = evaluateBooleanVote(bools, node.combine.rule ?? "majority");
      const ports = node.combine.ports ?? { true: "approved", false: "rejected" };
      port = ports[String(result)] ?? (result ? "approved" : "rejected");
      combined.votes = bools;
      summary = `Abstimmung (${node.combine.rule ?? "majority"}): ${bools.filter(Boolean).length} dafür, ${bools.filter((b) => !b).length} dagegen → ${port}.`;
      const objections = branchSteps.filter((_, i) => !bools[i]);
      if (objections.length > 0) {
        feedback = objections
          .map((s) => {
            const findings = (s?.handoff?.output as { findings?: { severity?: string; file?: string; line?: number; message?: string }[] } | undefined)?.findings ?? [];
            const list = findings.map((f) => `  - [${f.severity ?? "?"}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.message ?? ""}`).join("\n");
            return `### ${s?.label ?? "Zweig"}\n${s?.handoff?.summary ?? ""}${list ? `\n${list}` : ""}`;
          })
          .join("\n\n");
        combined.feedback = feedback;
      }
    }
    switch (node.workspace) {
      case "keep-base":
        token.workspace = fork.baseWorkspace;
        break;
      case "candidates":
        token.workspace = fork.baseWorkspace;
        token.candidates = arrivals.map((a, i) => {
          const s = branchSteps[i];
          const firstNode = this.firstNodeOfBranch(fork, a.tokenId) ?? `k${a.branch + 1}`;
          return { id: slugify(firstNode) || `k${a.branch + 1}`, label: s?.label ?? firstNode, workspace: a.workspace, ...(s?.handoff?.summary ? { summary: s.handoff.summary } : {}) };
        });
        combined.candidates = token.candidates.map((c) => ({ id: c.id, label: c.label, path: c.workspace.path }));
        break;
      case "git-merge": {
        const merged = await this.deps.workspace.merge(fork.baseWorkspace, arrivals.map((a) => a.workspace), `aiflow: ${step.label}`);
        token.workspace = merged.ref;
        if (merged.conflicts.length > 0) {
          port = CONFLICT_PORT;
          feedback = `Merge-Konflikte in: ${merged.conflicts.join(", ")}`;
          combined.feedback = feedback;
          combined.conflicts = merged.conflicts;
        }
        break;
      }
    }
    step.combined = combined;
    step.checkpointAfter = token.workspace.head;
    return { port, handoff: { summary, ...(feedback ? { details: feedback } : {}) } };
  }

  private firstNodeOfBranch(fork: ForkState, tokenId: string): string | undefined {
    void tokenId;
    const arrival = fork.arrivals.find((a) => a.tokenId === tokenId);
    if (!arrival) return undefined;
    const edges = this.graph.out(fork.fromNode).filter((e) => !e.edge.loop);
    return edges[arrival.branch]?.to;
  }

  /** Letzter Agent-Schritt eines Zweigs (für Abstimmungen über Skript-Knoten hinweg). */
  private lastAgentStepOfToken(tokenId: string, arrivalStepId: string | undefined): StepRecord | undefined {
    const steps = this.state.stepOrder.map((id) => this.state.steps[id]).filter((s): s is StepRecord => Boolean(s && s.tokenId === tokenId && !s.parentStepId && s.status === "completed"));
    const agentSteps = steps.filter((s) => s.nodeType === "agent");
    return agentSteps[agentSteps.length - 1] ?? (arrivalStepId ? this.state.steps[arrivalStepId] : undefined);
  }

  private reachEnd(token: Token, node: NodeOf<"end">): void {
    const step = this.newStep(token, node, (this.state.nodeVisits[token.nodeId] ?? 0) + 1);
    this.completeStep(step, { port: "", handoff: { summary: `Ende: ${node.outcome}` } });
    token.status = "done";
    if (!this.state.outcome || this.state.outcome === "success") this.state.outcome = node.outcome;
    this.state.endNodeId = token.nodeId;
    this.state.finalWorkspace = token.workspace;
    if (node.outcome === "failed" || node.outcome === "cancelled") this.abortAll(`Ende „${node.label ?? token.nodeId}“ erreicht`);
    this.save();
    this.pump();
  }

  private finalizing = false;

  private async finalize(): Promise<void> {
    if (this.finalizing || TERMINAL_RUN_STATUSES.includes(this.state.status) || this.state.status === "review_pending") return;
    this.finalizing = true;
    try {
      const endNode = this.state.endNodeId ? this.graph.node(this.state.endNodeId) : undefined;
      const outcome = this.state.outcome ?? "failed";
      const finalWs = this.state.finalWorkspace ?? this.state.baseWorkspace;
      let mode = this.state.spec.finalizeOverride ?? (endNode?.type === "end" ? endNode.finalize : undefined) ?? this.workflow.settings.finalize;
      if (outcome !== "success") mode = "none";
      if (!finalWs) {
        this.finish(outcome === "success" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed", "run.completed", {});
        return;
      }
      // Dokument-Export ins Repo
      let ws = finalWs;
      const data = this.contextData();
      const documents: { name: string; content: string }[] = [];
      for (const [name, spec] of Object.entries(this.workflow.documents)) {
        const content = await this.deps.documents.read(this.state.id, name);
        if (spec.requiredAtEnd && !content.trim()) this.emit("log", { level: "warn", message: `Pflichtdokument „${name}“ ist am Ende leer.` });
        if (spec.showInReview && content.trim()) documents.push({ name, content });
        if (spec.exportTo && content.trim() && mode !== "none") {
          const target = renderTemplate(spec.exportTo, data, { strict: false });
          await this.deps.workspace.writeFile(ws, target, content);
          this.emit("docs.exported", { document: name, path: target });
        }
      }
      ws = await this.deps.workspace.checkpoint(ws, "aiflow: Abschluss");
      this.state.finalWorkspace = ws;
      const files = await this.deps.workspace.changes(ws, ws.base, this.state.spec.projectDir);
      const report = endNode?.type === "end" && endNode.report ? renderTemplate(endNode.report, data, { strict: false }) : this.defaultReport(files.length);
      const review: ReviewData = { runId: this.state.id, report, files, documents, finalize: mode };
      this.state.review = review;
      switch (mode) {
        case "none":
          this.finish(outcome === "cancelled" ? "cancelled" : outcome === "failed" ? "failed" : "completed", "run.completed", {});
          return;
        case "review":
          this.state.inbox.push({
            id: this.deps.ids.next("inbox"),
            runId: this.state.id,
            kind: "review",
            title: `Review: ${this.workflow.name}`,
            question: `${files.length} geänderte Dateien prüfen und übernehmen?`,
            options: ["apply", "discard", "branch", "request-changes"],
            allowFreeText: true,
            createdAt: this.deps.clock.now(),
          });
          this.setStatus("review_pending");
          this.emit("run.review_pending", { files: files.length });
          this.save();
          return;
        case "apply": {
          const result = await this.deps.workspace.apply(ws, this.state.spec.projectDir);
          if (result.conflicts.length > 0) {
            this.emit("apply.conflict", { conflicts: result.conflicts });
            this.setStatus("review_pending");
            this.emit("run.review_pending", { files: files.length, reason: "conflicts" });
            this.save();
            return;
          }
          review.decided = { action: "apply", at: this.deps.clock.now(), detail: `${result.applied.length} Dateien übernommen` };
          this.emit("apply.completed", { files: result.applied });
          this.finish("completed", "run.completed", {});
          return;
        }
        case "branch": {
          const name = await this.deps.workspace.createBranch(ws, this.state.spec.projectDir, this.branchName());
          review.decided = { action: "branch", at: this.deps.clock.now(), detail: name };
          this.emit("branch.created", { branch: name });
          this.finish("completed", "run.completed", {});
          return;
        }
        case "patch": {
          const patch = await this.deps.workspace.patch(ws);
          review.decided = { action: "branch", at: this.deps.clock.now(), detail: patch };
          this.finish("completed", "run.completed", {});
          return;
        }
      }
    } finally {
      this.finalizing = false;
    }
  }

  private defaultReport(fileCount: number): string {
    const lines = [`# ${this.workflow.name}`, "", `**Auftrag:** ${String(this.state.spec.input.prompt ?? "")}`, "", "## Ablauf"];
    for (const e of this.journal()) lines.push(`- **${e.label}**: ${e.summary}${e.port && e.port !== "next" ? ` → ${e.port}` : ""}`);
    lines.push("", `**Geänderte Dateien:** ${fileCount}`);
    return lines.join("\n");
  }

  private branchName(): string {
    const date = new Date(this.state.createdAt).toISOString().slice(0, 10);
    return `aiflow/${this.workflow.id}/${date}-${this.state.id.slice(-6)}`;
  }

  async decideReview(decision: ReviewDecision): Promise<void> {
    if (this.state.status !== "review_pending" || !this.state.review || !this.state.finalWorkspace) {
      throw new AiflowError("INVALID_STATE", "Für diesen Run steht kein Review aus.");
    }
    const ws = this.state.finalWorkspace;
    const review = this.state.review;
    const now = this.deps.clock.now();
    const item = this.state.inbox.find((i) => i.kind === "review" && i.answeredAt === undefined);
    if (item) {
      item.answeredAt = now;
      item.answer = { option: decision.action };
    }
    switch (decision.action) {
      case "apply": {
        const result = await this.deps.workspace.apply(ws, this.state.spec.projectDir, decision.files);
        if (result.conflicts.length > 0) {
          this.emit("apply.conflict", { conflicts: result.conflicts });
          throw new AiflowError("CONFLICT", `Konflikte beim Übernehmen: ${result.conflicts.join(", ")}`);
        }
        review.decided = { action: "apply", at: now, detail: `${result.applied.length} Dateien übernommen` };
        this.emit("apply.completed", { files: result.applied });
        this.emit("review.decided", { action: "apply" });
        this.finish("completed", "run.completed", {});
        return;
      }
      case "discard":
        review.decided = { action: "discard", at: now };
        this.state.outcome = "rejected";
        this.emit("review.decided", { action: "discard" });
        this.finish("completed", "run.completed", {});
        return;
      case "branch": {
        const name = await this.deps.workspace.createBranch(ws, this.state.spec.projectDir, decision.name ?? this.branchName());
        review.decided = { action: "branch", at: now, detail: name };
        this.emit("branch.created", { branch: name });
        this.emit("review.decided", { action: "branch", branch: name });
        this.finish("completed", "run.completed", {});
        return;
      }
      case "request-changes": {
        const target = decision.nodeId ?? this.lastWritingAgentNode();
        if (!target || !this.workflow.nodes[target]) throw new AiflowError("VALIDATION", "Kein Knoten für die Nachbesserung gefunden.");
        this.emit("review.decided", { action: "request-changes", nodeId: target, feedback: decision.feedback });
        delete this.state.review;
        delete this.state.endNodeId;
        delete this.state.outcome;
        this.state.tokens.push({
          id: this.deps.ids.next("tok"),
          nodeId: target,
          status: "ready",
          forkStack: [],
          workspace: ws,
          inbound: { feedback: `Review-Feedback des Nutzers:\n${decision.feedback}`, include: ["feedback"] },
        });
        this.setStatus("running");
        this.emit("run.resumed", { reason: "request-changes" });
        this.save();
        this.pump();
        return;
      }
    }
  }

  private lastWritingAgentNode(): string | undefined {
    for (let i = this.state.stepOrder.length - 1; i >= 0; i--) {
      const s = this.state.steps[this.state.stepOrder[i] ?? ""];
      if (!s || s.parentStepId || s.nodeType !== "agent" || s.status !== "completed") continue;
      const node = this.workflow.nodes[s.nodeId];
      if (node?.type === "agent" && (node.workspace?.mode ?? "continue") !== "read-only") return s.nodeId;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- Hilfen

  private agent(id: string): AgentDefinition {
    const agent = this.state.spec.agents[id];
    if (!agent) throw new AiflowError("NOT_FOUND", `Agent „${id}“ fehlt im Run-Snapshot.`);
    return agent;
  }

  private stepNumber(step: StepRecord): number {
    const top = this.state.stepOrder.filter((id) => !this.state.steps[id]?.parentStepId);
    return top.indexOf(step.id) + 1;
  }

  /** Daten für Templates und Bedingungen (PLAN.md 7.13). */
  contextData(): Record<string, unknown> {
    const nodes: Record<string, unknown> = {};
    const scripts: Record<string, unknown> = {};
    const joins: Record<string, unknown> = {};
    for (const nodeId of Object.keys(this.workflow.nodes)) {
      const step = lastStepOf(this.state, nodeId);
      nodes[nodeId] = {
        visits: this.state.nodeVisits[nodeId] ?? 0,
        ...(step ? { summary: step.handoff?.summary, output: step.handoff?.output, branch: step.port, details: step.handoff?.details } : {}),
      };
      if (step?.script) scripts[nodeId] = { exitCode: step.script.exitCode, output: step.script.output };
      if (step?.nodeType === "join") joins[nodeId] = step.combined;
    }
    const docs: Record<string, unknown> = {};
    for (const name of Object.keys(this.workflow.documents)) docs[name] = { path: this.deps.documents.path(this.state.id, name) };
    const prompt = String(this.state.spec.input.prompt ?? "");
    return {
      input: this.state.spec.input,
      vars: this.workflow.variables,
      run: { id: this.state.id, date: new Date(this.state.createdAt).toISOString().slice(0, 10), slug: slugify(prompt) || this.state.id, workflow: this.workflow.id },
      node: nodes,
      script: scripts,
      join: joins,
      docs,
      workspace: {},
    };
  }

  private emit(type: RunEventType, data: Record<string, unknown>, stepId?: string): void {
    this.state.seq++;
    const event: RunEvent = { runId: this.state.id, seq: this.state.seq, ts: this.deps.clock.now(), type, ...(stepId ? { stepId } : {}), data };
    this.engine.publish(event);
  }

  private save(): void {
    this.deps.sink.saveState(this.state);
  }
}
