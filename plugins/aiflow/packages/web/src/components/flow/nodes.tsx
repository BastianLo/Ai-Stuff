import { useEffect } from "react";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Handle, Position, useNodesInitialized, useReactFlow, type EdgeProps, type Node, type NodeProps, type Edge } from "@xyflow/react";
import { NODE_TYPE_LABEL } from "../../lib/format";
import { AgentAvatar, Badge, cx } from "../ui";
import type { FlowEdgeData, FlowNodeData } from "./model";

const TYPE_STYLE: Record<string, { color: string; glyph: string }> = {
  start: { color: "#10b981", glyph: "▶" },
  end: { color: "#64748b", glyph: "■" },
  script: { color: "#0ea5e9", glyph: "$" },
  condition: { color: "#f59e0b", glyph: "?" },
  join: { color: "#8b5cf6", glyph: "⋈" },
  map: { color: "#ec4899", glyph: "∀" },
  human: { color: "#f97316", glyph: "☺" },
  subworkflow: { color: "#14b8a6", glyph: "⧉" },
};

const STATUS_RING: Record<string, string> = {
  running: "ring-2 ring-indigo-500 node-running",
  waiting: "ring-2 ring-amber-500",
  completed: "ring-2 ring-emerald-500",
  failed: "ring-2 ring-rose-500",
  cancelled: "ring-1 ring-slate-400 opacity-70",
  idle: "",
};

function subtitle(data: FlowNodeData): string {
  const n = data.node;
  switch (n.type) {
    case "agent":
      return data.agent?.name ?? n.agent;
    case "script":
      return n.command;
    case "join":
      return n.combine.strategy === "vote" ? `Abstimmung · ${n.combine.rule ?? "majority"}` : `warten: ${n.wait}`;
    case "map":
      return `${data.agent?.name ?? n.agent} je Element`;
    case "human":
      return n.question;
    case "subworkflow":
      return n.workflow;
    case "end":
      return `${n.outcome}${n.finalize ? ` · ${n.finalize}` : ""}`;
    default:
      return NODE_TYPE_LABEL[n.type] ?? n.type;
  }
}

export function AiflowNode({ data, selected }: NodeProps<Node<FlowNodeData>>) {
  const n = data.node;
  const style = TYPE_STYLE[n.type];
  const title = n.label ?? (n.type === "agent" ? (data.agent?.name ?? data.id) : (NODE_TYPE_LABEL[n.type] ?? data.id));
  const ports = data.ports;
  const docs = n.type === "agent" ? Object.entries(n.documents) : [];
  const sub = n.type === "agent" && (n.subagents?.enabled ?? data.agent?.subagents?.enabled);
  return (
    <div
      className={cx(
        "relative w-[220px] rounded-xl border bg-white text-left shadow-sm dark:bg-slate-900",
        selected ? "border-indigo-500 shadow-indigo-200 dark:shadow-none" : "border-slate-200 dark:border-slate-700",
        data.issues ? "border-rose-400" : "",
        STATUS_RING[data.status ?? "idle"],
      )}
    >
      {n.type !== "start" && <Handle type="target" position={Position.Left} id="in" className="!bg-slate-400" />}
      <div className="flex items-center gap-2 px-3 pt-2.5">
        {n.type === "agent" || n.type === "map" ? (
          <AgentAvatar name={data.agent?.name ?? title} color={data.agent?.appearance.color} size={26} />
        ) : (
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: style?.color ?? "#64748b" }}>
            {style?.glyph ?? "•"}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight">{title}</div>
          <div className="truncate text-[11px] text-slate-500">{subtitle(data)}</div>
        </div>
        {(data.visits ?? 0) > 1 && <Badge color="indigo">×{data.visits}</Badge>}
      </div>
      <div className="flex flex-wrap gap-1 px-3 pb-2 pt-1.5">
        {n.type === "agent" && n.workspace?.mode && n.workspace.mode !== "continue" && <Badge color="sky">{n.workspace.mode}</Badge>}
        {docs.map(([doc, access]) => (
          <Badge key={doc} color={access.startsWith("write") ? "amber" : "slate"} title={`${doc}: ${access}`}>
            {doc.replace(/\.md$/, "")} {access === "write-required" ? "W!" : access === "write" ? "W" : access === "append" ? "A" : "R"}
          </Badge>
        ))}
        {sub && <Badge color="violet">Sub-Agenten</Badge>}
        {n.type === "agent" && (n.decision?.votes ?? 1) > 1 && <Badge color="violet">{n.decision?.votes} Stimmen</Badge>}
        {data.delegation && (
          <Badge color="indigo">
            Welle {data.delegation.waves} · {data.delegation.runs}/{data.delegation.budget}
          </Badge>
        )}
      </div>
      {data.lastSummary && <div className="mx-3 mb-2 line-clamp-2 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{data.lastSummary}</div>}
      {ports.length > 0 && (
        <div className="border-t border-slate-100 py-1 dark:border-slate-800">
          {ports.map((port) => (
            <div key={port} className="relative flex h-5 items-center justify-end pr-3 text-[10px] font-medium text-slate-500">
              <span className={port === "error" ? "text-rose-500" : ""}>{port === "next" ? "weiter" : port}</span>
              <Handle type="source" position={Position.Right} id={port} className={port === "error" ? "!bg-rose-500" : "!bg-indigo-500"} style={{ top: "50%" }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function NoteNode({ data }: NodeProps<Node<FlowNodeData>>) {
  const text = data.node.type === "note" ? data.node.text : "";
  return <div className="w-[220px] rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 shadow-sm dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">{text || "Notiz"}</div>;
}

export function AiflowEdge(props: EdgeProps<Edge<FlowEdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, label, selected, markerEnd } = props;
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: data?.back ? 40 : 20 });
  const color = data?.error ? "#f43f5e" : (data?.traversals ?? 0) > 0 ? "#6366f1" : data?.back ? "#94a3b8" : "#94a3b8";
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={{ stroke: selected ? "#4f46e5" : color, strokeWidth: selected || (data?.traversals ?? 0) > 0 ? 2.2 : 1.5, strokeDasharray: data?.back ? "6 4" : undefined }} />
      {(label || data?.loopMax) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label && <span>{label}</span>}
            {data?.loopMax && (
              <span className="ml-1 text-indigo-600 dark:text-indigo-300">
                ↺ {data.traversals ? `${data.traversals}/` : "max "}
                {data.loopMax}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const nodeTypes = { aiflow: AiflowNode, note: NoteNode };
export const edgeTypes = { aiflow: AiflowEdge };

/** Passt die Ansicht an, sobald die Knotengrößen gemessen sind. */
export function AutoFit({ deps = "" }: { deps?: string }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!initialized) return;
    const timer = setTimeout(() => void fitView({ padding: 0.1, duration: 0 }), 60);
    return () => clearTimeout(timer);
  }, [initialized, fitView, deps]);
  return null;
}
