import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, useProject } from "../lib/api";
import { duration, relative } from "../lib/format";
import { useAgents, useWorkflows, workflowList } from "../lib/queries";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, Empty, PageHeader, StatusBadge } from "../components/ui";
import { StartRunDialog } from "../components/StartRunDialog";
import { useState } from "react";

export function Dashboard() {
  const [project] = useProject();
  const runs = useQuery({ queryKey: ["runs", project], queryFn: () => api.runs({ ...(project ? { project } : {}), limit: 50 }) });
  const inbox = useQuery({ queryKey: ["inbox", project], queryFn: () => api.inbox(project) });
  const workflows = useWorkflows(project);
  const agents = useAgents(project);
  const [start, setStart] = useState<string | undefined>();
  const active = (runs.data ?? []).filter((r) => ["running", "waiting_input", "review_pending", "paused", "interrupted"].includes(r.status));
  const recent = (runs.data ?? []).filter((r) => !active.includes(r)).slice(0, 8);
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const stats = [
    { label: "Aktive Runs", value: active.length },
    { label: "Offene Punkte", value: inbox.data?.length ?? 0 },
    { label: "Workflows", value: workflowList(workflows.data).length },
    { label: "Agenten", value: (agents.data ?? []).filter((a) => !a.shadowed).length },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Übersicht" subtitle={project ? `Projekt ${project}` : "Kein Projekt gewählt – Runs brauchen ein Projekt (oben auswählen)."} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-xs text-slate-500">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold">{s.value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card title="Aktive Runs">
            {active.length === 0 ? (
              <Empty title="Nichts in Arbeit">Starte rechts einen Workflow oder in opencode mit /aiflow-wf-…</Empty>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {active.map((r) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}${q}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <StatusBadge status={r.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{r.prompt}</div>
                        <div className="text-xs text-slate-500">
                          {r.workflowName} · {r.stepCount} Schritte · {relative(r.createdAt)}
                        </div>
                      </div>
                      <Icon name="external" className="text-slate-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Zuletzt" actions={<Link to={`/runs${q}`} className="text-xs font-medium text-indigo-600">Alle Runs</Link>}>
            {recent.length === 0 ? (
              <Empty title="Noch keine abgeschlossenen Runs" />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {recent.map((r) => (
                  <li key={r.id}>
                    <Link to={`/runs/${r.id}${q}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <StatusBadge status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-sm">{r.prompt}</span>
                      <span className="text-xs text-slate-500">{r.workflowName}</span>
                      <span className="w-20 text-right text-xs text-slate-500">{duration((r.finishedAt ?? Date.now()) - (r.startedAt ?? r.createdAt))}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <Card title="Wartet auf dich" actions={<Link to={`/inbox${q}`} className="text-xs font-medium text-indigo-600">Inbox</Link>}>
            {(inbox.data ?? []).length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">Nichts offen.</div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {inbox.data?.slice(0, 5).map((i) => (
                  <li key={i.id} className="px-4 py-2.5 text-sm">
                    <Badge color={i.kind === "review" ? "violet" : "amber"}>{i.kind === "review" ? "Review" : i.kind === "human" ? "Freigabe" : "Rückfrage"}</Badge>
                    <div className="mt-1 font-medium">{i.title}</div>
                    <div className="line-clamp-2 text-xs text-slate-500">{i.question}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Schnellstart">
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {workflowList(workflows.data).map((w) => (
                <li key={w.id} className="flex items-center gap-2 px-4 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{w.name}</div>
                    <div className="truncate font-mono text-[11px] text-slate-500">/aiflow-wf-{w.command ?? w.id}</div>
                  </div>
                  <Button size="sm" variant="secondary" disabled={!project} onClick={() => setStart(w.id)} title={project ? "" : "Erst ein Projekt wählen"}>
                    <Icon name="play" size={12} /> Start
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
      {start && <StartRunDialog workflowId={start} onClose={() => setStart(undefined)} />}
    </div>
  );
}
