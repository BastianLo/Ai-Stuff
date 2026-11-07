import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, useProject } from "../lib/api";
import { useWorkflows, workflowList } from "../lib/queries";
import { Button, ErrorBox, Field, Input, Modal, Textarea } from "./ui";

export function StartRunDialog({ workflowId, onClose }: { workflowId: string; onClose: () => void }) {
  const [project] = useProject();
  const navigate = useNavigate();
  const workflow = workflowList(useWorkflows(project).data).find((w) => w.id === workflowId);
  const [values, setValues] = useState<Record<string, string>>({});
  const start = useMutation({
    mutationFn: () => api.startRun({ workflowId, projectDir: project ?? "", input: values, origin: "web" }),
    onSuccess: ({ id }) => navigate(`/runs/${id}${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Workflow starten: ${workflow?.name ?? workflowId}`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" disabled={!values.prompt?.trim() || start.isPending} onClick={() => start.mutate()}>
            Starten
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {workflow?.description && <p className="text-sm text-slate-600 dark:text-slate-400">{workflow.description}</p>}
        {Object.entries(workflow?.inputs ?? { prompt: { type: "text", required: true } }).map(([key, spec]) => (
          <Field key={key} label={`${spec.label ?? (key === "prompt" ? "Auftrag" : key)}${spec.required ? " *" : ""}`}>
            {spec.type === "text" ? (
              <Textarea rows={5} autoFocus={key === "prompt"} value={values[key] ?? ""} onChange={(e) => setValues({ ...values, [key]: e.target.value })} placeholder="Was soll umgesetzt werden? Der Text geht unverändert an den Workflow." />
            ) : (
              <Input value={values[key] ?? ""} onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
            )}
          </Field>
        ))}
        <p className="text-xs text-slate-500">Projekt: {project}</p>
        <ErrorBox error={start.error} />
      </div>
    </Modal>
  );
}
