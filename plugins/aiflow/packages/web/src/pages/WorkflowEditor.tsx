import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyNodeChanges,
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { stringify } from "yaml";
import { nodePorts, type ValidationIssue, type Workflow, type WorkflowEdge, type WorkflowNode } from "@aiflow/core";
import type { SimulationResult as SimResult } from "@aiflow/client";
import { api, useProject } from "../lib/api";
import { NODE_TYPE_LABEL } from "../lib/format";
import { agentMap, useAgents, useWorkflows, workflowList } from "../lib/queries";
import { autoLayout, toFlow, type FlowEdgeData, type FlowNodeData } from "../components/flow/model";
import { AutoFit, edgeTypes, nodeTypes } from "../components/flow/nodes";
import { EdgeInspector, NodeInspector, WorkflowInspector } from "../components/editor/Inspector";
import { Icon } from "../components/Icon";
import { AgentAvatar, Badge, Button, ErrorBox, Input, Modal, Select, Textarea } from "../components/ui";
import { StartRunDialog } from "../components/StartRunDialog";

type SimulationView = SimResult;

type Selection = { kind: "node"; id: string } | { kind: "edge"; index: number } | { kind: "workflow" };

const BLOCKS: { type: WorkflowNode["type"]; hint: string }[] = [
  { type: "start", hint: "Einstieg mit Auftrag" },
  { type: "end", hint: "Abschluss: Review, Übernahme, Branch …" },
  { type: "script", hint: "Tests, Lint, Build als hartes Gate" },
  { type: "condition", hint: "Regelbasierte Verzweigung" },
  { type: "join", hint: "Parallele Zweige zusammenführen, abstimmen" },
  { type: "map", hint: "Für jedes Element einer Liste" },
  { type: "human", hint: "Freigabe oder Eingabe des Nutzers" },
  { type: "subworkflow", hint: "Anderen Workflow aufrufen" },
  { type: "note", hint: "Notiz auf dem Canvas" },
];

function newNode(type: WorkflowNode["type"], payload: { agent?: string; workflow?: string }): WorkflowNode {
  switch (type) {
    case "agent":
      return { type: "agent", agent: payload.agent ?? "", documents: {} };
    case "start":
      return { type: "start" };
    case "end":
      return { type: "end", outcome: "success" };
    case "script":
      return { type: "script", command: "npm test", timeout: "15m", env: {} };
    case "condition":
      return { type: "condition", rules: { ja: { "==": [{ var: "node.x.branch" }, "approved"] } } };
    case "join":
      return { type: "join", wait: "all", combine: { strategy: "collect" }, workspace: "keep-base" };
    case "map":
      return { type: "map", items: "node.plan.output.tasks", agent: payload.agent ?? "implementer", task: "{{item}}", maxParallel: 3, workspace: "isolate", merge: "git-merge" };
    case "human":
      return { type: "human", question: "Wie weiter?", ports: ["ja", "nein"], allowFreeText: true };
    case "subworkflow":
      return { type: "subworkflow", workflow: payload.workflow ?? "", prompt: "{{input.prompt}}" };
    case "note":
      return { type: "note", text: "Notiz" };
  }
}

function uniqueId(workflow: Workflow, base: string): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9-_]/g, "-").replace(/-+/g, "-") || "knoten";
  if (!workflow.nodes[clean]) return clean;
  for (let i = 2; ; i++) if (!workflow.nodes[`${clean}-${i}`]) return `${clean}-${i}`;
}

function Editor({ initial, scope, version }: { initial: Workflow; scope: "global" | "project"; version: string }) {
  const [project] = useProject();
  const qc = useQueryClient();
  const flow = useReactFlow();
  const agentEntries = useAgents(project).data;
  const workflowEntries = useWorkflows(project).data;
  const agents = useMemo(() => agentMap(agentEntries), [agentEntries]);
  const workflows = useMemo(() => workflowList(workflowEntries), [workflowEntries]);
  const [history, setHistory] = useState<{ past: Workflow[]; present: Workflow; future: Workflow[] }>({ past: [], present: initial, future: [] });
  const workflow = history.present;
  const [savedJson, setSavedJson] = useState(JSON.stringify(initial));
  const dirty = JSON.stringify(workflow) !== savedJson;
  const [selection, setSelection] = useState<Selection>({ kind: "workflow" });
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [showYaml, setShowYaml] = useState(false);
  const [simulation, setSimulation] = useState<SimulationView | undefined>();
  const [simChoices, setSimChoices] = useState<Record<string, string>>({});
  const [simOpen, setSimOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [saveScope, setSaveScope] = useState(scope);
  const [paletteFilter, setPaletteFilter] = useState("");
  const wrapper = useRef<HTMLDivElement>(null);

  const commit = useCallback((next: Workflow) => setHistory((h) => ({ past: [...h.past.slice(-50), h.present], present: next, future: [] })), []);
  const undo = () => setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1] as Workflow, future: [h.present, ...h.future] } : h));
  const redo = () => setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0] as Workflow, future: h.future.slice(1) } : h));

  // Live-Validierung (serverseitig, gleiche Regeln wie beim Start)
  useEffect(() => {
    const t = setTimeout(() => void api.validateWorkflow(workflow, project).then((r) => setIssues(r.issues), () => undefined), 400);
    return () => clearTimeout(t);
  }, [workflow, project]);

  const issueCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const i of issues) if (i.nodeId && i.severity === "error") map[i.nodeId] = (map[i.nodeId] ?? 0) + 1;
    return map;
  }, [issues]);

  const graph = useMemo(() => toFlow(workflow, agents, { issues: issueCount }), [workflow, agents, issueCount]);
  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>(graph.nodes);
  useEffect(() => {
    setNodes((current) => graph.nodes.map((n) => ({ ...n, selected: current.find((c) => c.id === n.id)?.selected ?? false })));
  }, [graph.nodes]);
  const edges: Edge<FlowEdgeData>[] = useMemo(() => graph.edges.map((e) => ({ ...e, selected: selection.kind === "edge" && selection.index === e.data?.index })), [graph.edges, selection]);

  const onNodesChange = useCallback((changes: NodeChange<Node<FlowNodeData>>[]) => setNodes((n) => applyNodeChanges(changes, n)), []);

  const updateNode = (id: string, node: WorkflowNode) => commit({ ...workflow, nodes: { ...workflow.nodes, [id]: node } });
  const removeNode = (id: string) => {
    if (workflow.nodes[id]?.type === "start") return;
    const { [id]: _removed, ...rest } = workflow.nodes;
    void _removed;
    const { [id]: _pos, ...layout } = workflow.layout;
    void _pos;
    commit({ ...workflow, nodes: rest, layout, edges: workflow.edges.filter((e) => e.to !== id && e.from.split(".")[0] !== id && e.loop?.onExceeded !== id) });
    setSelection({ kind: "workflow" });
  };
  const renameNode = (oldId: string, newId: string) => {
    if (workflow.nodes[newId]) return;
    const nodesNext = Object.fromEntries(Object.entries(workflow.nodes).map(([k, v]) => [k === oldId ? newId : k, v]));
    const layout = Object.fromEntries(Object.entries(workflow.layout).map(([k, v]) => [k === oldId ? newId : k, v]));
    const edgesNext = workflow.edges.map((e) => {
      const [from, port] = e.from.split(".");
      return {
        ...e,
        from: from === oldId ? (port ? `${newId}.${port}` : newId) : e.from,
        to: e.to === oldId ? newId : e.to,
        ...(e.loop ? { loop: { ...e.loop, onExceeded: e.loop.onExceeded === oldId ? newId : e.loop.onExceeded } } : {}),
      };
    });
    commit({ ...workflow, nodes: nodesNext, layout, edges: edgesNext });
    setSelection({ kind: "node", id: newId });
  };
  const updateEdge = (index: number, edge: WorkflowEdge) => commit({ ...workflow, edges: workflow.edges.map((e, i) => (i === index ? edge : e)) });
  const removeEdge = (index: number) => {
    commit({ ...workflow, edges: workflow.edges.filter((_, i) => i !== index) });
    setSelection({ kind: "workflow" });
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    const node = workflow.nodes[c.source];
    if (!node) return;
    const port = c.sourceHandle ?? "next";
    const single = nodePorts(node).length === 1 && port !== "error";
    const from = single ? c.source : `${c.source}.${port}`;
    if (workflow.edges.some((e) => e.from === from && e.to === c.target)) return;
    commit({ ...workflow, edges: [...workflow.edges, { from, to: c.target }] });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const raw = event.dataTransfer.getData("application/aiflow");
    if (!raw) return;
    const payload = JSON.parse(raw) as { type: WorkflowNode["type"]; agent?: string };
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const base = payload.type === "agent" ? (payload.agent ?? "agent") : payload.type;
    const id = uniqueId(workflow, base);
    commit({ ...workflow, nodes: { ...workflow.nodes, [id]: newNode(payload.type, payload) }, layout: { ...workflow.layout, [id]: [Math.round(position.x), Math.round(position.y)] } });
    setSelection({ kind: "node", id });
  };

  const save = useMutation({
    mutationFn: () => api.saveDefinition<Workflow>("workflows", workflow.id, workflow, saveScope, project),
    onSuccess: () => {
      setSavedJson(JSON.stringify(workflow));
      void qc.invalidateQueries({ queryKey: ["definitions"] });
    },
  });
  const simulate = useMutation({ mutationFn: () => api.simulate(workflow.id, { workflow, ...(project ? { project } : {}), choices: simChoices }), onSuccess: setSimulation });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        save.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity !== "error");
  const decisionNodes = Object.entries(workflow.nodes).filter(([, n]) => (n.type === "agent" && n.ports && Object.keys(n.ports).length > 1) || n.type === "human");
  const agentList = [...agents.values()].filter((a) => !paletteFilter || a.name.toLowerCase().includes(paletteFilter.toLowerCase()));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <Link to={`/workflows${project ? `?project=${encodeURIComponent(project)}` : ""}`} className="text-sm text-slate-500 hover:text-slate-800">
          Workflows /
        </Link>
        <span className="font-semibold">{workflow.name}</span>
        <Badge color="indigo">/aiflow-wf-{workflow.command ?? workflow.id}</Badge>
        <span className="font-mono text-[10px] text-slate-400">@{version.slice(0, 8)}</span>
        {dirty && <Badge color="amber">ungespeichert</Badge>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={undo} disabled={!history.past.length} title="Rückgängig (Strg+Z)">
            <Icon name="undo" size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={!history.future.length} title="Wiederholen (Strg+Umschalt+Z)">
            <Icon name="redo" size={14} />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => commit({ ...workflow, layout: autoLayout(workflow) })} title="Automatisch anordnen">
            <Icon name="layout" size={14} /> Layout
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowYaml(true)}>
            <Icon name="download" size={14} /> YAML
          </Button>
          <Button size="sm" onClick={() => setSimOpen(true)}>
            <Icon name="beaker" size={14} /> Testlauf
          </Button>
          <Select value={saveScope} onChange={(e) => setSaveScope(e.target.value as "global" | "project")} className="w-32 py-1 text-xs" options={[{ value: "global", label: "Global" }, ...(project ? [{ value: "project", label: "Projekt" }] : [])]} />
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            <Icon name="save" size={14} /> Speichern
          </Button>
          <Button size="sm" variant="primary" disabled={!project || dirty || errors.length > 0} onClick={() => setStarting(true)} title={dirty ? "Erst speichern" : !project ? "Projekt wählen" : ""}>
            <Icon name="play" size={12} /> Starten
          </Button>
        </div>
      </div>
      {save.error && (
        <div className="px-4 pt-2">
          <ErrorBox error={save.error} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Agenten</div>
          <Input placeholder="Filtern…" value={paletteFilter} onChange={(e) => setPaletteFilter(e.target.value)} className="mb-2 py-1 text-xs" />
          <div className="space-y-1">
            {agentList.map((a) => (
              <div
                key={a.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/aiflow", JSON.stringify({ type: "agent", agent: a.id }))}
                className="flex cursor-grab items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs shadow-sm hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800"
                title={a.description}
              >
                <AgentAvatar name={a.name} color={a.appearance.color} size={20} />
                <span className="truncate font-medium">{a.name}</span>
              </div>
            ))}
          </div>
          <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Bausteine</div>
          <div className="space-y-1">
            {BLOCKS.map((b) => (
              <div
                key={b.type}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("application/aiflow", JSON.stringify({ type: b.type }))}
                className="cursor-grab rounded-lg border border-dashed border-slate-300 px-2 py-1.5 text-xs hover:border-indigo-300 dark:border-slate-600"
                title={b.hint}
              >
                <div className="font-medium">{NODE_TYPE_LABEL[b.type]}</div>
                <div className="truncate text-[10px] text-slate-500">{b.hint}</div>
              </div>
            ))}
          </div>
        </aside>
        <div className="relative min-w-0 flex-1" ref={wrapper} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={(_, node) => commit({ ...workflow, layout: { ...workflow.layout, [node.id]: [Math.round(node.position.x), Math.round(node.position.y)] } })}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelection({ kind: "node", id: n.id })}
            onEdgeClick={(_, e) => setSelection({ kind: "edge", index: e.data?.index ?? 0 })}
            onPaneClick={() => setSelection({ kind: "workflow" })}
            onNodesDelete={(deleted) => deleted.forEach((n) => removeNode(n.id))}
            onEdgesDelete={(deleted) => {
              const indices = new Set(deleted.map((e) => e.data?.index));
              commit({ ...workflow, edges: workflow.edges.filter((_, i) => !indices.has(i)) });
            }}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            deleteKeyCode={["Delete", "Backspace"]}
            defaultEdgeOptions={{ type: "aiflow" }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <AutoFit />
          </ReactFlow>
          <div className="absolute inset-x-3 bottom-3 z-10 max-w-[calc(100%-240px)]">
            {(errors.length > 0 || warnings.length > 0) && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-white/95 text-xs shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
                <div className="sticky top-0 border-b border-slate-100 bg-white/95 px-3 py-1.5 font-semibold dark:border-slate-800 dark:bg-slate-900/95">
                  Probleme: {errors.length} Fehler, {warnings.length} Hinweise
                </div>
                {issues.map((i, k) => (
                  <button key={k} type="button" className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => i.nodeId && workflow.nodes[i.nodeId] && setSelection({ kind: "node", id: i.nodeId })}>
                    <span className={i.severity === "error" ? "text-rose-600" : "text-amber-600"}>{i.severity === "error" ? "✖" : "⚠"}</span>
                    <span>{i.message}</span>
                  </button>
                ))}
              </div>
            )}
            {errors.length === 0 && warnings.length === 0 && <div className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 shadow dark:bg-emerald-950 dark:text-emerald-300"><Icon name="check" size={12} /> Workflow ist gültig</div>}
          </div>
        </div>
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          {selection.kind === "node" && workflow.nodes[selection.id] ? (
            <NodeInspector
              key={selection.id}
              id={selection.id}
              node={workflow.nodes[selection.id] as WorkflowNode}
              workflow={workflow}
              agents={agents}
              workflows={workflows}
              onChange={(n) => updateNode(selection.id, n)}
              onRename={(newId) => renameNode(selection.id, newId)}
              onDelete={() => removeNode(selection.id)}
            />
          ) : selection.kind === "edge" && workflow.edges[selection.index] ? (
            <EdgeInspector key={selection.index} edge={workflow.edges[selection.index] as WorkflowEdge} workflow={workflow} onChange={(e) => updateEdge(selection.index, e)} onDelete={() => removeEdge(selection.index)} />
          ) : (
            <WorkflowInspector workflow={workflow} onChange={commit} />
          )}
        </aside>
      </div>
      <Modal open={showYaml} onClose={() => setShowYaml(false)} title={`${workflow.id}.yaml`} wide>
        <Textarea rows={28} mono readOnly value={stringify(workflow)} />
      </Modal>
      <Modal
        open={simOpen}
        onClose={() => setSimOpen(false)}
        title="Testlauf ohne LLM"
        wide
        footer={
          <>
            <Button onClick={() => setSimOpen(false)}>Schließen</Button>
            <Button variant="primary" onClick={() => simulate.mutate()} disabled={simulate.isPending}>
              <Icon name="beaker" size={14} /> Simulieren
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">Agenten werden simuliert, Skripte gelingen, Entscheidungen kannst du vorgeben. So prüfst du Pfade, Schleifen und Zusammenführungen in Sekunden.</p>
          {decisionNodes.map(([id, n]) => {
            const ports = n.type === "human" ? n.ports : Object.keys(n.type === "agent" ? (n.ports ?? {}) : {});
            return (
              <div key={id} className="flex items-center gap-2 text-sm">
                <span className="w-48 truncate">{n.label ?? id}</span>
                <Select value={simChoices[id] ?? ""} onChange={(e) => setSimChoices({ ...simChoices, [id]: e.target.value })} className="w-56" options={[{ value: "", label: "automatisch" }, ...ports.map((p) => ({ value: p, label: p }))]} />
              </div>
            );
          })}
          <ErrorBox error={simulate.error} />
          {simulation && (
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                Ergebnis: <Badge color={simulation.status === "completed" || simulation.status === "review_pending" ? "green" : "amber"}>{simulation.status}</Badge> {simulation.error && <span className="text-rose-600">{simulation.error}</span>}
              </div>
              <ol className="flex flex-wrap items-center gap-1 text-xs">
                {simulation.path.map((p, i) => (
                  <li key={i} className="flex items-center gap-1">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{p.label}</span>
                    {p.port && p.port !== "next" && <span className="text-indigo-600">{p.port}</span>}
                    {i < simulation.path.length - 1 && <span className="text-slate-400">→</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </Modal>
      {starting && <StartRunDialog workflowId={workflow.id} onClose={() => setStarting(false)} />}
    </div>
  );
}

export function WorkflowEditor() {
  const { id = "" } = useParams();
  const [project] = useProject();
  const entry = useQuery({ queryKey: ["definition", "workflows", id, project], queryFn: () => api.getDefinition<Workflow>("workflows", id, project) });
  if (entry.error) return <div className="p-6"><ErrorBox error={entry.error} /></div>;
  if (!entry.data?.definition) return <div className="p-6 text-sm text-slate-500">Lädt…</div>;
  return (
    <ReactFlowProvider>
      <Editor key={`${entry.data.scope}-${entry.data.version}`} initial={entry.data.definition} scope={entry.data.scope} version={entry.data.version} />
    </ReactFlowProvider>
  );
}

