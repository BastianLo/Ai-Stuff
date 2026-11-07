import { Link, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useProject } from "../lib/api";
import { useAgents } from "../lib/queries";
import { Icon } from "../components/Icon";
import { AgentAvatar, Badge, Button, Card, Empty, Input, PageHeader } from "../components/ui";
import { TEMPLATES } from "../lib/templates";

export function AgentsPage() {
  const [project] = useProject();
  const agents = useAgents(project);
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const list = (agents.data ?? []).filter((a) => !filter || `${a.id} ${a.definition?.name ?? ""} ${a.definition?.tags.join(" ") ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Agenten"
        subtitle="Wiederverwendbare Agenten mit Identität, Modell, Rechten und Ausgabe-Vertrag. Keine Rolle ist vorgegeben."
        actions={
          <>
            <Input placeholder="Suchen…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
            <Button variant="primary" onClick={() => navigate(`/agents/neu${q}`)}>
              <Icon name="plus" /> Neuer Agent
            </Button>
          </>
        }
      />
      {list.length === 0 ? (
        <Card>
          <Empty title="Keine Agenten">Lege einen Agenten an oder starte mit einer Vorlage.</Empty>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((a) => (
            <Link key={`${a.scope}-${a.id}`} to={`/agents/${a.id}${q}`} className="group">
              <Card className="h-full transition-shadow group-hover:shadow-md">
                <div className="flex gap-3 p-4">
                  <AgentAvatar name={a.definition?.name ?? a.id} color={a.definition?.appearance.color} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{a.definition?.name ?? a.id}</span>
                      {a.scope === "project" && <Badge color="sky">Projekt</Badge>}
                      {a.shadowed && <Badge>verdeckt</Badge>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{a.error ?? a.definition?.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Badge color={a.definition?.permissions.preset === "read-only" ? "slate" : "amber"}>{a.definition?.permissions.preset}</Badge>
                      {a.definition?.output.type === "json" && <Badge color="indigo">JSON-Ausgabe</Badge>}
                      {a.definition?.subagents?.enabled && <Badge color="violet">Sub-Agenten</Badge>}
                      {a.definition?.tags.map((t) => <Badge key={t}>{t}</Badge>)}
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
      <h2 className="mb-3 mt-8 text-sm font-semibold text-slate-700 dark:text-slate-300">Vorlagen (werden beim Anlegen kopiert)</h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" onClick={() => navigate(`/agents/neu${q}${q ? "&" : "?"}template=${t.id}`)} className="rounded-lg border border-dashed border-slate-300 p-3 text-left hover:border-indigo-400 hover:bg-indigo-50/50 dark:border-slate-700 dark:hover:bg-indigo-950/30">
            <div className="text-sm font-medium">{t.name}</div>
            <div className="line-clamp-2 text-xs text-slate-500">{t.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
