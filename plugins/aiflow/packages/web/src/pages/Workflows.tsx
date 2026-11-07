import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { workflowSchema } from "@aiflow/core";
import { api, useProject } from "../lib/api";
import { useWorkflows } from "../lib/queries";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader } from "../components/ui";
import { StartRunDialog } from "../components/StartRunDialog";

export function WorkflowsPage() {
  const [project] = useProject();
  const workflows = useWorkflows(project);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState<string | undefined>();
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const create = useMutation({
    mutationFn: () =>
      api.saveDefinition(
        "workflows",
        id,
        workflowSchema.parse({
          id,
          name,
          nodes: { start: { type: "start" }, done: { type: "end", finalize: "review" } },
          edges: [{ from: "start", to: "done" }],
          layout: { start: [0, 200], done: [600, 200] },
        }),
        "global",
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["definitions"] });
      navigate(`/workflows/${id}${q}`);
    },
  });
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Workflows"
        subtitle="Feste Umsetzungsabläufe aus Agenten und Bausteinen. Jeder Workflow wird als /aiflow-wf-<name> in opencode registriert."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" /> Neuer Workflow
          </Button>
        }
      />
      {(workflows.data ?? []).length === 0 ? (
        <Card>
          <Empty title="Keine Workflows" />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {workflows.data?.map((w) => {
            const def = w.definition;
            const nodes = def ? Object.values(def.nodes) : [];
            return (
              <Card key={`${w.scope}-${w.id}`} className="flex flex-col">
                <div className="flex-1 p-4">
                  <div className="flex items-center gap-2">
                    <Link to={`/workflows/${w.id}${q}`} className="font-semibold hover:text-indigo-600">
                      {def?.name ?? w.id}
                    </Link>
                    {w.scope === "project" && <Badge color="sky">Projekt</Badge>}
                    {w.error && <Badge color="red">Fehler</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-indigo-600 dark:text-indigo-300">/aiflow-wf-{def?.command ?? w.id}</div>
                  <p className="mt-2 line-clamp-2 text-sm text-slate-600 dark:text-slate-400">{w.error ?? def?.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1">
                    <Badge>{nodes.filter((n) => n.type === "agent").length} Agenten</Badge>
                    {nodes.some((n) => n.type === "join") && <Badge color="violet">parallel</Badge>}
                    {nodes.some((n) => n.type === "script") && <Badge color="sky">Skript-Gates</Badge>}
                    {nodes.some((n) => n.type === "human") && <Badge color="amber">Mensch</Badge>}
                    {nodes.some((n) => n.type === "map") && <Badge color="indigo">Für jedes</Badge>}
                    {nodes.some((n) => n.type === "agent" && n.subagents?.enabled) && <Badge color="violet">Sub-Agenten</Badge>}
                    {Object.keys(def?.documents ?? {}).map((d) => <Badge key={d}>{d}</Badge>)}
                  </div>
                </div>
                <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-2 dark:border-slate-800">
                  <Link to={`/workflows/${w.id}${q}`}>
                    <Button size="sm">Bearbeiten</Button>
                  </Link>
                  <Button size="sm" variant="primary" disabled={!project || Boolean(w.error)} onClick={() => setStart(w.id)}>
                    <Icon name="play" size={12} /> Starten
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Neuer Workflow"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Abbrechen</Button>
            <Button variant="primary" disabled={!id || !name} onClick={() => create.mutate()}>
              Anlegen
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="ID (wird zum Command /aiflow-wf-<id>)">
            <Input value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <ErrorBox error={create.error} />
        </div>
      </Modal>
      {start && <StartRunDialog workflowId={start} onClose={() => setStart(undefined)} />}
    </div>
  );
}
