import type { Handoff } from "./handoff.js";
import type { NodeType, Outcome } from "./workflow.js";

export type RunStatus =
  | "running"
  | "waiting_input"
  | "review_pending"
  | "paused"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export type StepStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface StepMetrics {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  retries?: number;
}

export interface StepRecord {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: NodeType | "subagent" | "map-item";
  label: string;
  agentId?: string;
  parentStepId?: string;
  tokenId?: string;
  status: StepStatus;
  attempt: number;
  visit: number;
  wave?: number;
  startedAt: number;
  finishedAt?: number;
  port?: string;
  handoff?: Handoff;
  votes?: string[];
  error?: string;
  prompt?: string;
  systemPrompt?: string;
  sessionId?: string;
  workspaceId?: string;
  checkpointBefore?: string;
  checkpointAfter?: string;
  metrics: StepMetrics;
  /** Skript: Exit-Code und gekürzte Ausgabe */
  script?: { command: string; exitCode: number; output: string };
  /** Join/Map: zusammengefasste Ergebnisse */
  combined?: unknown;
  /** Sub-Agenten: Zähler */
  delegation?: { waves: number; runs: number; budget: number; running: number };
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: string;
  projectDir: string;
  prompt: string;
  status: RunStatus;
  outcome?: Outcome;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  stepCount: number;
  origin: "web" | "cli" | "tui" | "api";
  parentRunId?: string;
  error?: string;
}

export type InboxKind = "human" | "question" | "permission" | "review";

export interface InboxItem {
  id: string;
  runId: string;
  stepId?: string;
  kind: InboxKind;
  title: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  createdAt: number;
  answeredAt?: number;
  answer?: { option: string; text?: string };
}

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string;
  /** Hat der Nutzer die Datei seit Run-Start ebenfalls geändert? */
  conflict?: boolean;
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export interface ReviewData {
  runId: string;
  report: string;
  files: FileChange[];
  documents: { name: string; content: string }[];
  finalize: "apply" | "review" | "branch" | "patch" | "none";
  decided?: { action: "apply" | "discard" | "branch" | "request-changes"; at: number; detail?: string };
}

export const RUN_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.interrupted",
  "run.waiting_input",
  "run.review_pending",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "step.started",
  "step.context_built",
  "step.text",
  "step.tool",
  "step.progress",
  "step.handoff",
  "step.decision",
  "step.document_written",
  "step.violation",
  "step.checkpoint",
  "step.retry",
  "step.completed",
  "step.failed",
  "token.forked",
  "token.joined",
  "token.cancelled",
  "loop.iteration",
  "loop.limit_reached",
  "input.requested",
  "input.answered",
  "delegation.wave_started",
  "delegation.wave_completed",
  "delegation.budget_exhausted",
  "substep.queued",
  "review.decided",
  "apply.completed",
  "apply.conflict",
  "branch.created",
  "docs.exported",
  "log",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent {
  runId: string;
  seq: number;
  ts: number;
  type: RunEventType;
  stepId?: string;
  data: Record<string, unknown>;
}
