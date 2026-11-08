import { AiflowError, assertNever } from "@aiflow/core";
import type { AgentRuntime, AgentStepContext, AgentStepRequest, AgentStepResult, RuntimeCapabilities, StepActivity } from "@aiflow/engine";
import type { WorkerBridge } from "./bridge.js";
import type { DriverEvent, OpencodeDriver, PermissionAsked, PermissionReply } from "./driver.js";
import { extractJson, finalizePrompt } from "./handoff.js";
import { expandMcpRules } from "./permissions.js";

/** Antwortoptionen, wenn eine Rückfrage von opencode in der Inbox landet. */
export const PERMISSION_OPTIONS = { once: "Einmal erlauben", step: "Für diesen Schritt erlauben", reject: "Ablehnen" } as const;

/** AgentRuntime über einen opencode-Worker (v1 oder v2, je nach Treiber). */
export class OpencodeRuntime implements AgentRuntime {
  readonly id: string;
  private readonly listeners = new Map<string, (a: StepActivity) => void>();
  /** Pro Schritt-Session: Aktionen, die der Nutzer „für diesen Schritt“ erlaubt hat. */
  private readonly approved = new Map<string, Set<string>>();
  private readonly stop = new AbortController();

  constructor(
    private readonly driver: OpencodeDriver,
    private readonly bridge: WorkerBridge,
  ) {
    this.id = `opencode-${driver.api}`;
    void this.pumpActivity();
  }

  capabilities(): RuntimeCapabilities {
    return this.driver.capabilities();
  }

  dispose(): void {
    this.stop.abort();
  }

  private async pumpActivity(): Promise<void> {
    try {
      for await (const event of this.driver.activity(this.stop.signal)) this.handle(event);
    } catch {
      /* Stream beendet; der Worker-Supervisor startet neu */
    }
  }

  /** Verteilt ein Ereignis des Workers. Kind-Sessions nativer Sub-Agenten zählen zum Schritt ihrer Eltern-Session. */
  handle(event: DriverEvent): void {
    if ("activity" in event) {
      const root = this.bridge.root(event.sessionId);
      if (root) this.listeners.get(root)?.(event.activity);
      return;
    }
    switch (event.type) {
      case "session.created":
        this.bridge.adoptChild(event.sessionId, event.parentId);
        return;
      case "permission.asked":
        void this.answerPermission(event);
        return;
      default:
        assertNever(event, "Worker-Ereignis");
    }
  }

  /**
   * Beantwortet eine Rückfrage von opencode („ask“) nach `permissions.onAsk` des Agenten. Ohne Antwort würde die
   * Session stehen bleiben; in einer normalen Session beantwortet der Nutzer sie im TUI, hier über die Inbox.
   */
  private async answerPermission(event: PermissionAsked): Promise<void> {
    const step = this.bridge.step(event.sessionId);
    if (!step) return; // keine AiFlow-Session
    const { request, context, rootId } = step;
    const what = event.resources.length > 0 && !(event.resources.length === 1 && event.resources[0] === "*") ? `„${event.action}“ auf ${event.resources.join(", ")}` : `„${event.action}“`;
    const decide = async (): Promise<{ reply: PermissionReply; message?: string }> => {
      if (this.approved.get(rootId)?.has(event.action)) return { reply: "once" };
      const policy = request.agent.permissions.onAsk;
      switch (policy) {
        case "allow":
          return { reply: "once" };
        case "deny":
          return { reply: "reject", message: `AiFlow: ${what} ist für diesen Agenten nicht freigegeben. Arbeite ohne diese Aktion weiter.` };
        case "inbox": {
          const answer = await context.ask({
            kind: "permission",
            question: `${request.label} möchte ${what} ausführen. opencode fragt nach einer Erlaubnis.`,
            options: [PERMISSION_OPTIONS.once, PERMISSION_OPTIONS.step, PERMISSION_OPTIONS.reject],
          });
          if (answer === PERMISSION_OPTIONS.once) return { reply: "once" };
          if (answer === PERMISSION_OPTIONS.step) {
            const set = this.approved.get(rootId) ?? new Set<string>();
            set.add(event.action);
            this.approved.set(rootId, set);
            return { reply: "once" };
          }
          // „Ablehnen“ oder Freitext: Freitext geht als Korrektur an das Modell
          return { reply: "reject", message: answer === PERMISSION_OPTIONS.reject ? `AiFlow: Der Nutzer hat ${what} abgelehnt.` : `AiFlow: Der Nutzer hat ${what} abgelehnt: ${answer}` };
        }
        default:
          return assertNever(policy, "onAsk");
      }
    };
    const decision = await decide().catch(() => ({ reply: "reject" as const, message: "AiFlow: Der Schritt wurde beendet." }));
    await this.driver
      .replyPermission({ sessionId: event.sessionId, requestId: event.requestId, reply: decision.reply, directory: request.workspace.path, ...(decision.message ? { message: decision.message } : {}) })
      .catch(() => undefined);
  }

  /** Bekannte MCP-Server (global + Projekt-Konfiguration des Verzeichnisses); bei Fehlern leer. */
  private async mcpServers(directory: string): Promise<string[]> {
    const list = await this.driver.listMcp(directory).catch(() => []);
    return list.map((s) => s.name).filter((n) => n.length > 0);
  }

  async runAgentStep(request: AgentStepRequest, context: AgentStepContext): Promise<AgentStepResult> {
    const directory = request.workspace.path;
    // MCP-Regeln einmal auflösen; Session-Rechte und harte Prüfung im Plugin nutzen dieselben Regeln.
    request = { ...request, permissions: expandMcpRules(request.permissions, await this.mcpServers(directory)) };
    const sessionId = request.session?.resume
      ? request.session.resume
      : request.session?.forkFrom
        ? await this.driver.forkSession(request.session.forkFrom, directory)
        : await this.driver.createSession({
            directory,
            title: `AiFlow · ${request.label}`,
            permissions: request.permissions,
            metadata: { aiflowRunId: request.runId, aiflowStepId: request.stepId },
            ...(request.model ? { model: request.model } : {}),
          });
    this.bridge.bind(sessionId, request, context);
    this.listeners.set(sessionId, (a) => context.activity(a));
    const onAbort = (): void => void this.driver.abort(sessionId, directory).catch(() => undefined);
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const work = await this.driver.run(sessionId, { text: request.prompt, system: request.systemPrompt, directory, ...(request.model ? { model: request.model } : {}) }, context.signal);
      let usage = work.usage;
      const handoff = await this.finalize(sessionId, request, context.signal, (u) => (usage = add(usage, u)));
      const votes: unknown[] = [handoff];
      for (let i = 1; i < request.votes; i++) {
        const fork = await this.driver.forkSession(sessionId, directory);
        this.bridge.bind(fork, request, context);
        try {
          votes.push(await this.finalize(fork, request, context.signal, (u) => (usage = add(usage, u))));
        } finally {
          this.bridge.unbind(fork);
        }
      }
      return { sessionId, handoff, ...(request.votes > 1 ? { votes } : {}), ...(usage ? { usage } : {}) };
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      this.listeners.delete(sessionId);
      this.approved.delete(sessionId);
      this.bridge.unbind(sessionId);
    }
  }

  /** Abschluss-Phase: v1 per `format: json_schema`, v2 per Tool `aiflow_handoff` (PLAN.md 8.4). */
  private async finalize(sessionId: string, request: AgentStepRequest, signal: AbortSignal, onUsage: (u: { inputTokens: number; outputTokens: number }) => void): Promise<unknown> {
    const mode = this.driver.capabilities().structuredOutput === "tool" ? "tool" : "format";
    const directory = request.workspace.path;
    this.bridge.setPhase(sessionId, "finalize");
    for (let attempt = 1; attempt <= 3; attempt++) {
      const prompt = attempt === 1 ? finalizePrompt(request.handoffSchema, mode) : "Die Übergabe fehlt oder ist ungültig. Bitte jetzt korrekt nachholen.";
      const result = await this.driver.run(
        sessionId,
        { text: prompt, system: request.systemPrompt, directory, ...(request.model ? { model: request.model } : {}), ...(mode === "format" ? { format: request.handoffSchema } : {}) },
        signal,
      );
      if (result.usage) onUsage(result.usage);
      if (mode === "tool" && this.bridge.hasHandoff(sessionId)) return this.bridge.takeHandoff(sessionId);
      if (mode === "format" && result.structured !== undefined) return result.structured;
      const parsed = extractJson(result.text);
      if (parsed !== undefined) return parsed;
    }
    throw new AiflowError("RUNTIME", "Der Agent hat keine strukturierte Übergabe geliefert.");
  }
}

function add(a: { inputTokens: number; outputTokens: number } | undefined, b: { inputTokens: number; outputTokens: number }) {
  return { inputTokens: (a?.inputTokens ?? 0) + b.inputTokens, outputTokens: (a?.outputTokens ?? 0) + b.outputTokens };
}
