import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AiflowError, type JsonSchema } from "@aiflow/core";
import type { AgentRuntime, AgentStepContext, AgentStepRequest, AgentStepResult, DelegationResult, DelegationTask, RuntimeCapabilities } from "@aiflow/engine";
import { sampleFromSchema } from "./sample.js";

export interface FakeTurn {
  summary?: string;
  branch?: string;
  branchReason?: string;
  output?: unknown;
  /** Rohe Übergabe (überschreibt alles andere), z. B. um Validierungsfehler zu testen. */
  handoff?: unknown;
  votes?: string[];
  selectedCandidate?: string;
  writes?: Record<string, string>;
  docs?: Record<string, string>;
  delegate?: DelegationTask[][];
  ask?: { question: string; options: string[] };
  fail?: string;
  delayMs?: number;
  text?: string;
}

/** Wie der Fake Dateien schreibt: im Speicher oder (für Integrationstests) auf der Platte. */
export interface FakeIo {
  workspace?: { writeByPath(path: string, relative: string, content: string): void };
  documents?: { writeByPath(path: string, content: string): void };
}

/** Schreibt direkt ins Dateisystem (für Tests mit echtem git-Workspace). */
export const diskIo: FakeIo = {
  workspace: {
    writeByPath(path, relative, content) {
      const target = join(path, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    },
  },
  documents: {
    writeByPath(path, content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
  },
};

export type FakeEntry = FakeTurn | FakeTurn[] | ((request: AgentStepRequest, call: number) => FakeTurn);

/**
 * Skriptbare Runtime für Tests. Schlüssel: Knoten-ID, `agent:<id>`, `sub:<agent-id>` (nur Sub-Schritte) oder `*`.
 * Arrays werden pro Aufruf abgearbeitet; der letzte Eintrag wiederholt sich.
 */
export class FakeRuntime implements AgentRuntime {
  readonly id = "fake";
  readonly calls: AgentStepRequest[] = [];
  readonly delegationResults: DelegationResult[] = [];
  readonly answers: string[] = [];
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly script: Record<string, FakeEntry> = {},
    private readonly io: FakeIo = {},
  ) {}

  capabilities(): RuntimeCapabilities {
    return { structuredOutput: "native", sessionFork: true, userQuestions: "question" };
  }

  callsFor(nodeId: string): AgentStepRequest[] {
    return this.calls.filter((c) => c.nodeId === nodeId && !c.parentStepId);
  }

  private turnFor(request: AgentStepRequest): FakeTurn {
    const keys = request.parentStepId ? [`sub:${request.agent.id}`, `agent:${request.agent.id}`, "*"] : [request.nodeId, `agent:${request.agent.id}`, "*"];
    for (const key of keys) {
      const entry = this.script[key];
      if (entry === undefined) continue;
      const call = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, call);
      if (typeof entry === "function") return entry(request, call);
      if (Array.isArray(entry)) return entry[Math.min(call - 1, entry.length - 1)] ?? {};
      return entry;
    }
    return {};
  }

  async runAgentStep(request: AgentStepRequest, context: AgentStepContext): Promise<AgentStepResult> {
    this.calls.push(request);
    const turn = this.turnFor(request);
    if (turn.text) context.activity({ kind: "text", text: turn.text });
    if (turn.delayMs) await sleep(turn.delayMs, context.signal);
    for (const wave of turn.delegate ?? []) this.delegationResults.push(await context.delegate(wave));
    if (turn.ask) this.answers.push(await context.ask(turn.ask));
    for (const [path, content] of Object.entries(turn.writes ?? {})) {
      if (!this.io.workspace) throw new Error("FakeRuntime: kein Workspace für writes konfiguriert");
      this.io.workspace.writeByPath(request.workspace.path, path, content);
    }
    for (const [name, content] of Object.entries(turn.docs ?? {})) {
      if (!this.io.documents) throw new Error("FakeRuntime: kein DocumentStore für docs konfiguriert");
      const grant = request.documents.find((d) => d.name === name);
      this.io.documents.writeByPath(grant?.path ?? `mem://docs/${request.runId}/${name}`, content);
    }
    if (turn.fail) throw new AiflowError("RUNTIME", turn.fail);
    context.activity({ kind: "tool", tool: "read", status: "called" });
    const handoff = turn.handoff ?? this.buildHandoff(request.handoffSchema, turn, request);
    const result: AgentStepResult = { sessionId: `ses_${request.stepId}`, handoff, usage: { inputTokens: 100, outputTokens: 50 } };
    if (turn.votes) result.votes = turn.votes.map((b) => ({ ...(handoff), branch: b, branchReason: `Stimme für ${b}` }));
    return result;
  }

  private buildHandoff(schema: JsonSchema, turn: FakeTurn, request: AgentStepRequest): Record<string, unknown> {
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const out: Record<string, unknown> = { summary: turn.summary ?? `${request.label} erledigt` };
    if (props.branch) {
      const options = (props.branch.enum ?? []) as string[];
      out.branch = turn.branch ?? options[0];
      out.branchReason = turn.branchReason ?? "Fake-Entscheidung";
    }
    if (props.output) out.output = turn.output ?? sampleFromSchema(props.output);
    if (props.selectedCandidate) out.selectedCandidate = turn.selectedCandidate ?? ((props.selectedCandidate.enum ?? []) as string[])[0];
    return out;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("abgebrochen"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("abgebrochen"));
      },
      { once: true },
    );
  });
}
