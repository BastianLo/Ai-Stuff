import type {
  AgentDefinition,
  Clock,
  DiffStat,
  FileChange,
  IdGenerator,
  JsonSchema,
  ModelRef,
  PermissionRule,
  RunEvent,
} from "@aiflow/core";
import type { RunState, WorkspaceRef } from "./state.js";

export type { WorkspaceRef } from "./state.js";

export interface WorkspaceManager {
  prepare(runId: string, projectDir: string, base: string): Promise<WorkspaceRef>;
  isolate(runId: string, from: WorkspaceRef, label: string): Promise<WorkspaceRef>;
  scratch(runId: string, label: string): Promise<WorkspaceRef>;
  checkpoint(ref: WorkspaceRef, message: string): Promise<WorkspaceRef>;
  reset(ref: WorkspaceRef, commit: string): Promise<WorkspaceRef>;
  diffStat(ref: WorkspaceRef, from: string): Promise<DiffStat>;
  changes(ref: WorkspaceRef, from: string, projectDir?: string): Promise<FileChange[]>;
  merge(target: WorkspaceRef, sources: WorkspaceRef[], message: string): Promise<{ ref: WorkspaceRef; conflicts: string[] }>;
  writeFile(ref: WorkspaceRef, relativePath: string, content: string): Promise<void>;
  apply(ref: WorkspaceRef, projectDir: string, files?: string[]): Promise<{ applied: string[]; conflicts: string[] }>;
  createBranch(ref: WorkspaceRef, projectDir: string, name: string): Promise<string>;
  patch(ref: WorkspaceRef): Promise<string>;
  cleanup(runId: string): Promise<void>;
}

export interface ScriptResult {
  exitCode: number;
  output: string;
}

export interface ScriptRunner {
  run(command: string, options: { cwd: string; timeoutMs: number; env: Record<string, string>; signal: AbortSignal }): Promise<ScriptResult>;
}

export interface DocumentVersion {
  stepId: string;
  ts: number;
  content: string;
}

export interface DocumentStore {
  init(runId: string, documents: { name: string; content: string }[]): Promise<void>;
  /** Absoluter Pfad des Dokuments (für den Agenten). */
  path(runId: string, name: string): string;
  read(runId: string, name: string): Promise<string>;
  write(runId: string, name: string, content: string): Promise<void>;
  recordVersion(runId: string, name: string, version: DocumentVersion): Promise<void>;
  versions(runId: string, name: string): Promise<DocumentVersion[]>;
}

export interface EventSink {
  append(event: RunEvent): void;
  saveState(state: RunState): void;
}

export interface RuntimeCapabilities {
  structuredOutput: "format" | "tool" | "native";
  sessionFork: boolean;
  userQuestions: "question" | "form" | "none";
}

export interface DocumentGrant {
  name: string;
  path: string;
  access: "read" | "append" | "write" | "write-required";
  description: string;
}

export interface DelegationOffer {
  allowed: { id: string; name: string; description: string }[];
  mode: "optional" | "enforced";
  maxParallel: number;
  remainingRuns: number;
}

export interface AgentStepRequest {
  runId: string;
  stepId: string;
  nodeId: string;
  /** Gesetzt bei Sub-Agenten und Für-jedes-Elementen. */
  parentStepId?: string;
  label: string;
  agent: AgentDefinition;
  systemPrompt: string;
  prompt: string;
  model?: ModelRef;
  workspace: { path: string; readOnly: boolean; writeScope?: string[] };
  permissions: PermissionRule[];
  handoffSchema: JsonSchema;
  votes: number;
  documents: DocumentGrant[];
  delegation?: DelegationOffer;
  session?: { resume?: string; forkFrom?: string };
  timeoutMs: number;
}

export type StepActivity =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; status: "called" | "succeeded" | "failed"; input?: unknown; output?: string }
  | { kind: "progress"; message: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number };

export interface DelegationTask {
  agent: string;
  task: string;
  expectedResult?: string;
}

export interface DelegationResultItem {
  agent: string;
  task: string;
  status: "completed" | "failed" | "skipped";
  summary?: string;
  output?: unknown;
  error?: string;
  stepId?: string;
}

export interface DelegationResult {
  wave: number;
  results: DelegationResultItem[];
  remainingRuns: number;
  budgetExhausted: boolean;
  message?: string;
}

export interface AskRequest {
  question: string;
  options: string[];
  kind?: "question" | "permission";
  title?: string;
}

export interface AgentStepContext {
  signal: AbortSignal;
  activity(activity: StepActivity): void;
  delegate(tasks: DelegationTask[]): Promise<DelegationResult>;
  /** Frage an den Nutzer (Inbox). `kind: "permission"` für Rückfragen der Runtime zu Rechten. Liefert Option oder Freitext. */
  ask(question: AskRequest): Promise<string>;
}

export interface AgentStepResult {
  sessionId: string;
  /** Rohe Übergabe, wird von der Engine gegen das Schema geprüft. */
  handoff: unknown;
  /** Bei votes > 1: rohe Übergaben aller Stimmen. */
  votes?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AgentRuntime {
  readonly id: string;
  capabilities(): RuntimeCapabilities;
  runAgentStep(request: AgentStepRequest, context: AgentStepContext): Promise<AgentStepResult>;
}

export interface EngineDeps {
  runtime: AgentRuntime;
  workspace: WorkspaceManager;
  scripts: ScriptRunner;
  documents: DocumentStore;
  sink: EventSink;
  clock: Clock;
  ids: IdGenerator;
  /** Globales Limit gleichzeitiger Agenten-Sessions über alle Runs. */
  maxParallelSessions?: number;
}
