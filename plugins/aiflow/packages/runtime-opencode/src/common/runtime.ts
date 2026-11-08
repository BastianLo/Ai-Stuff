import { AiflowError } from "@aiflow/core";
import type { AgentRuntime, AgentStepContext, AgentStepRequest, AgentStepResult, RuntimeCapabilities } from "@aiflow/engine";
import type { WorkerBridge } from "./bridge.js";
import type { OpencodeDriver, SessionActivity } from "./driver.js";
import { extractJson, finalizePrompt } from "./handoff.js";
import { expandMcpRules } from "./permissions.js";

/** AgentRuntime über einen opencode-Worker (v1 oder v2, je nach Treiber). */
export class OpencodeRuntime implements AgentRuntime {
  readonly id: string;
  private readonly listeners = new Map<string, (a: SessionActivity) => void>();
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
      for await (const event of this.driver.activity(this.stop.signal)) this.listeners.get(event.sessionId)?.(event);
    } catch {
      /* Stream beendet; der Worker-Supervisor startet neu */
    }
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
    this.listeners.set(sessionId, (e) => context.activity(e.activity));
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
