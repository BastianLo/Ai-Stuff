import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Snippet } from "@aiflow/core";
import { api, useProject } from "../lib/api";
import { snippetList, useSnippets } from "../lib/queries";
import { Icon } from "../components/Icon";
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Textarea } from "../components/ui";

export function SnippetsPage() {
  const [project] = useProject();
  const snippets = useSnippets(project);
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Snippet | undefined>();
  const [scope, setScope] = useState<"global" | "project">("global");
  const save = useMutation({
    mutationFn: (s: Snippet) => api.saveDefinition("snippets", s.id, s, scope, project),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["definitions"] });
      setEdit(undefined);
    },
  });
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Bausteine"
        subtitle="Wiederverwendbare Instruktionen (z. B. Coding-Standards) und Dokument-Vorlagen. Agenten binden sie ein."
        actions={
          <Button variant="primary" onClick={() => setEdit({ schema: "aiflow/snippet@1", id: "", name: "", description: "", kind: "instruction", content: "" })}>
            <Icon name="plus" /> Neuer Baustein
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {snippetList(snippets.data).map((s) => (
              <li key={s.id}>
                <button type="button" className="w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => setEdit(s)}>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{s.name}</span>
                    <Badge color={s.kind === "instruction" ? "indigo" : "amber"}>{s.kind === "instruction" ? "Instruktion" : "Dokument-Vorlage"}</Badge>
                  </div>
                  <div className="text-xs text-slate-500">{s.description || s.content.slice(0, 80)}</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {edit && (
          <Card title={edit.id ? `Baustein „${edit.name}“` : "Neuer Baustein"}>
            <div className="space-y-3 p-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="ID">
                  <Input value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} />
                </Field>
                <Field label="Name">
                  <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </Field>
              </div>
              <Field label="Art">
                <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Snippet["kind"] })} options={[{ value: "instruction", label: "Instruktion (für Agenten)" }, { value: "document-template", label: "Dokument-Vorlage" }]} />
              </Field>
              <Field label="Beschreibung">
                <Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
              </Field>
              <Field label="Inhalt (Markdown)">
                <Textarea rows={10} mono value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} />
              </Field>
              <div className="flex items-center gap-2">
                <Select value={scope} onChange={(e) => setScope(e.target.value as "global" | "project")} options={[{ value: "global", label: "Global speichern" }, ...(project ? [{ value: "project", label: "Im Projekt speichern (.aiflow/)" }] : [])]} className="w-auto" />
                <Button variant="primary" onClick={() => save.mutate(edit)} disabled={!edit.id || !edit.name}>
                  Speichern
                </Button>
                <Button variant="ghost" onClick={() => setEdit(undefined)}>
                  Schließen
                </Button>
              </div>
              <ErrorBox error={save.error} />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
