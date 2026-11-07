import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useProject } from "../lib/api";
import { dateTime, duration, STATUS_LABEL } from "../lib/format";
import { useWorkflows, workflowList } from "../lib/queries";
import { Badge, Card, Empty, Input, PageHeader, Select, StatusBadge } from "../components/ui";

export function RunsPage() {
  const [project] = useProject();
  const [status, setStatus] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [query, setQuery] = useState("");
  const workflows = useWorkflows(project);
  const runs = useQuery({
    queryKey: ["runs", project, status, workflow, query],
    queryFn: () => api.runs({ ...(project ? { project } : {}), ...(status ? { status } : {}), ...(workflow ? { workflow } : {}), ...(query ? { q: query } : {}) }),
  });
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Runs" subtitle="History aller Ausführungen. Jeder Run lässt sich nachspielen und vergleichen." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="Im Auftrag suchen…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-64" />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48" options={[{ value: "", label: "Alle Status" }, ...Object.entries(STATUS_LABEL).filter(([k]) => k !== "waiting").map(([value, label]) => ({ value, label }))]} />
        <Select value={workflow} onChange={(e) => setWorkflow(e.target.value)} className="w-56" options={[{ value: "", label: "Alle Workflows" }, ...workflowList(workflows.data).map((w) => ({ value: w.id, label: w.name }))]} />
      </div>
      <Card>
        {(runs.data ?? []).length === 0 ? (
          <Empty title="Keine Runs gefunden" />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800">
              <tr>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Auftrag</th>
                <th className="px-4 py-2 font-medium">Workflow</th>
                <th className="px-4 py-2 font-medium">Start</th>
                <th className="px-4 py-2 font-medium">Dauer</th>
                <th className="px-4 py-2 font-medium">Schritte</th>
                <th className="px-4 py-2 font-medium">Quelle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {runs.data?.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-4 py-2.5">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="max-w-sm px-4 py-2.5">
                    <Link to={`/runs/${r.id}${q}`} className="line-clamp-1 font-medium text-slate-800 hover:text-indigo-600 dark:text-slate-100">
                      {r.prompt}
                    </Link>
                    {r.error && <div className="line-clamp-1 text-xs text-rose-600">{r.error}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">
                    {r.workflowName} <span className="font-mono text-[10px] text-slate-400">@{r.workflowVersion.slice(0, 6)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500">{dateTime(r.createdAt)}</td>
                  <td className="px-4 py-2.5 text-slate-500">{duration((r.finishedAt ?? Date.now()) - (r.startedAt ?? r.createdAt))}</td>
                  <td className="px-4 py-2.5 text-slate-500">{r.stepCount}</td>
                  <td className="px-4 py-2.5">
                    <Badge>{r.origin}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
