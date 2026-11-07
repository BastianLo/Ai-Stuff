import type { Edge, Node } from "@xyflow/react";
import { nodePorts, allPorts, type AgentDefinition, type Workflow, type WorkflowNode, type StepRecord } from "@aiflow/core";

export interface FlowNodeData extends Record<string, unknown> {
  id: string;
  node: WorkflowNode;
  agent?: AgentDefinition;
  ports: string[];
  status?: StepRecord["status"] | "idle";
  visits?: number;
  issues?: number;
  delegation?: StepRecord["delegation"];
  lastSummary?: string;
}

export interface FlowEdgeData extends Record<string, unknown> {
  index: number;
  back: boolean;
  loopMax?: number;
  traversals?: number;
  error?: boolean;
  instruction?: string;
}

/** Ports inkl. Fehlerport, sofern er verbunden ist oder der Knoten ihn anbietet. */
export function visiblePorts(id: string, node: WorkflowNode, workflow: Workflow): string[] {
  const ports = nodePorts(node);
  const errorConnected = workflow.edges.some((e) => e.from === `${id}.error`);
  return allPorts(node).includes("error") && (errorConnected || node.type === "agent") ? [...ports, "error"] : ports;
}

/** Ebenen-Layout ab Start (Rückkanten ignoriert) für Knoten ohne gespeicherte Position. */
export function autoLayout(workflow: Workflow): Record<string, [number, number]> {
  const ids = Object.keys(workflow.nodes);
  const start = ids.find((id) => workflow.nodes[id]?.type === "start") ?? ids[0];
  const level = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const e of workflow.edges) {
    const from = e.from.split(".")[0] ?? "";
    out.set(from, [...(out.get(from) ?? []), e.to]);
    if (e.loop) out.set(from, [...(out.get(from) ?? []), e.loop.onExceeded]);
  }
  const visit = (id: string, depth: number, path: Set<string>): void => {
    if (path.has(id)) return;
    if ((level.get(id) ?? -1) >= depth) return;
    level.set(id, depth);
    const next = new Set(path).add(id);
    for (const t of out.get(id) ?? []) visit(t, depth + 1, next);
  };
  if (start) visit(start, 0, new Set());
  let maxLevel = Math.max(0, ...level.values());
  for (const id of ids) if (!level.has(id)) level.set(id, ++maxLevel);
  const columns = new Map<number, string[]>();
  for (const id of ids) columns.set(level.get(id) ?? 0, [...(columns.get(level.get(id) ?? 0) ?? []), id]);
  const result: Record<string, [number, number]> = {};
  for (const [col, list] of columns) list.forEach((id, i) => (result[id] = [col * 300, i * 210 - ((list.length - 1) * 210) / 2 + 300]));
  return result;
}

export function backEdgeSet(workflow: Workflow): Set<number> {
  const layout = autoLayout(workflow);
  const set = new Set<number>();
  workflow.edges.forEach((e, i) => {
    const from = e.from.split(".")[0] ?? "";
    if ((layout[e.to]?.[0] ?? 0) <= (layout[from]?.[0] ?? 0)) set.add(i);
  });
  return set;
}

export function toFlow(
  workflow: Workflow,
  agents: Map<string, AgentDefinition>,
  extra: { status?: Record<string, FlowNodeData["status"]>; visits?: Record<string, number>; issues?: Record<string, number>; traversals?: Record<number, number>; delegation?: Record<string, StepRecord["delegation"]>; summaries?: Record<string, string> } = {},
): { nodes: Node<FlowNodeData>[]; edges: Edge<FlowEdgeData>[] } {
  const auto = autoLayout(workflow);
  const back = backEdgeSet(workflow);
  const nodes: Node<FlowNodeData>[] = Object.entries(workflow.nodes).map(([id, node]) => {
    const pos = workflow.layout[id] ?? auto[id] ?? [0, 0];
    return {
      id,
      type: node.type === "note" ? "note" : "aiflow",
      position: { x: pos[0], y: pos[1] },
      data: {
        id,
        node,
        ...(node.type === "agent" ? { agent: agents.get(node.agent) } : node.type === "map" ? { agent: agents.get(node.agent) } : {}),
        ports: visiblePorts(id, node, workflow),
        status: extra.status?.[id] ?? "idle",
        visits: extra.visits?.[id] ?? 0,
        issues: extra.issues?.[id] ?? 0,
        delegation: extra.delegation?.[id],
        lastSummary: extra.summaries?.[id],
      },
    };
  });
  const edges: Edge<FlowEdgeData>[] = workflow.edges.map((e, index) => {
    const [from, port] = e.from.split(".");
    const node = workflow.nodes[from ?? ""];
    const sourceHandle = port ?? (node ? (nodePorts(node)[0] ?? "next") : "next");
    const isBack = back.has(index);
    const isError = sourceHandle === "error";
    return {
      id: `e${index}`,
      source: from ?? "",
      target: e.to,
      sourceHandle,
      targetHandle: "in",
      type: "aiflow",
      data: { index, back: isBack, ...(e.loop ? { loopMax: e.loop.max } : {}), traversals: extra.traversals?.[index] ?? 0, error: isError, ...(e.handoff?.instruction ? { instruction: e.handoff.instruction } : {}) },
      label: sourceHandle !== "next" ? sourceHandle : undefined,
    };
  });
  return { nodes, edges };
}
