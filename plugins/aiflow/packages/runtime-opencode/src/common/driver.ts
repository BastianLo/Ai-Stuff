import type { JsonSchema, ModelRef, PermissionRule } from "@aiflow/core";
import type { RuntimeCapabilities, StepActivity } from "@aiflow/engine";

export type OpencodeApi = "v1" | "v2";

export interface CreateSessionOptions {
  directory: string;
  title: string;
  permissions: PermissionRule[];
  metadata: Record<string, string>;
  model?: ModelRef;
  parentSessionId?: string;
}

export interface RunOptions {
  text: string;
  system: string;
  directory: string;
  model?: ModelRef;
  /** Nur v1: strukturierte Ausgabe per `format: json_schema`. */
  format?: JsonSchema;
}

export interface RunResult {
  text: string;
  structured?: unknown;
  structuredError?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface SessionActivity {
  sessionId: string;
  activity: StepActivity;
}

export interface ModelInfo {
  providerID: string;
  modelID: string;
  name: string;
}

/** Versionsspezifischer Treiber für die opencode-Server-API (PLAN.md 5.5). */
export interface OpencodeDriver {
  readonly api: OpencodeApi;
  capabilities(): RuntimeCapabilities;
  health(): Promise<{ version: string }>;
  createSession(options: CreateSessionOptions): Promise<string>;
  forkSession(sessionId: string, directory: string): Promise<string>;
  /** Sendet einen Prompt und wartet, bis die Session wieder untätig ist. */
  run(sessionId: string, options: RunOptions, signal: AbortSignal): Promise<RunResult>;
  abort(sessionId: string, directory: string): Promise<void>;
  /** Live-Aktivität aller Sessions (wird pro Session gefiltert). */
  activity(signal: AbortSignal): AsyncIterable<SessionActivity>;
  listModels(): Promise<ModelInfo[]>;
  listMcp(): Promise<{ name: string; status: string }[]>;
  listPlugins(): Promise<string[]>;
}
