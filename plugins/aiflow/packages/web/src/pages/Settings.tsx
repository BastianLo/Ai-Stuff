import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { relative } from "../lib/format";
import { useRuntime } from "../lib/queries";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, ErrorBox, Input, PageHeader } from "../components/ui";

export function SettingsPage() {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health() });
  const runtime = useRuntime();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });
  const [path, setPath] = useState("");
  const add = useMutation({ mutationFn: () => api.registerProject(path), onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }) });
  const trust = useMutation({ mutationFn: (p: string) => api.trustProject(p), onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }) });
  const rt = health.data?.runtime;
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="Einstellungen" subtitle="Daemon, Agent-Runtime, Projekte und Workspace-Trust." />
      <Card title="Agent-Runtime">
        <dl className="grid grid-cols-[180px_1fr] gap-y-2 p-4 text-sm">
          <dt className="text-slate-500">Runtime</dt>
          <dd>
            {rt?.id} {rt?.api && <Badge color="indigo">opencode {rt.api}</Badge>} {rt?.version}
          </dd>
          <dt className="text-slate-500">Status</dt>
          <dd>{rt?.ready ? <Badge color="green">bereit</Badge> : <Badge color="amber">{rt?.error ?? "startet…"}</Badge>}</dd>
          <dt className="text-slate-500">Modelle</dt>
          <dd className="flex flex-wrap gap-1">{runtime.data?.models.slice(0, 12).map((m) => <Badge key={`${m.providerID}/${m.modelID}`}>{`${m.providerID}/${m.modelID}`}</Badge>)}</dd>
          <dt className="text-slate-500">MCP-Server</dt>
          <dd className="flex flex-wrap gap-1">{(runtime.data?.mcp ?? []).length === 0 ? <span className="text-slate-400">keine</span> : runtime.data?.mcp.map((m) => <Badge key={m.name} color={m.status === "connected" ? "green" : "amber"}>{m.name}</Badge>)}</dd>
          <dt className="text-slate-500">opencode-Konfiguration</dt>
          <dd className="font-mono text-xs">{runtime.data?.paths.opencodeConfig ?? <span className="font-sans text-slate-400">Standard von opencode (zusätzlich: Projekt-opencode.json)</span>}</dd>
          <dt className="text-slate-500">Datenverzeichnis</dt>
          <dd className="font-mono text-xs">{runtime.data?.paths.data}</dd>
          <dt className="text-slate-500">Konfiguration</dt>
          <dd className="font-mono text-xs">{runtime.data?.paths.config}/config.json</dd>
        </dl>
      </Card>
      <Card title="Projekte">
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {projects.data?.map((p) => (
            <li key={p.path} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.name}</div>
                <div className="truncate font-mono text-xs text-slate-500">{p.path}</div>
              </div>
              <span className="text-xs text-slate-500">{relative(p.lastUsed)}</span>
              {p.trusted ? (
                <Badge color="green">freigegeben</Badge>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => trust.mutate(p.path)} title="Projekt-Definitionen in .aiflow/ dürfen Befehle ausführen">
                  <Icon name="shield" size={12} /> Freigeben
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
          <Input placeholder="/pfad/zum/projekt (git-Repository)" value={path} onChange={(e) => setPath(e.target.value)} />
          <Button onClick={() => add.mutate()} disabled={!path}>
            Hinzufügen
          </Button>
        </div>
        <div className="px-4 pb-4">
          <ErrorBox error={add.error ?? trust.error} />
        </div>
      </Card>
      <Card title="Workspace-Trust">
        <p className="p-4 text-sm text-slate-600 dark:text-slate-400">
          Workflows aus <code>.aiflow/</code> eines Projekts können Befehle ausführen (Skript-Knoten, Setup-Befehle). Sie laufen erst nach Freigabe. Ändern sich die Projekt-Definitionen, ist eine erneute Freigabe nötig.
        </p>
      </Card>
    </div>
  );
}
