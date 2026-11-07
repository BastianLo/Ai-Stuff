import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, useProject } from "../lib/api";
import { useLiveRun } from "../lib/queries";
import { DiffView, FileStatusIcon } from "../components/Diff";
import { Markdown } from "../components/Markdown";
import { Icon } from "../components/Icon";
import { Badge, Button, cx, ErrorBox, Field, Input, Modal, Select, StatusBadge, Textarea } from "../components/ui";

/** Review wie bei einem Pull Request: Dateien, Diff, Teil-Übernahme, Änderungen anfordern (PLAN.md 11.6). */
export function ReviewPage() {
  const { id = "" } = useParams();
  const [project] = useProject();
  const run = useLiveRun(id);
  const qc = useQueryClient();
  const review = run.data?.review;
  const files = review?.files ?? [];
  const [active, setActive] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [requestOpen, setRequestOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [target, setTarget] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [showReport, setShowReport] = useState(true);
  useEffect(() => {
    setSelected(new Set(files.map((f) => f.path)));
    if (!active && files[0]) setActive(files[0].path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);
  const decide = useMutation({
    mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["run", id] });
      setRequestOpen(false);
      setBranchOpen(false);
    },
  });
  if (!run.data) return <div className="p-6 text-sm text-slate-500">Lädt…</div>;
  const pending = run.data.status === "review_pending";
  const file = files.find((f) => f.path === active);
  const writers = Object.entries(run.data.workflow.nodes).filter(([, n]) => n.type === "agent" && (n.workspace?.mode ?? "continue") !== "read-only");
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  const totals = files.reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-5 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/runs/${id}${q}`} className="text-sm text-slate-500 hover:text-slate-800">
            {run.data.workflow.name} /
          </Link>
          <span className="font-semibold">Review</span>
          <StatusBadge status={run.data.status} />
          <span className="text-xs text-slate-500">
            {files.length} Dateien · <span className="text-emerald-600">+{totals.add}</span> <span className="text-rose-600">−{totals.del}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={!pending} onClick={() => confirm("Ergebnis verwerfen?") && decide.mutate({ action: "discard" })}>
              <Icon name="x" size={12} /> Verwerfen
            </Button>
            <Button size="sm" disabled={!pending} onClick={() => setBranchOpen(true)}>
              <Icon name="branch" size={12} /> Als Branch
            </Button>
            <Button size="sm" disabled={!pending} onClick={() => setRequestOpen(true)}>
              Änderungen anfordern
            </Button>
            <Button size="sm" variant="primary" disabled={!pending || selected.size === 0} onClick={() => decide.mutate({ action: "apply", files: [...selected] })}>
              <Icon name="check" size={12} /> {selected.size === files.length ? "Alles übernehmen" : `${selected.size} übernehmen`}
            </Button>
          </div>
        </div>
        {review?.decided && (
          <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            Entschieden: {review.decided.action === "apply" ? "übernommen" : review.decided.action === "branch" ? "als Branch angelegt" : review.decided.action === "discard" ? "verworfen" : review.decided.action} {review.decided.detail ?? ""}
          </div>
        )}
        <ErrorBox error={decide.error} />
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <button type="button" onClick={() => setShowReport(true)} className={cx("flex w-full items-center gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm dark:border-slate-800", showReport && "bg-indigo-50 dark:bg-indigo-950")}>
            <Icon name="doc" size={14} /> Abschlussbericht & Dokumente
          </button>
          <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Geänderte Dateien</div>
          {files.map((f) => (
            <div key={f.path} className={cx("flex items-center gap-2 px-3 py-1.5 text-xs", active === f.path && !showReport && "bg-indigo-50 dark:bg-indigo-950")}>
              <input
                type="checkbox"
                checked={selected.has(f.path)}
                disabled={!pending}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(f.path);
                  else next.delete(f.path);
                  setSelected(next);
                }}
              />
              <FileStatusIcon status={f.status} />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-mono"
                onClick={() => {
                  setActive(f.path);
                  setShowReport(false);
                }}
              >
                {f.path}
              </button>
              {f.conflict && <Badge color="red" title="Auch von dir seit Run-Start geändert">Konflikt</Badge>}
              <span className="text-emerald-600">+{f.additions}</span>
            </div>
          ))}
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          {showReport ? (
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><Markdown text={review?.report ?? "Kein Bericht."} /></div>
              {review?.documents.map((d) => (
                <div key={d.name}>
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium">
                    <Icon name="doc" size={14} /> {d.name}
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"><Markdown text={d.content} /></div>
                </div>
              ))}
            </div>
          ) : file ? (
            <div>
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <FileStatusIcon status={file.status} />
                <span className="font-mono">{file.path}</span>
                <span className="text-xs text-emerald-600">+{file.additions}</span>
                <span className="text-xs text-rose-600">−{file.deletions}</span>
              </div>
              <DiffView patch={file.patch} />
            </div>
          ) : (
            <div className="text-sm text-slate-500">Keine Änderungen.</div>
          )}
        </div>
      </div>
      <Modal
        open={requestOpen}
        onClose={() => setRequestOpen(false)}
        title="Änderungen anfordern"
        footer={
          <>
            <Button onClick={() => setRequestOpen(false)}>Abbrechen</Button>
            <Button variant="primary" disabled={!feedback.trim()} onClick={() => decide.mutate({ action: "request-changes", feedback, ...(target ? { nodeId: target } : {}) })}>
              Run fortsetzen
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">Dein Feedback wird zur Übergabe; der Run läuft ab dem gewählten Knoten weiter (Limits gelten).</p>
          <Field label="Feedback">
            <Textarea rows={6} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="z. B. Bitte Rate-Limiting für den Reset-Endpunkt ergänzen." />
          </Field>
          <Field label="Weiter ab Knoten">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: "", label: "letzter schreibender Agent (Standard)" }, ...writers.map(([nid, n]) => ({ value: nid, label: n.label ?? nid }))]} />
          </Field>
        </div>
      </Modal>
      <Modal
        open={branchOpen}
        onClose={() => setBranchOpen(false)}
        title="Als Branch behalten"
        footer={
          <>
            <Button onClick={() => setBranchOpen(false)}>Abbrechen</Button>
            <Button variant="primary" onClick={() => decide.mutate({ action: "branch", ...(branch ? { name: branch } : {}) })}>
              Branch anlegen
            </Button>
          </>
        }
      >
        <Field label="Name (leer = automatisch aiflow/<workflow>/<datum>-<id>)">
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}
