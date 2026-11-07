import { evaluatePermission } from "@aiflow/core";
import { guardToolCall, type WorkerApi, type WorkerSessionInfo } from "./worker.js";

/** Versionsneutrale Logik der Worker-Rolle; die Shells rufen sie aus ihren Hooks auf. */
export class WorkerHooks {
  private readonly idleNudges = new Map<string, number>();

  constructor(readonly api: WorkerApi) {}

  info(sessionId: string): Promise<WorkerSessionInfo | null> {
    return this.api.info(sessionId);
  }

  /** Wirft, wenn der Tool-Aufruf gegen die Regeln des Schritts verstößt. */
  async guard(sessionId: string, tool: string, input: unknown): Promise<void> {
    const info = await this.api.info(sessionId);
    if (!info) return;
    const message = guardToolCall(info, tool, input);
    if (message) throw new Error(message);
  }

  /** v2-Rechte-Hook: liefert `deny` mit Meldung, wenn AiFlow-Regeln verbieten. */
  async evaluate(sessionId: string, action: string, resources: readonly string[]): Promise<{ deny: boolean; message?: string }> {
    const info = await this.api.info(sessionId);
    if (!info) return { deny: false };
    for (const resource of resources.length > 0 ? resources : ["*"]) {
      if (evaluatePermission(info.permissions, action, resource, "allow") === "deny") {
        return { deny: true, message: `AiFlow: „${action}“ auf „${resource}“ ist in Schritt „${info.label}“ nicht erlaubt.` };
      }
    }
    return { deny: false };
  }

  async env(sessionId: string | undefined): Promise<Record<string, string>> {
    if (!sessionId) return {};
    const info = await this.api.info(sessionId);
    if (!info) return {};
    const docsDir = info.documents[0]?.path.replace(/\/[^/]+$/, "") ?? "";
    return { AIFLOW_RUN_ID: info.runId, AIFLOW_STEP_ID: info.stepId, ...(docsDir ? { AIFLOW_DOCS_DIR: docsDir } : {}) };
  }

  async compactionContext(sessionId: string): Promise<string | undefined> {
    const info = await this.api.info(sessionId);
    if (!info) return undefined;
    const docs = info.documents.map((d) => `- ${d.name} (${d.access}): ${d.path}`).join("\n");
    return `AiFlow-Schritt „${info.label}“. Arbeitsverzeichnis: ${info.workspace.path}${info.workspace.readOnly ? " (nur lesen)" : ""}.${docs ? `\nDokumente:\n${docs}` : ""}\nNutze aiflow_context, um den Auftrag nachzuschlagen.`;
  }

  /** v2: Fehlt nach der Abschluss-Aufforderung die Übergabe, einmalig (max. 2×) nachfordern. */
  async idleNudge(sessionId: string): Promise<string | undefined> {
    const info = await this.api.info(sessionId, true);
    if (!info || info.phase !== "finalize" || info.handoffReceived) return undefined;
    const count = (this.idleNudges.get(sessionId) ?? 0) + 1;
    this.idleNudges.set(sessionId, count);
    if (count > 2) return undefined;
    return "AiFlow: Die Übergabe fehlt noch. Rufe jetzt das Tool `aiflow_handoff` mit deiner Übergabe auf.";
  }

  async handoff(sessionId: string, input: unknown): Promise<string> {
    const result = await this.api.handoff(sessionId, input);
    if (!result.ok) throw new Error(result.error ?? "Übergabe abgelehnt");
    return "Übergabe angenommen. Du bist fertig.";
  }

  async delegate(sessionId: string, input: unknown): Promise<string> {
    const tasks = typeof input === "object" && input !== null ? (input as { tasks?: unknown }).tasks : undefined;
    return JSON.stringify(await this.api.delegate(sessionId, tasks), null, 2);
  }

  async progress(sessionId: string, input: unknown): Promise<string> {
    const raw = typeof input === "object" && input !== null ? (input as { message?: unknown }).message : undefined;
    const message = typeof raw === "string" ? raw : "";
    await this.api.progress(sessionId, message);
    return "ok";
  }

  async context(sessionId: string, input: unknown): Promise<string> {
    const raw = typeof input === "object" && input !== null ? (input as { query?: unknown }).query : undefined;
    const query = typeof raw === "string" ? raw : "";
    return this.api.context(sessionId, query);
  }
}
