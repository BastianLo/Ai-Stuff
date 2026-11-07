import { AiflowError, assertNever } from "./errors.js";
import type { Workflow, WorkflowEdge, WorkflowNode } from "./workflow.js";

export const DEFAULT_PORT = "next";
export const ERROR_PORT = "error";
export const CONFLICT_PORT = "conflict";
export const SUBWORKFLOW_PORTS = ["success", "rejected", "failed"] as const;

/** Ausgangsports eines Knotens (ohne den optionalen `error`-Port). */
export function nodePorts(node: WorkflowNode): string[] {
  switch (node.type) {
    case "start":
      return [DEFAULT_PORT];
    case "agent":
      return node.ports && Object.keys(node.ports).length > 0 ? Object.keys(node.ports) : [DEFAULT_PORT];
    case "script":
      return node.ports ? Object.keys(node.ports) : ["passed", "failed"];
    case "condition":
      return [...Object.keys(node.rules), "else"];
    case "join": {
      const ports = node.combine.strategy === "vote" ? uniq(Object.values(node.combine.ports ?? { true: "approved", false: "rejected" })) : [DEFAULT_PORT];
      return node.workspace === "git-merge" ? [...ports, CONFLICT_PORT] : ports;
    }
    case "map":
      return node.merge === "git-merge" ? [DEFAULT_PORT, CONFLICT_PORT] : [DEFAULT_PORT];
    case "human":
      return [...node.ports];
    case "subworkflow":
      return [...SUBWORKFLOW_PORTS];
    case "end":
    case "note":
      return [];
    default:
      return assertNever(node, "Knotentyp");
  }
}

/** Ports inkl. `error`, wo Fehlerpfade erlaubt sind. */
export function allPorts(node: WorkflowNode): string[] {
  const ports = nodePorts(node);
  return node.type === "agent" || node.type === "script" || node.type === "map" || node.type === "subworkflow" ? [...ports, ERROR_PORT] : ports;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export interface ResolvedEdge {
  index: number;
  key: string;
  from: string;
  port: string;
  to: string;
  edge: WorkflowEdge;
}

/** Löst `from` (mit oder ohne Port) auf. Ohne Port wird der einzige reguläre Port genommen. */
export function resolveEdge(workflow: Workflow, edge: WorkflowEdge, index: number): ResolvedEdge {
  const dot = edge.from.indexOf(".");
  const from = dot >= 0 ? edge.from.slice(0, dot) : edge.from;
  const node = workflow.nodes[from];
  if (!node) throw new AiflowError("VALIDATION", `Kante ${index + 1}: Quellknoten „${from}“ existiert nicht.`);
  let port: string;
  if (dot >= 0) port = edge.from.slice(dot + 1);
  else {
    const ports = nodePorts(node);
    if (ports.length !== 1 || ports[0] === undefined) {
      throw new AiflowError("VALIDATION", `Kante ${index + 1}: „${from}“ hat mehrere Ports (${ports.join(", ")}). Bitte „${from}.<port>“ angeben.`);
    }
    port = ports[0];
  }
  return { index, key: `${from}.${port}->${edge.to}#${index}`, from, port, to: edge.to, edge };
}

export class WorkflowGraph {
  readonly edges: ResolvedEdge[];
  private readonly outgoing = new Map<string, ResolvedEdge[]>();
  private readonly incoming = new Map<string, ResolvedEdge[]>();
  readonly backEdges = new Set<string>();

  constructor(readonly workflow: Workflow) {
    this.edges = workflow.edges.map((e, i) => resolveEdge(workflow, e, i));
    for (const e of this.edges) {
      push(this.outgoing, e.from, e);
      push(this.incoming, e.to, e);
    }
    this.findBackEdges();
  }

  get startId(): string | undefined {
    return Object.entries(this.workflow.nodes).find(([, n]) => n.type === "start")?.[0];
  }

  node(id: string): WorkflowNode {
    const node = this.workflow.nodes[id];
    if (!node) throw new AiflowError("NOT_FOUND", `Knoten „${id}“ existiert nicht.`);
    return node;
  }

  out(nodeId: string, port?: string): ResolvedEdge[] {
    const all = this.outgoing.get(nodeId) ?? [];
    return port === undefined ? all : all.filter((e) => e.port === port);
  }

  in(nodeId: string): ResolvedEdge[] {
    return this.incoming.get(nodeId) ?? [];
  }

  successors(nodeId: string): string[] {
    const targets = this.out(nodeId).map((e) => e.to);
    // Eskalationsziele von Schleifen sind ebenfalls erreichbar.
    for (const e of this.out(nodeId)) if (e.edge.loop) targets.push(e.edge.loop.onExceeded);
    return uniq(targets);
  }

  /** Rückkanten per DFS ab Start (Kanten zu einem Knoten auf dem aktuellen Pfad). */
  private findBackEdges(): void {
    const start = this.startId;
    if (!start) return;
    const state = new Map<string, "visiting" | "done">();
    const visit = (id: string): void => {
      state.set(id, "visiting");
      for (const e of this.out(id)) {
        const s = state.get(e.to);
        if (s === "visiting") this.backEdges.add(e.key);
        else if (s === undefined && this.workflow.nodes[e.to]) visit(e.to);
        const escalation = e.edge.loop?.onExceeded;
        if (escalation && state.get(escalation) === undefined && this.workflow.nodes[escalation]) visit(escalation);
      }
      state.set(id, "done");
    };
    visit(start);
  }

  reachableFrom(id: string): Set<string> {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || seen.has(current) || !this.workflow.nodes[current]) continue;
      seen.add(current);
      stack.push(...this.successors(current));
    }
    return seen;
  }

  canReachEnd(id: string): boolean {
    for (const n of this.reachableFrom(id)) if (this.workflow.nodes[n]?.type === "end") return true;
    return false;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
