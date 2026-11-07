import type { AgentDefinition } from "./agent.js";
import { conditionVariables } from "./condition.js";
import { AiflowError, errorMessage } from "./errors.js";
import { allPorts, nodePorts, WorkflowGraph, type ResolvedEdge } from "./graph.js";
import { templateVariables, unknownTemplateRoots } from "./template.js";
import type { Workflow, WorkflowNode } from "./workflow.js";

export type IssueSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}

export interface ValidationContext {
  agents: ReadonlyMap<string, AgentDefinition>;
  workflows?: ReadonlyMap<string, Workflow>;
  /** Maximale Sessions global (für Sub-Agenten-Prüfungen). */
  maxParallelSessions?: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/** Prüft alle strukturellen Regeln aus PLAN.md 8.3. */
export function validateWorkflow(workflow: Workflow, ctx: ValidationContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (severity: IssueSeverity, code: string, message: string, where: { nodeId?: string; edgeIndex?: number } = {}): void => {
    issues.push({ severity, code, message, ...where });
  };

  // Kanten auflösen (ungültige Kanten einzeln melden, Rest weiter prüfen)
  const validEdges: Workflow["edges"] = [];
  workflow.edges.forEach((edge, index) => {
    const fromId = edge.from.split(".")[0] ?? "";
    const fromNode = workflow.nodes[fromId];
    if (!fromNode) return add("error", "edge.unknown-source", `Kante ${index + 1}: Quellknoten „${fromId}“ fehlt.`, { edgeIndex: index });
    if (!workflow.nodes[edge.to]) return add("error", "edge.unknown-target", `Kante ${index + 1}: Zielknoten „${edge.to}“ fehlt.`, { edgeIndex: index });
    const port = edge.from.includes(".") ? edge.from.split(".")[1] : undefined;
    if (port !== undefined && !allPorts(fromNode).includes(port)) {
      return add("error", "edge.unknown-port", `Kante ${index + 1}: „${fromId}“ hat keinen Port „${port}“ (vorhanden: ${allPorts(fromNode).join(", ")}).`, { edgeIndex: index, nodeId: fromId });
    }
    if (port === undefined && nodePorts(fromNode).length !== 1) {
      return add("error", "edge.ambiguous-port", `Kante ${index + 1}: „${fromId}“ hat mehrere Ports, bitte Port angeben.`, { edgeIndex: index, nodeId: fromId });
    }
    if (edge.loop && !workflow.nodes[edge.loop.onExceeded]) {
      return add("error", "loop.unknown-target", `Kante ${index + 1}: Eskalationsziel „${edge.loop.onExceeded}“ fehlt.`, { edgeIndex: index });
    }
    validEdges.push(edge);
  });

  let graph: WorkflowGraph;
  try {
    graph = new WorkflowGraph({ ...workflow, edges: validEdges });
  } catch (error) {
    add("error", "graph.invalid", errorMessage(error));
    return { ok: false, issues };
  }

  const nodes = Object.entries(workflow.nodes);
  const starts = nodes.filter(([, n]) => n.type === "start");
  if (starts.length !== 1) add("error", "start.count", `Es muss genau einen Start-Knoten geben (gefunden: ${starts.length}).`);
  if (!nodes.some(([, n]) => n.type === "end")) add("error", "end.missing", "Es gibt keinen Ende-Knoten.");

  const startId = graph.startId;
  const reachable = startId ? graph.reachableFrom(startId) : new Set<string>();
  for (const [id, node] of nodes) {
    if (node.type === "note") continue;
    if (startId && !reachable.has(id)) add("error", "node.unreachable", `„${label(id, node)}“ ist vom Start nicht erreichbar.`, { nodeId: id });
    if (node.type !== "end" && !graph.canReachEnd(id)) add("error", "node.dead-end", `Von „${label(id, node)}“ führt kein Weg zu einem Ende.`, { nodeId: id });
    if (node.type !== "end") {
      for (const port of nodePorts(node)) {
        if (graph.out(id, port).length === 0) add("error", "port.unconnected", `Port „${port}“ von „${label(id, node)}“ ist nicht verbunden.`, { nodeId: id });
      }
    }
    validateNode(id, node, workflow, ctx, add);
  }

  // Zyklen brauchen ein Limit
  for (const e of graph.edges) {
    if (graph.backEdges.has(e.key) && !e.edge.loop) {
      add("error", "loop.no-limit", `Rückkante ${e.from}.${e.port} → ${e.to} braucht ein Schleifenlimit (max + Eskalationsziel).`, { edgeIndex: e.index });
    }
  }

  validateParallelism(graph, workflow, add);
  validateDocuments(workflow, add);
  validateTemplates(workflow, add);

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}

type Add = (severity: IssueSeverity, code: string, message: string, where?: { nodeId?: string; edgeIndex?: number }) => void;

function label(id: string, node: WorkflowNode): string {
  return node.label ?? id;
}

function validateNode(id: string, node: WorkflowNode, workflow: Workflow, ctx: ValidationContext, add: Add): void {
  switch (node.type) {
    case "agent": {
      const agent = ctx.agents.get(node.agent);
      if (!agent) add("error", "agent.unknown", `Agent „${node.agent}“ (Knoten „${label(id, node)}“) existiert nicht.`, { nodeId: id });
      const ports = node.ports ? Object.entries(node.ports) : [];
      if (ports.length === 1) add("error", "decision.single-branch", `„${label(id, node)}“: Eine Verzweigung braucht mindestens zwei Zweige.`, { nodeId: id });
      for (const [port, spec] of ports) {
        if (!spec.description.trim()) add("error", "decision.no-description", `Zweig „${port}“ von „${label(id, node)}“ braucht eine Beschreibung, wann er zu wählen ist.`, { nodeId: id });
      }
      if (node.decision?.fallback && !ports.some(([p]) => p === node.decision?.fallback)) {
        add("error", "decision.bad-fallback", `Fallback-Zweig „${node.decision.fallback}“ existiert nicht.`, { nodeId: id });
      }
      const sub = node.subagents ?? agent?.subagents;
      if (sub?.enabled) {
        const allowed = sub.allowed ?? [];
        if (allowed.length === 0) add("error", "subagents.none-allowed", `„${label(id, node)}“: Sub-Agenten sind aktiv, aber keine erlaubten Agenten gewählt.`, { nodeId: id });
        for (const a of allowed) if (!ctx.agents.has(a)) add("error", "subagents.unknown-agent", `Erlaubter Sub-Agent „${a}“ existiert nicht.`, { nodeId: id });
        if ((sub.maxRuns ?? 12) < (sub.maxParallel ?? 4)) add("error", "subagents.budget", `„${label(id, node)}“: Budget (maxRuns) muss ≥ Parallelität sein.`, { nodeId: id });
        if ((sub.depth ?? 0) > 1) add("warning", "subagents.depth", `„${label(id, node)}“: Verschachtelungstiefe > 1 kann viele Sub-Agenten erzeugen.`, { nodeId: id });
        if (ctx.maxParallelSessions !== undefined && (sub.maxParallel ?? 4) > ctx.maxParallelSessions) {
          add("warning", "subagents.parallel", `„${label(id, node)}“: Parallelität übersteigt das globale Session-Limit (${ctx.maxParallelSessions}).`, { nodeId: id });
        }
      }
      return;
    }
    case "condition":
      for (const [port, rule] of Object.entries(node.rules)) {
        for (const v of conditionVariables(rule)) {
          const root = v.split(".")[0] ?? "";
          if (!["input", "vars", "run", "node", "script", "join", "workspace", "loop"].includes(root)) {
            add("warning", "condition.unknown-var", `Bedingung „${port}“ liest unbekannte Variable „${v}“.`, { nodeId: id });
          }
        }
      }
      return;
    case "script":
      if (node.ports) {
        const entries = Object.values(node.ports);
        if (!entries.some((p) => p.else)) add("error", "script.no-else", `Skript „${label(id, node)}“ braucht einen Port mit \`else: true\`.`, { nodeId: id });
      }
      return;
    case "join":
      if (node.wait === "n-of-m" && node.n === undefined) add("error", "join.n", `Join „${label(id, node)}“: Für „n-of-m“ fehlt n.`, { nodeId: id });
      if (node.combine.strategy === "vote" && !node.combine.field) add("error", "join.vote-field", `Join „${label(id, node)}“: Abstimmung braucht ein Feld (z. B. output.approved).`, { nodeId: id });
      return;
    case "map":
      if (!ctx.agents.has(node.agent)) add("error", "agent.unknown", `Agent „${node.agent}“ (Für-jedes „${label(id, node)}“) existiert nicht.`, { nodeId: id });
      return;
    case "subworkflow":
      if (node.workflow === workflow.id) add("error", "subworkflow.recursive", `„${label(id, node)}“ ruft sich selbst auf.`, { nodeId: id });
      else if (ctx.workflows && !ctx.workflows.has(node.workflow)) add("error", "subworkflow.unknown", `Sub-Workflow „${node.workflow}“ existiert nicht.`, { nodeId: id });
      return;
    case "human":
      if (node.defaultPort && !node.ports.includes(node.defaultPort)) add("error", "human.default", `Standardantwort „${node.defaultPort}“ ist kein Port.`, { nodeId: id });
      return;
    case "start":
    case "end":
    case "note":
      return;
  }
}

/**
 * Strukturierte Parallelität: Jeder Fan-out (Port mit mehreren Kanten) muss in genau einen Join münden,
 * oder alle Zweige enden in Ende-Knoten. Parallele schreibende Zweige brauchen `isolate`.
 */
function validateParallelism(graph: WorkflowGraph, workflow: Workflow, add: Add): void {
  const byPort = new Map<string, ResolvedEdge[]>();
  for (const e of graph.edges) {
    const key = `${e.from}.${e.port}`;
    byPort.set(key, [...(byPort.get(key) ?? []), e]);
  }
  for (const [key, edges] of byPort) {
    if (edges.length < 2) continue;
    const joins = new Set<string>();
    let allEnd = true;
    for (const e of edges) {
      const join = firstJoin(graph, e.to);
      if (join) {
        joins.add(join);
        allEnd = false;
      } else if (!onlyEnds(graph, e.to)) allEnd = false;
    }
    if (joins.size > 1 || (joins.size === 0 && !allEnd)) {
      add("error", "parallel.unstructured", `Fan-out an „${key}“ muss in genau einen Zusammenführungs-Knoten münden.`, { nodeId: key.split(".")[0] ?? "" });
    }
    const writers = edges.filter((e) => {
      const n = workflow.nodes[e.to];
      if (n?.type !== "agent") return false;
      const mode = e.edge.workspace ?? n.workspace?.mode ?? "continue";
      return mode === "continue";
    });
    if (writers.length > 1) {
      for (const e of writers) {
        add("warning", "parallel.shared-workspace", `Paralleler Zweig „${e.to}“ arbeitet im geteilten Workspace. Schreibende Zweige sollten „isolate“ oder „read-only“ nutzen.`, { nodeId: e.to });
      }
    }
    // Dokumente: parallele Schreiber
    const docWriters = new Map<string, number>();
    for (const e of edges) {
      const n = workflow.nodes[e.to];
      if (n?.type !== "agent") continue;
      for (const [doc, access] of Object.entries(n.documents)) if (access === "write" || access === "write-required") docWriters.set(doc, (docWriters.get(doc) ?? 0) + 1);
    }
    for (const [doc, count] of docWriters) {
      if (count > 1) add("error", "documents.parallel-write", `„${doc}“ wird an „${key}“ von ${count} parallelen Zweigen geschrieben. Nur „append“ ist parallel erlaubt.`, { nodeId: key.split(".")[0] ?? "" });
    }
  }
}

function firstJoin(graph: WorkflowGraph, from: string): string | undefined {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = graph.workflow.nodes[id];
    if (!node) continue;
    if (node.type === "join") return id;
    for (const e of graph.out(id)) if (!graph.backEdges.has(e.key)) queue.push(e.to);
  }
  return undefined;
}

function onlyEnds(graph: WorkflowGraph, from: string): boolean {
  for (const id of graph.reachableFrom(from)) if (graph.workflow.nodes[id]?.type === "join") return false;
  return true;
}

function validateDocuments(workflow: Workflow, add: Add): void {
  const known = new Set(Object.keys(workflow.documents));
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type !== "agent") continue;
    for (const doc of Object.keys(node.documents)) {
      if (!known.has(doc)) add("error", "documents.unknown", `„${label(id, node)}“ verweist auf unbekanntes Dokument „${doc}“.`, { nodeId: id });
    }
  }
  for (const [doc, spec] of Object.entries(workflow.documents)) {
    if (!spec.requiredAtEnd) continue;
    const hasWriter = Object.values(workflow.nodes).some((n) => n.type === "agent" && ["write", "write-required", "append"].includes(n.documents[doc] ?? "none"));
    if (!hasWriter) add("warning", "documents.no-writer", `Pflichtdokument „${doc}“ wird von keinem Knoten geschrieben.`);
  }
}

function validateTemplates(workflow: Workflow, add: Add): void {
  const check = (text: string | undefined, where: { nodeId?: string; edgeIndex?: number }, extra: string[] = []): void => {
    if (!text) return;
    for (const v of unknownTemplateRoots(text, extra)) add("error", "template.unknown", `Unbekannte Template-Variable „{{${v}}}“.`, where);
    for (const v of templateVariables(text)) {
      const [root, name] = v.split(".");
      if (root === "vars" && name && !(name in workflow.variables)) add("error", "template.unknown-var", `Workflow-Variable „${name}“ ist nicht definiert.`, where);
      if (root === "input" && name && !(name in workflow.inputs)) add("error", "template.unknown-input", `Eingabe „${name}“ ist nicht definiert.`, where);
      if (root === "docs" && name && !(name.replace(/_/g, ".") in workflow.documents) && !(name in workflow.documents)) {
        add("warning", "template.unknown-doc", `Dokument „${name}“ ist nicht definiert.`, where);
      }
    }
  };
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type === "agent") check(node.instructions, { nodeId: id });
    if (node.type === "script") check(node.command, { nodeId: id });
    if (node.type === "human") check(node.question, { nodeId: id });
    if (node.type === "map") check(node.task, { nodeId: id }, ["item", "index"]);
    if (node.type === "subworkflow") check(node.prompt, { nodeId: id });
    if (node.type === "end") check(node.report, { nodeId: id });
  }
  workflow.edges.forEach((e, i) => check(e.handoff?.instruction, { edgeIndex: i }));
}

/** Wirft bei Fehlern (für Laufzeit-Start). */
export function assertValidWorkflow(workflow: Workflow, ctx: ValidationContext): void {
  const result = validateWorkflow(workflow, ctx);
  if (!result.ok) {
    const errors = result.issues.filter((i) => i.severity === "error");
    throw new AiflowError("VALIDATION", `Workflow „${workflow.id}“ ist ungültig: ${errors.map((e) => e.message).join(" | ")}`, errors);
  }
}
