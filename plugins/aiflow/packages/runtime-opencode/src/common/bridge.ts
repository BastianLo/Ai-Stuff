import { AiflowError, evaluatePermission, formatIssues, validateJsonSchema, type JsonSchema } from "@aiflow/core";
import type { AgentStepContext, AgentStepRequest, DelegationResult, DelegationTask } from "@aiflow/engine";

export interface SessionInfo {
  runId: string;
  stepId: string;
  label: string;
  systemPrompt: string;
  handoffSchema: JsonSchema;
  delegation?: AgentStepRequest["delegation"];
  workspace: AgentStepRequest["workspace"];
  documents: AgentStepRequest["documents"];
  model?: AgentStepRequest["model"];
  temperature?: number;
  topP?: number;
  permissions: AgentStepRequest["permissions"];
  phase: "work" | "finalize";
  handoffReceived: boolean;
}

export interface GuardDecision {
  allow: boolean;
  message?: string;
}

interface Binding {
  phase: "work" | "finalize";
  request: AgentStepRequest;
  context: AgentStepContext;
  handoff?: unknown;
  handoffWaiters: ((value: unknown) => void)[];
}

/**
 * Verbindung zwischen Engine und AiFlow-Plugin im Worker. Das Plugin meldet Übergaben, Delegationen,
 * Fortschritt und Guard-Anfragen über die Worker-API des Daemons; die Bridge leitet sie an den Schritt weiter.
 */
export class WorkerBridge {
  private readonly bindings = new Map<string, Binding>();

  bind(sessionId: string, request: AgentStepRequest, context: AgentStepContext): void {
    this.bindings.set(sessionId, { request, context, handoffWaiters: [], phase: "work" });
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.bindings.has(sessionId);
  }

  private binding(sessionId: string): Binding {
    const b = this.bindings.get(sessionId);
    if (!b) throw new AiflowError("NOT_FOUND", `Session ${sessionId} gehört zu keinem laufenden AiFlow-Schritt.`);
    return b;
  }

  setPhase(sessionId: string, phase: "work" | "finalize"): void {
    const b = this.bindings.get(sessionId);
    if (b) b.phase = phase;
  }

  info(sessionId: string): SessionInfo {
    const b = this.binding(sessionId);
    const { request } = b;
    return {
      runId: request.runId,
      stepId: request.stepId,
      label: request.label,
      systemPrompt: request.systemPrompt,
      handoffSchema: request.handoffSchema,
      ...(request.delegation ? { delegation: request.delegation } : {}),
      workspace: request.workspace,
      documents: request.documents,
      ...(request.model ? { model: request.model } : {}),
      ...(request.model?.temperature !== undefined ? { temperature: request.model.temperature } : {}),
      ...(request.model?.topP !== undefined ? { topP: request.model.topP } : {}),
      permissions: request.permissions,
      phase: b.phase,
      handoffReceived: b.handoff !== undefined,
    };
  }

  /** Nimmt eine Übergabe an (v2: Tool `aiflow_handoff`). Ungültige Eingaben liefern Fehler für das Modell. */
  submitHandoff(sessionId: string, input: unknown): { ok: true } | { ok: false; error: string } {
    const b = this.binding(sessionId);
    const issues = validateJsonSchema(b.request.handoffSchema, input);
    if (issues.length > 0) return { ok: false, error: `Übergabe passt nicht zum Schema: ${formatIssues(issues)}. Bitte korrigiert erneut aufrufen.` };
    b.handoff = input;
    for (const w of b.handoffWaiters.splice(0)) w(input);
    return { ok: true };
  }

  takeHandoff(sessionId: string): unknown {
    const b = this.binding(sessionId);
    const value = b.handoff;
    delete b.handoff;
    return value;
  }

  hasHandoff(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.handoff !== undefined;
  }

  delegate(sessionId: string, tasks: DelegationTask[]): Promise<DelegationResult> {
    const b = this.binding(sessionId);
    if (!b.request.delegation) throw new AiflowError("FORBIDDEN", "Dieser Schritt darf keine Sub-Agenten starten.");
    return b.context.delegate(tasks);
  }

  progress(sessionId: string, message: string): void {
    this.binding(sessionId).context.activity({ kind: "progress", message });
  }

  /** Kontext zum Nachschlagen (Tool `aiflow_context`). */
  context(sessionId: string, query: string): string {
    const { request } = this.binding(sessionId);
    const sections = request.prompt.split(/\n(?=## )/);
    const q = query.trim().toLowerCase();
    const hits = q ? sections.filter((s) => s.toLowerCase().includes(q)) : sections;
    return hits.length > 0 ? hits.join("\n\n") : `Kein Abschnitt zu „${query}“ gefunden. Verfügbar: ${sections.map((s) => s.split("\n")[0]).join(", ")}`;
  }

  /** Prüft einen Tool-Aufruf gegen die Session-Regeln (harte Durchsetzung im Plugin). */
  guard(sessionId: string, action: string, resource: string): GuardDecision {
    const b = this.bindings.get(sessionId);
    if (!b) return { allow: true };
    const effect = evaluatePermission(b.request.permissions, action, resource, "allow");
    if (effect === "deny") return { allow: false, message: `AiFlow: „${action}“ auf „${resource}“ ist in diesem Schritt nicht erlaubt.` };
    return { allow: true };
  }
}
