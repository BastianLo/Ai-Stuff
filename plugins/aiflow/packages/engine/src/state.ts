import type { AgentDefinition, ContextInclude, InboxItem, Outcome, ReviewData, RunStatus, Snippet, StepRecord, Workflow, WorkspaceMode } from "@aiflow/core";

/** Arbeitsverzeichnis eines Tokens (in der Regel ein git worktree). */
export interface WorkspaceRef {
  id: string;
  path: string;
  /** Aktueller Commit */
  head: string;
  /** Basis-Commit des Runs */
  base: string;
}

export interface ForkFrame {
  forkId: string;
  branch: number;
  total: number;
}

export interface Inbound {
  fromStepId?: string;
  edgeIndex?: number;
  instruction?: string;
  include?: ContextInclude[];
  exclude?: ContextInclude[];
  feedback?: string;
  workspaceMode?: WorkspaceMode;
  loop?: { iteration: number; max: number };
  exceeded?: boolean;
}

export interface Candidate {
  id: string;
  label: string;
  stepId?: string;
  workspace: WorkspaceRef;
  summary?: string;
}

export type TokenStatus = "ready" | "running" | "waiting" | "done" | "cancelled";

export interface Token {
  id: string;
  nodeId: string;
  status: TokenStatus;
  forkStack: ForkFrame[];
  workspace: WorkspaceRef;
  inbound: Inbound;
  stepId?: string;
  candidates?: Candidate[];
}

export interface Arrival {
  tokenId: string;
  branch: number;
  stepId?: string;
  workspace: WorkspaceRef;
}

export interface ForkState {
  id: string;
  fromNode: string;
  total: number;
  baseWorkspace: WorkspaceRef;
  arrivals: Arrival[];
  fired: boolean;
}

export interface RunSpec {
  workflow: Workflow;
  version: string;
  agents: Record<string, AgentDefinition>;
  snippets: Record<string, Snippet>;
  workflows: Record<string, Workflow>;
  input: Record<string, unknown>;
  projectDir: string;
  origin: "web" | "cli" | "tui" | "api";
  parentRunId?: string;
  parentStepId?: string;
  /** Sub-Workflows arbeiten im Workspace des Aufrufers weiter. */
  baseWorkspace?: WorkspaceRef;
  finalizeOverride?: "none";
}

export interface RunState {
  id: string;
  spec: RunSpec;
  status: RunStatus;
  outcome?: Outcome;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  tokens: Token[];
  steps: Record<string, StepRecord>;
  stepOrder: string[];
  edgeCounts: Record<string, number>;
  nodeVisits: Record<string, number>;
  forks: Record<string, ForkState>;
  inbox: InboxItem[];
  sessions: Record<string, string>;
  baseWorkspace?: WorkspaceRef;
  finalWorkspace?: WorkspaceRef;
  endNodeId?: string;
  review?: ReviewData;
  seq: number;
}

export function activeTokens(state: RunState): Token[] {
  return state.tokens.filter((t) => t.status !== "done" && t.status !== "cancelled");
}

/** Letzter abgeschlossener Top-Level-Schritt eines Knotens. */
export function lastStepOf(state: RunState, nodeId: string): import("@aiflow/core").StepRecord | undefined {
  for (let i = state.stepOrder.length - 1; i >= 0; i--) {
    const step = state.steps[state.stepOrder[i] ?? ""];
    if (step && step.nodeId === nodeId && !step.parentStepId && step.status === "completed") return step;
  }
  return undefined;
}

/** Der Auftrag eines Runs als Text. */
export function promptText(input: Record<string, unknown>): string {
  const prompt = input.prompt;
  return typeof prompt === "string" ? prompt : prompt === undefined ? "" : JSON.stringify(prompt);
}

/** Kurzfassung eines Runs für Listen und die History. */
export function summarizeRun(state: RunState): import("@aiflow/core").RunSummary {
  const steps = Object.values(state.steps).filter((s) => !s.parentStepId && s.nodeType !== "start" && s.nodeType !== "end");
  return {
    id: state.id,
    workflowId: state.spec.workflow.id,
    workflowName: state.spec.workflow.name,
    workflowVersion: state.spec.version,
    projectDir: state.spec.projectDir,
    prompt: promptText(state.spec.input),
    status: state.status,
    ...(state.outcome ? { outcome: state.outcome } : {}),
    createdAt: state.createdAt,
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    stepCount: steps.length,
    origin: state.spec.origin,
    ...(state.spec.parentRunId ? { parentRunId: state.spec.parentRunId } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
}
