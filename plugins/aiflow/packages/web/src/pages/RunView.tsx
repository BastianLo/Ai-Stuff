import { useMutation, useQuery } from "@tanstack/react-query";
import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { RunEvent, StepRecord } from "@aiflow/core";
import type { RunView as RunViewData } from "@aiflow/client";
import { api, useProject } from "../lib/api";
import { dateTime, duration, NODE_TYPE_LABEL, tokens } from "../lib/format";
import { useLiveRun } from "../lib/queries";
import { toFlow, type FlowNodeData } from "../components/flow/model";
import { AutoFit, edgeTypes, nodeTypes } from "../components/flow/nodes";
import { DiffView, FileStatusIcon } from "../components/Diff";
import { Markdown } from "../components/Markdown";
import { Icon } from "../components/Icon";
import { AgentAvatar, Badge, Button, cx, ErrorBox, StatusBadge, STATUS_COLOR, Tabs } from "../components/ui";

type Tab = "steps" | "documents" | "changes" | "events";

function nodeStatus(run: RunViewData) {
  const status: Record<string, FlowNodeData["status"]> = {};
  const visits: Record<string, number> = {};
  const summaries: Record<string, string> = {};
  const delegation: Record<string, StepRecord["delegation"]> = {};
  for (const s of run.steps) {
    if (s.parentStepId) continue;
    status[s.nodeId] = s.status;
    visits[s.nodeId] = Math.max(visits[s.nodeId] ?? 0, s.visit);
    if (s.handoff?.summary && s.nodeType !== "start") summaries[s.nodeId] = s.handoff.summary;
    if (s.delegation) delegation[s.nodeId] = s.delegation;
  }
  const traversals: Record<number, number> = {};
  for (const [key, count] of Object.entries(run.edgeCounts)) {
    const index = Number(key.split("#")[1]);
    if (!Number.isNaN(index)) traversals[index] = count;
  }
  for (const s of run.steps) {
    if (s.parentStepId || s.status !== "completed" || !s.port) continue;
    run.workflow.edges.forEach((e, i) => {
      if ((e.from === s.nodeId || e.from === `${s.nodeId}.${s.port}`) && !run.workflow.edges[i]?.loop) traversals[i] = Math.max(traversals[i] ?? 0, 1);
    });
  }
  return { status, visits, summaries, delegation, traversals };
}

function Timeline({ run, onSelect, selected }: { run: RunViewData; onSelect: (id: string) => void; selected?: string }) {
  const top = run.steps.filter((s) => !s.parentStepId && s.nodeType !== "start" && s.nodeType !== "end");
  const start = run.startedAt ?? run.createdAt;
  const end = Math.max(run.finishedAt ?? Date.now(), ...run.steps.map((s) => s.finishedAt ?? Date.now()));
  const span = Math.max(1, end - start);
  return (
    <div className="space-y-0.5">
      {top.map((s) => {
        const left = ((s.startedAt - start) / span) * 100;
        const width = Math.max(0.8, (((s.finishedAt ?? Date.now()) - s.startedAt) / span) * 100);
        const subs = run.steps.filter((x) => x.parentStepId === s.id);
        return (
          <div key={s.id}>
            <button type="button" onClick={() => onSelect(s.id)} className={cx("flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800", selected === s.id && "bg-indigo-50 dark:bg-indigo-950")}>
              <span className="w-40 shrink-0 truncate">
                {s.label}
                {s.visit > 1 && <span className="text-slate-400"> #{s.visit}</span>}
              </span>
              <span className="relative h-3.5 flex-1 rounded bg-slate-100 dark:bg-slate-800">
                <span className={cx("absolute top-0 h-3.5 rounded", { running: "bg-indigo-500 animate-pulse", completed: "bg-emerald-500", failed: "bg-rose-500", waiting: "bg-amber-500", cancelled: "bg-slate-400" }[s.status])} style={{ left: `${left}%`, width: `${width}%` }} />
              </span>
              <span className="w-14 shrink-0 text-right text-slate-500">{duration(s.metrics.durationMs ?? Date.now() - s.startedAt)}</span>
            </button>
            {subs.length > 0 && (
              <div className="ml-6 border-l border-slate-200 pl-2 dark:border-slate-700">
                {subs.map((x) => (
                  <button key={x.id} type="button" onClick={() => onSelect(x.id)} className={cx("flex w-full items-center gap-2 px-1 py-0.5 text-left text-[11px] text-slate-600 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800", selected === x.id && "bg-indigo-50 dark:bg-indigo-950")}>
                    <span className={cx("h-1.5 w-1.5 rounded-full", { running: "bg-indigo-500", completed: "bg-emerald-500", failed: "bg-rose-500", waiting: "bg-amber-500", cancelled: "bg-slate-400" }[x.status])} />
                    {x.wave !== undefined && <span className="text-slate-400">W{x.wave}</span>}
                    <span className="truncate">{x.label}</span>
                    <span className="ml-auto truncate text-slate-400">{x.handoff?.summary}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepDetail({ run, step, events }: { run: RunViewData; step: StepRecord; events: RunEvent[] }) {
  const [view, setView] = useState<"summary" | "prompt" | "transcript" | "diff">("summary");
  const diff = useQuery({ queryKey: ["stepdiff", run.id, step.id], queryFn: () => api.stepDiff(run.id, step.id), enabled: view === "diff" });
  const agent = step.agentId ? run.agents[step.agentId] : undefined;
  const own = events.filter((e) => e.stepId === step.id);
  const decision = own.find((e) => e.type === "step.decision");
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {agent ? <AgentAvatar name={agent.name} color={agent.appearance.color} /> : <span className="h-7 w-7 rounded-lg bg-slate-200 dark:bg-slate-700" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{step.label}</span>
            <Badge color={STATUS_COLOR[step.status] ?? "slate"}>{step.status}</Badge>
            <Badge>{NODE_TYPE_LABEL[step.nodeType] ?? step.nodeType}</Badge>
            {step.visit > 1 && <Badge color="indigo">Durchlauf {step.visit}</Badge>}
            {step.port && step.port !== "next" && <Badge color="violet">→ {step.port}</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {dateTime(step.startedAt)} · {duration(step.metrics.durationMs)} · Tokens {tokens(step.metrics.inputTokens)} / {tokens(step.metrics.outputTokens)} · Tool-Aufrufe {step.metrics.toolCalls ?? 0}
            {step.attempt > 1 && ` · Versuch ${step.attempt}`}
          </div>
        </div>
      </div>
      <Tabs
        active={view}
        onChange={setView}
        tabs={[
          { id: "summary", label: "Übergabe" },
          { id: "prompt", label: "Prompt" },
          { id: "transcript", label: `Verlauf (${own.length})` },
          { id: "diff", label: "Diff" },
        ]}
      />
      {view === "summary" && (
        <div className="space-y-3 text-sm">
          {step.error && <ErrorBox error={step.error} />}
          {step.handoff?.summary && <p className="whitespace-pre-wrap">{step.handoff.summary}</p>}
          {step.handoff?.branch && (
            <div className="rounded-lg bg-violet-50 p-3 text-sm dark:bg-violet-950">
              <div className="font-medium">Entscheidung: {step.handoff.branch}</div>
              {step.handoff.branchReason && <div className="text-slate-600 dark:text-slate-300">{step.handoff.branchReason}</div>}
              {step.votes && <div className="mt-1 text-xs">Stimmen: {step.votes.join(", ")}</div>}
              {Boolean(decision?.data.tie) && <div className="text-xs text-amber-700">Gleichstand → Fallback-Zweig</div>}
            </div>
          )}
          {step.handoff?.handoff && <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">{step.handoff.handoff}</div>}
          {step.handoff?.output !== undefined && <pre className="max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">{JSON.stringify(step.handoff.output, null, 2)}</pre>}
          {step.script && (
            <div>
              <div className="mb-1 font-mono text-xs">
                $ {step.script.command} → Exit {step.script.exitCode}
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{step.script.output}</pre>
            </div>
          )}
          {step.delegation && (
            <div className="text-xs text-slate-600 dark:text-slate-300">
              Sub-Agenten: {step.delegation.waves} Wellen · {step.delegation.runs} von {step.delegation.budget} Läufen
            </div>
          )}
          {step.combined !== undefined && step.nodeType === "join" && <pre className="max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">{JSON.stringify(step.combined, null, 2)}</pre>}
        </div>
      )}
      {view === "prompt" && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-slate-500">System-Prompt</div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">{step.systemPrompt ?? "–"}</pre>
          <div className="text-xs font-medium text-slate-500">Prompt des Schritts (exakt so gesendet)</div>
          <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-950">{step.prompt ?? "–"}</pre>
        </div>
      )}
      {view === "transcript" && (
        <ol className="space-y-1.5 text-xs">
          {own.map((e) => (
            <li key={e.seq} className="flex gap-2">
              <span className="w-16 shrink-0 text-slate-400">{new Date(e.ts).toLocaleTimeString("de-DE")}</span>
              <span className="w-32 shrink-0 font-mono text-slate-500">{e.type.replace("step.", "")}</span>
              <span className="min-w-0 break-words">{eventText(e)}</span>
            </li>
          ))}
        </ol>
      )}
      {view === "diff" && (
        <div className="space-y-3">
          {(diff.data ?? []).length === 0 && <div className="text-sm text-slate-500">Keine Änderungen in diesem Schritt.</div>}
          {diff.data?.map((f) => (
            <div key={f.path}>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                <FileStatusIcon status={f.status} /> {f.path} <span className="text-emerald-600">+{f.additions}</span> <span className="text-rose-600">−{f.deletions}</span>
              </div>
              <DiffView patch={f.patch} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function eventText(e: RunEvent): string {
  const d = e.data;
  switch (e.type) {
    case "step.text":
      return String(d.text ?? "");
    case "step.tool":
      return `${String(d.tool)} ${String(d.status)}${d.input ? ` ${JSON.stringify(d.input).slice(0, 120)}` : ""}`;
    case "step.progress":
      return String(d.message ?? "");
    case "step.decision":
      return `→ ${String(d.winner)}${d.votes ? ` (Stimmen: ${(d.votes as string[]).join(", ")})` : ""}`;
    case "step.handoff":
      return String(d.summary ?? "");
    case "delegation.wave_started":
      return `Welle ${String(d.wave)}: ${(d.tasks as { agent: string }[]).length} Teilaufgaben`;
    case "delegation.wave_completed":
      return `Welle ${String(d.wave)} fertig, Budget übrig: ${String(d.remaining)}`;
    case "step.violation":
      return String(d.message ?? "");
    default:
      return JSON.stringify(d).slice(0, 200);
  }
}

function Content({ run }: { run: RunViewData }) {
  const [project] = useProject();
  const [tab, setTab] = useState<Tab>("steps");
  const [selected, setSelected] = useState<string | undefined>();
  const events = useQuery({ queryKey: ["events", run.id, run.steps.length, run.status], queryFn: () => api.runEvents(run.id) });
  const docs = useQuery({ queryKey: ["docs", run.id, run.steps.length], queryFn: () => api.runDocuments(run.id), enabled: tab === "documents" });
  const action = useMutation({ mutationFn: (a: "pause" | "resume" | "cancel") => (a === "pause" ? api.pauseRun(run.id) : a === "resume" ? api.resumeRun(run.id) : api.cancelRun(run.id)) });
  const live = nodeStatus(run);
  const graph = useMemo(() => toFlow(run.workflow, new Map(Object.entries(run.agents)), live), [run]);
  const step = run.steps.find((s) => s.id === selected) ?? [...run.steps].reverse().find((s) => !s.parentStepId && s.nodeType !== "start" && s.nodeType !== "end");
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const totals = run.steps.reduce((acc, s) => ({ input: acc.input + (s.metrics.inputTokens ?? 0), output: acc.output + (s.metrics.outputTokens ?? 0) }), { input: 0, output: 0 });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-5 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/runs${q}`} className="text-sm text-slate-500 hover:text-slate-800">
            Runs /
          </Link>
          <span className="font-semibold">{run.workflow.name}</span>
          <StatusBadge status={run.status} />
          {run.outcome && <Badge>{run.outcome}</Badge>}
          {run.parentRunId && (
            <Link to={`/runs/${run.parentRunId}${q}`} className="text-xs text-indigo-600">
              ↑ Eltern-Run
            </Link>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-slate-500">
              {duration((run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt))} · Tokens {tokens(totals.input)} / {tokens(totals.output)}
            </span>
            {run.status === "running" && (
              <Button size="sm" onClick={() => action.mutate("pause")}>
                <Icon name="pause" size={12} /> Pause
              </Button>
            )}
            {(run.status === "paused" || run.status === "interrupted") && (
              <Button size="sm" onClick={() => action.mutate("resume")}>
                <Icon name="play" size={12} /> Fortsetzen
              </Button>
            )}
            {["running", "waiting_input", "paused", "interrupted"].includes(run.status) && (
              <Button size="sm" variant="ghost" onClick={() => confirm("Run abbrechen?") && action.mutate("cancel")}>
                <Icon name="stop" size={12} /> Abbrechen
              </Button>
            )}
            {run.status === "waiting_input" && (
              <Link to={`/inbox${q}`}>
                <Button size="sm" variant="primary">
                  Antworten
                </Button>
              </Link>
            )}
            {(run.status === "review_pending" || run.review) && (
              <Link to={`/runs/${run.id}/review${q}`}>
                <Button size="sm" variant={run.status === "review_pending" ? "primary" : "secondary"}>
                  <Icon name="eye" size={12} /> Review
                </Button>
              </Link>
            )}
          </div>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-slate-600 dark:text-slate-300">{String(run.input.prompt ?? "")}</p>
        {run.error && <div className="mt-2"><ErrorBox error={run.error} /></div>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.12 }} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, n) => setSelected([...run.steps].reverse().find((s) => s.nodeId === n.id && !s.parentStepId)?.id)}>
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <AutoFit />
          </ReactFlow>
        </div>
        <aside className="flex w-[520px] shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="px-4 pt-2">
            <Tabs<Tab>
              active={tab}
              onChange={setTab}
              tabs={[
                { id: "steps", label: "Ablauf" },
                { id: "documents", label: `Dokumente (${Object.keys(run.workflow.documents).length})` },
                { id: "changes", label: "Änderungen" },
                { id: "events", label: "Ereignisse" },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === "steps" && (
              <div className="space-y-4">
                <Timeline run={run} onSelect={setSelected} {...(step ? { selected: step.id } : {})} />
                {step && (
                  <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
                    <StepDetail run={run} step={step} events={events.data ?? []} />
                  </div>
                )}
              </div>
            )}
            {tab === "documents" && (
              <div className="space-y-4">
                {docs.data?.map((d) => (
                  <div key={d.name}>
                    <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                      <Icon name="doc" size={14} /> {d.name} <Badge>{d.versions.length} Versionen</Badge>
                    </div>
                    <div className="mb-1 text-xs text-slate-500">{d.description}</div>
                    <div className="max-h-96 overflow-auto rounded-lg bg-slate-50 p-3 dark:bg-slate-950">{d.content ? <Markdown text={d.content} /> : <span className="text-xs text-slate-500">(leer)</span>}</div>
                    {d.versions.length > 1 && (
                      <div className="mt-1 text-[11px] text-slate-500">
                        Versionen: {d.versions.map((v) => `${run.steps.find((s) => s.id === v.stepId)?.label ?? v.stepId} (${new Date(v.ts).toLocaleTimeString("de-DE")})`).join(" → ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {tab === "changes" && (
              <div className="space-y-2 text-sm">
                {!run.review && <div className="text-slate-500">Die Gesamtänderungen stehen nach dem Ende des Runs bereit. Diffs pro Schritt: im Ablauf einen Schritt wählen → Diff.</div>}
                {run.review?.files.map((f) => (
                  <div key={f.path} className="flex items-center gap-2">
                    <FileStatusIcon status={f.status} /> <span className="font-mono text-xs">{f.path}</span>
                    <span className="ml-auto text-xs text-emerald-600">+{f.additions}</span>
                    <span className="text-xs text-rose-600">−{f.deletions}</span>
                  </div>
                ))}
                {run.review?.decided && (
                  <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                    Entscheidung: {run.review.decided.action} {run.review.decided.detail ?? ""}
                  </div>
                )}
              </div>
            )}
            {tab === "events" && (
              <ol className="space-y-1 text-xs">
                {(events.data ?? []).map((e) => (
                  <li key={e.seq} className="flex gap-2">
                    <span className="w-8 shrink-0 text-right text-slate-400">{e.seq}</span>
                    <span className="w-44 shrink-0 font-mono text-slate-600 dark:text-slate-400">{e.type}</span>
                    <span className="min-w-0 truncate text-slate-500">{eventText(e)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export function RunView() {
  const { id } = useParams();
  const run = useLiveRun(id);
  if (run.error) return <div className="p-6"><ErrorBox error={run.error} /></div>;
  if (!run.data) return <div className="p-6 text-sm text-slate-500">Lädt…</div>;
  return (
    <ReactFlowProvider>
      <Content run={run.data} />
    </ReactFlowProvider>
  );
}
