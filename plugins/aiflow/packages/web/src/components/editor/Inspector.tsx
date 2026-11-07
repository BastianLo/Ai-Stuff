import { useState, type ReactNode } from "react";
import {
  contextIncludeSchema,
  type AgentDefinition,
  type DocumentAccess,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
  type NodeOf,
} from "@aiflow/core";
import { NODE_TYPE_LABEL } from "../../lib/format";
import { Icon } from "../Icon";
import { Badge, Button, Field, Input, Select, Textarea, Toggle, cx } from "../ui";

const ACCESS_OPTIONS: { value: DocumentAccess; label: string }[] = [
  { value: "none", label: "–" },
  { value: "read", label: "R" },
  { value: "append", label: "A" },
  { value: "write", label: "W" },
  { value: "write-required", label: "W!" },
];

function Section({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-slate-100 dark:border-slate-800">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
        <span>{open ? "−" : "+"}</span>
      </button>
      {open && <div className="space-y-3 px-4 pb-4">{children}</div>}
    </div>
  );
}

function JsonField({ label, value, onChange, hint }: { label: string; value: unknown; onChange: (v: unknown) => void; hint?: string }) {
  const [text, setText] = useState(JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string>();
  return (
    <Field label={label} hint={error ? <span className="text-rose-600">{error}</span> : hint}>
      <Textarea
        rows={4}
        mono
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setError(undefined);
          } catch (err) {
            setError(err instanceof Error ? err.message : "ungültig");
          }
        }}
      />
    </Field>
  );
}

const csv = (list: string[] | undefined) => (list ?? []).join(", ");
const fromCsv = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

interface NodeInspectorProps {
  id: string;
  node: WorkflowNode;
  workflow: Workflow;
  agents: Map<string, AgentDefinition>;
  workflows: Workflow[];
  onChange: (node: WorkflowNode) => void;
  onRename: (newId: string) => void;
  onDelete: () => void;
}

export function NodeInspector({ id, node, workflow, agents, workflows, onChange, onRename, onDelete }: NodeInspectorProps) {
  const set = <T extends WorkflowNode>(patch: Partial<T>) => onChange({ ...node, ...patch } as WorkflowNode);
  const agentOptions = [...agents.values()].map((a) => ({ value: a.id, label: a.name }));
  const [idDraft, setIdDraft] = useState(id);
  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div>
          <div className="text-xs text-slate-500">{NODE_TYPE_LABEL[node.type]}</div>
          <div className="font-semibold">{node.label ?? id}</div>
        </div>
        {node.type !== "start" && (
          <Button size="sm" variant="ghost" onClick={onDelete} title="Knoten löschen (Entf)">
            <Icon name="trash" size={14} />
          </Button>
        )}
      </div>
      <Section title="Allgemein">
        <Field label="ID" hint="Wird in Templates verwendet: {{node.<id>…}}">
          <Input value={idDraft} onChange={(e) => setIdDraft(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "-"))} onBlur={() => idDraft !== id && idDraft && onRename(idDraft)} />
        </Field>
        <Field label="Bezeichnung">
          <Input value={node.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })} />
        </Field>
      </Section>

      {node.type === "agent" && <AgentNodeFields id={id} node={node} workflow={workflow} agents={agents} agentOptions={agentOptions} set={set} />}

      {node.type === "script" && (
        <Section title="Skript">
          <Field label="Befehl" hint="Template, z. B. {{vars.checkCommand}}">
            <Input className="font-mono" value={node.command} onChange={(e) => set<NodeOf<"script">>({ command: e.target.value })} />
          </Field>
          <Field label="Timeout">
            <Input value={String(node.timeout)} onChange={(e) => set<NodeOf<"script">>({ timeout: e.target.value })} />
          </Field>
          <JsonField label="Port-Regeln (optional)" hint='Standard: passed (Exit 0) / failed. Eigene: {"rot":{"when":{"!=":[{"var":"exitCode"},0]}},"gruen":{"else":true}}' value={node.ports ?? null} onChange={(v) => set<NodeOf<"script">>({ ports: v ? (v as NodeOf<"script">["ports"]) : undefined })} />
        </Section>
      )}

      {node.type === "condition" && (
        <Section title="Regeln (JSON Logic)">
          {Object.entries(node.rules).map(([port, rule]) => (
            <div key={port} className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge color="amber">{port}</Badge>
                <button type="button" className="text-xs text-rose-600" onClick={() => set<NodeOf<"condition">>({ rules: Object.fromEntries(Object.entries(node.rules).filter(([p]) => p !== port)) })}>
                  entfernen
                </button>
              </div>
              <JsonField label="" value={rule} onChange={(v) => set<NodeOf<"condition">>({ rules: { ...node.rules, [port]: v } })} />
            </div>
          ))}
          <Button size="sm" onClick={() => set<NodeOf<"condition">>({ rules: { ...node.rules, [`regel-${Object.keys(node.rules).length + 1}`]: { "==": [{ var: "node.x.branch" }, "approved"] } } })}>
            <Icon name="plus" size={12} /> Regel
          </Button>
          <p className="text-[11px] text-slate-500">Greift keine Regel, feuert der Port „else“.</p>
        </Section>
      )}

      {node.type === "join" && (
        <Section title="Zusammenführung">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Warten auf">
              <Select value={node.wait} onChange={(e) => set<NodeOf<"join">>({ wait: e.target.value as NodeOf<"join">["wait"] })} options={[{ value: "all", label: "alle" }, { value: "first", label: "ersten (Race)" }, { value: "n-of-m", label: "n von m" }]} />
            </Field>
            {node.wait === "n-of-m" && (
              <Field label="n">
                <Input type="number" min={1} value={node.n ?? 1} onChange={(e) => set<NodeOf<"join">>({ n: Number(e.target.value) })} />
              </Field>
            )}
          </div>
          <Field label="Kombination">
            <Select
              value={node.combine.strategy}
              onChange={(e) => set<NodeOf<"join">>({ combine: e.target.value === "vote" ? { strategy: "vote", field: "output.approved", rule: "veto", ports: { true: "approved", false: "rejected" } } : { strategy: "collect" } })}
              options={[{ value: "collect", label: "sammeln" }, { value: "vote", label: "Abstimmung" }]}
            />
          </Field>
          {node.combine.strategy === "vote" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Feld">
                <Input value={node.combine.field ?? ""} onChange={(e) => set<NodeOf<"join">>({ combine: { ...node.combine, field: e.target.value } })} />
              </Field>
              <Field label="Regel">
                <Select value={node.combine.rule ?? "majority"} onChange={(e) => set<NodeOf<"join">>({ combine: { ...node.combine, rule: e.target.value as "majority" | "unanimous" | "veto" } })} options={[{ value: "majority", label: "Mehrheit" }, { value: "unanimous", label: "einstimmig" }, { value: "veto", label: "Veto" }]} />
              </Field>
            </div>
          )}
          <Field label="Workspace">
            <Select value={node.workspace} onChange={(e) => set<NodeOf<"join">>({ workspace: e.target.value as NodeOf<"join">["workspace"] })} options={[{ value: "keep-base", label: "Basis behalten (Zweige haben gelesen)" }, { value: "candidates", label: "Kandidaten (Nachfolger wählt)" }, { value: "git-merge", label: "git-Merge der Zweige" }]} />
          </Field>
        </Section>
      )}

      {node.type === "map" && (
        <Section title="Für jedes">
          <Field label="Liste (Pfad)" hint="z. B. node.plan.output.tasks">
            <Input className="font-mono" value={node.items} onChange={(e) => set<NodeOf<"map">>({ items: e.target.value })} />
          </Field>
          <Field label="Agent">
            <Select value={node.agent} onChange={(e) => set<NodeOf<"map">>({ agent: e.target.value })} options={agentOptions} />
          </Field>
          <Field label="Auftrag je Element" hint="{{item}}, {{index}}">
            <Textarea rows={2} value={node.task} onChange={(e) => set<NodeOf<"map">>({ task: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Parallel">
              <Input type="number" min={1} value={node.maxParallel} onChange={(e) => set<NodeOf<"map">>({ maxParallel: Number(e.target.value) })} />
            </Field>
            <Field label="Workspace">
              <Select value={node.workspace} onChange={(e) => set<NodeOf<"map">>({ workspace: e.target.value as "read-only" | "isolate" })} options={[{ value: "isolate", label: "isoliert" }, { value: "read-only", label: "nur lesen" }]} />
            </Field>
            <Field label="Einsammeln">
              <Select value={node.merge} onChange={(e) => set<NodeOf<"map">>({ merge: e.target.value as "git-merge" | "none" })} options={[{ value: "git-merge", label: "git-Merge" }, { value: "none", label: "nichts" }]} />
            </Field>
          </div>
        </Section>
      )}

      {node.type === "human" && (
        <Section title="Frage an den Menschen">
          <Field label="Frage (Template)">
            <Textarea rows={3} value={node.question} onChange={(e) => set<NodeOf<"human">>({ question: e.target.value })} />
          </Field>
          <Field label="Antworten / Ports (Komma)">
            <Input value={csv(node.ports)} onChange={(e) => set<NodeOf<"human">>({ ports: fromCsv(e.target.value) })} />
          </Field>
          <Toggle checked={node.allowFreeText} onChange={(v) => set<NodeOf<"human">>({ allowFreeText: v })} label="Freitext erlauben" />
        </Section>
      )}

      {node.type === "subworkflow" && (
        <Section title="Sub-Workflow">
          <Field label="Workflow">
            <Select value={node.workflow} onChange={(e) => set<NodeOf<"subworkflow">>({ workflow: e.target.value })} options={workflows.filter((w) => w.id !== workflow.id).map((w) => ({ value: w.id, label: w.name }))} />
          </Field>
          <Field label="Auftrag (Template)">
            <Input value={node.prompt} onChange={(e) => set<NodeOf<"subworkflow">>({ prompt: e.target.value })} />
          </Field>
          <p className="text-[11px] text-slate-500">Ports: success, rejected, failed. Arbeitet im Workspace des Aufrufers weiter.</p>
        </Section>
      )}

      {node.type === "end" && (
        <Section title="Abschluss">
          <Field label="Ergebnis">
            <Select value={node.outcome} onChange={(e) => set<NodeOf<"end">>({ outcome: e.target.value as NodeOf<"end">["outcome"] })} options={["success", "rejected", "failed", "cancelled"].map((v) => ({ value: v, label: v }))} />
          </Field>
          <Field label="Abschluss-Modus" hint="Leer = Standard des Workflows">
            <Select
              value={node.finalize ?? ""}
              onChange={(e) => set<NodeOf<"end">>({ finalize: (e.target.value || undefined) as NodeOf<"end">["finalize"] })}
              options={[{ value: "", label: "Standard" }, { value: "review", label: "Review (PR-Ansicht)" }, { value: "apply", label: "direkt übernehmen" }, { value: "branch", label: "als Branch" }, { value: "patch", label: "Patch-Datei" }, { value: "none", label: "nur Bericht" }]}
            />
          </Field>
          <Field label="Bericht (Template, optional)">
            <Textarea rows={3} value={node.report ?? ""} onChange={(e) => set<NodeOf<"end">>({ report: e.target.value || undefined })} />
          </Field>
        </Section>
      )}

      {node.type === "note" && (
        <Section title="Notiz">
          <Textarea rows={5} value={node.text} onChange={(e) => set<NodeOf<"note">>({ text: e.target.value })} />
        </Section>
      )}
    </div>
  );
}

function AgentNodeFields({
  id,
  node,
  workflow,
  agents,
  agentOptions,
  set,
}: {
  id: string;
  node: NodeOf<"agent">;
  workflow: Workflow;
  agents: Map<string, AgentDefinition>;
  agentOptions: { value: string; label: string }[];
  set: <T extends WorkflowNode>(patch: Partial<T>) => void;
}) {
  const agent = agents.get(node.agent);
  const ports = Object.entries(node.ports ?? {});
  const sub = { ...(agent?.subagents ?? {}), ...(node.subagents ?? {}) };
  const setSub = (patch: Record<string, unknown>) => set<NodeOf<"agent">>({ subagents: { ...(node.subagents ?? {}), ...patch } as NodeOf<"agent">["subagents"] });
  void id;
  return (
    <>
      <Section title="Agent">
        <Field label="Agent">
          <Select value={node.agent} onChange={(e) => set<NodeOf<"agent">>({ agent: e.target.value })} options={agentOptions} />
        </Field>
        {agent && <p className="text-[11px] text-slate-500">{agent.description}</p>}
        <Field label="Aufgabe in diesem Schritt" hint="Zusatzanweisung, Template-Variablen erlaubt">
          <Textarea rows={3} value={node.instructions ?? ""} onChange={(e) => set<NodeOf<"agent">>({ instructions: e.target.value || undefined })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Kontext-Modus">
            <Select
              value={node.contextMode ?? ""}
              onChange={(e) => set<NodeOf<"agent">>({ contextMode: (e.target.value || undefined) as NodeOf<"agent">["contextMode"] })}
              options={[{ value: "", label: `Agent (${agent?.contextMode ?? "fresh"})` }, { value: "fresh", label: "frisch" }, { value: "resume", label: "fortsetzen" }, { value: "fork", label: "fork" }]}
            />
          </Field>
          <Field label="Retries">
            <Input type="number" min={0} max={5} value={node.retries ?? ""} placeholder={String(agent?.limits.retries ?? 1)} onChange={(e) => set<NodeOf<"agent">>({ retries: e.target.value === "" ? undefined : Number(e.target.value) })} />
          </Field>
        </div>
      </Section>
      <Section title="Workspace">
        <Field label="Modus">
          <Select
            value={node.workspace?.mode ?? "continue"}
            onChange={(e) => set<NodeOf<"agent">>({ workspace: { ...(node.workspace ?? {}), mode: e.target.value as "continue" } })}
            options={[{ value: "continue", label: "weiterarbeiten" }, { value: "isolate", label: "isolierte Kopie" }, { value: "read-only", label: "nur lesen" }, { value: "scratch", label: "leeres Verzeichnis" }]}
          />
        </Field>
        <Field label="Schreibbereich (Glob, Komma)" hint="z. B. docs/**, **/*.md">
          <Input value={csv(node.workspace?.writeScope)} onChange={(e) => set<NodeOf<"agent">>({ workspace: { mode: node.workspace?.mode ?? "continue", writeScope: fromCsv(e.target.value).length ? fromCsv(e.target.value) : undefined } })} />
        </Field>
      </Section>
      <Section title={`Verzweigung (${ports.length > 1 ? `${ports.length} Zweige` : "keine"})`}>
        {ports.map(([port, spec]) => (
          <div key={port} className="space-y-1 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
            <div className="flex items-center gap-2">
              <Badge color="indigo">{port}</Badge>
              <button type="button" className="ml-auto text-xs text-rose-600" onClick={() => set<NodeOf<"agent">>({ ports: Object.keys(node.ports ?? {}).length > 1 ? Object.fromEntries(ports.filter(([p]) => p !== port)) : undefined })}>
                entfernen
              </button>
            </div>
            <Textarea rows={2} placeholder="Wann ist dieser Zweig zu wählen?" value={spec.description} onChange={(e) => set<NodeOf<"agent">>({ ports: { ...node.ports, [port]: { ...spec, description: e.target.value } } })} />
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              const name = prompt("Name des Zweigs (z. B. approved)")?.trim().toLowerCase().replace(/[^a-z0-9-_]/g, "-");
              if (name) set<NodeOf<"agent">>({ ports: { ...(node.ports ?? {}), [name]: { description: "" } } });
            }}
          >
            <Icon name="plus" size={12} /> Zweig
          </Button>
          {ports.length > 1 && (
            <div className="flex items-center gap-2 text-xs">
              Stimmen
              <Input type="number" min={1} max={9} className="w-16" value={node.decision?.votes ?? agent?.decision.votes ?? 1} onChange={(e) => set<NodeOf<"agent">>({ decision: { ...(node.decision ?? {}), votes: Number(e.target.value) } })} />
              Fallback
              <Select className="w-28" value={node.decision?.fallback ?? ""} onChange={(e) => set<NodeOf<"agent">>({ decision: { ...(node.decision ?? {}), fallback: e.target.value || undefined } })} options={[{ value: "", label: "–" }, ...ports.map(([p]) => ({ value: p, label: p }))]} />
            </div>
          )}
        </div>
      </Section>
      <Section title="Dokumente">
        {Object.keys(workflow.documents).length === 0 && <p className="text-xs text-slate-500">Keine Workflow-Dokumente definiert (Workflow-Einstellungen).</p>}
        {Object.keys(workflow.documents).map((doc) => (
          <div key={doc} className="flex items-center justify-between gap-2 text-sm">
            <span className="font-mono text-xs">{doc}</span>
            <Select
              className="w-24"
              value={node.documents[doc] ?? "none"}
              onChange={(e) => set<NodeOf<"agent">>({ documents: { ...node.documents, [doc]: e.target.value as DocumentAccess } })}
              options={ACCESS_OPTIONS}
            />
          </div>
        ))}
      </Section>
      <Section title="Sub-Agenten" defaultOpen={Boolean(sub.enabled)}>
        <Toggle checked={Boolean(sub.enabled)} onChange={(v) => setSub({ enabled: v, ...(v && !sub.allowed ? { allowed: [] } : {}) })} label="Darf Sub-Agenten starten" />
        {sub.enabled && (
          <>
            <Field label="Erlaubte Agenten">
              <div className="flex flex-wrap gap-1.5">
                {[...agents.values()].map((a) => {
                  const on = (sub.allowed ?? []).includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSub({ allowed: on ? (sub.allowed ?? []).filter((x) => x !== a.id) : [...(sub.allowed ?? []), a.id] })}
                      className={cx("rounded-md px-2 py-0.5 text-xs ring-1 ring-inset", on ? "bg-indigo-600 text-white ring-indigo-600" : "ring-slate-300 dark:ring-slate-600")}
                    >
                      {a.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Modus">
                <Select value={sub.mode ?? "optional"} onChange={(e) => setSub({ mode: e.target.value })} options={[{ value: "optional", label: "optional" }, { value: "enforced", label: "erzwungen" }]} />
              </Field>
              <Field label="Workspace">
                <Select value={sub.workspace ?? "read-only"} onChange={(e) => setSub({ workspace: e.target.value })} options={[{ value: "read-only", label: "nur lesen" }, { value: "isolate", label: "isoliert" }]} />
              </Field>
              <Field label="Max. parallel">
                <Input type="number" min={1} value={sub.maxParallel ?? 4} onChange={(e) => setSub({ maxParallel: Number(e.target.value) })} />
              </Field>
              <Field label="Max. Runs">
                <Input type="number" min={1} value={sub.maxRuns ?? 12} onChange={(e) => setSub({ maxRuns: Number(e.target.value) })} />
              </Field>
              <Field label="Max. Wellen">
                <Input type="number" min={1} value={sub.maxWaves ?? ""} onChange={(e) => setSub({ maxWaves: e.target.value ? Number(e.target.value) : undefined })} />
              </Field>
              <Field label="Tiefe">
                <Input type="number" min={0} max={3} value={sub.depth ?? 0} onChange={(e) => setSub({ depth: Number(e.target.value) })} />
              </Field>
            </div>
          </>
        )}
      </Section>
    </>
  );
}

export function EdgeInspector({ edge, workflow, onChange, onDelete }: { edge: WorkflowEdge; workflow: Workflow; onChange: (e: WorkflowEdge) => void; onDelete: () => void }) {
  const include = edge.handoff?.include ?? [];
  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div>
          <div className="text-xs text-slate-500">Verbindung</div>
          <div className="font-mono text-sm font-semibold">
            {edge.from} → {edge.to}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          <Icon name="trash" size={14} />
        </Button>
      </div>
      <Section title="Übergabe">
        <Field label="Übergabe-Anweisung" hint="Was der Sender für diesen Weg mitgeben soll; der Empfänger sieht sie als Überschrift.">
          <Textarea rows={3} value={edge.handoff?.instruction ?? ""} onChange={(e) => onChange({ ...edge, handoff: { ...(edge.handoff ?? {}), instruction: e.target.value || undefined } })} />
        </Field>
        <Field label="Zusätzlicher Kontext">
          <div className="flex flex-wrap gap-1.5">
            {contextIncludeSchema.options.map((opt) => {
              const on = include.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => onChange({ ...edge, handoff: { ...(edge.handoff ?? {}), include: on ? include.filter((x) => x !== opt) : [...include, opt] } })}
                  className={cx("rounded-md px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset", on ? "bg-indigo-600 text-white ring-indigo-600" : "ring-slate-300 dark:ring-slate-600")}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Workspace-Übergabe">
          <Select
            value={edge.workspace ?? ""}
            onChange={(e) => onChange({ ...edge, workspace: (e.target.value || undefined) as WorkflowEdge["workspace"] })}
            options={[{ value: "", label: "wie Zielknoten" }, { value: "continue", label: "weiterarbeiten" }, { value: "isolate", label: "isolierte Kopie" }, { value: "read-only", label: "nur lesen" }, { value: "scratch", label: "leer" }]}
          />
        </Field>
      </Section>
      <Section title="Schleife">
        <Toggle checked={Boolean(edge.loop)} onChange={(v) => onChange({ ...edge, loop: v ? { max: workflow.settings.limits.defaultLoopMax, onExceeded: Object.keys(workflow.nodes).find((n) => workflow.nodes[n]?.type === "end") ?? edge.to } : undefined })} label="Rückkante mit Limit" />
        {edge.loop && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="max. Durchläufe">
              <Input type="number" min={1} value={edge.loop.max} onChange={(e) => edge.loop && onChange({ ...edge, loop: { ...edge.loop, max: Number(e.target.value) } })} />
            </Field>
            <Field label="danach zu">
              <Select value={edge.loop.onExceeded} onChange={(e) => edge.loop && onChange({ ...edge, loop: { ...edge.loop, onExceeded: e.target.value } })} options={Object.entries(workflow.nodes).map(([nid, n]) => ({ value: nid, label: n.label ?? nid }))} />
            </Field>
          </div>
        )}
        <Toggle checked={Boolean(edge.resetLoopCounters)} onChange={(v) => onChange({ ...edge, resetLoopCounters: v || undefined })} label="Schleifenzähler des Ziels zurücksetzen" />
      </Section>
    </div>
  );
}

export function WorkflowInspector({ workflow, onChange }: { workflow: Workflow; onChange: (w: Workflow) => void }) {
  const docs = Object.entries(workflow.documents);
  const agentNodes = Object.entries(workflow.nodes).filter(([, n]) => n.type === "agent") as [string, NodeOf<"agent">][];
  const setDoc = (name: string, patch: Partial<Workflow["documents"][string]>) => onChange({ ...workflow, documents: { ...workflow.documents, [name]: { ...workflow.documents[name]!, ...patch } } });
  return (
    <div>
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="text-xs text-slate-500">Workflow-Einstellungen</div>
        <div className="font-semibold">{workflow.name}</div>
      </div>
      <Section title="Allgemein">
        <Field label="Name">
          <Input value={workflow.name} onChange={(e) => onChange({ ...workflow, name: e.target.value })} />
        </Field>
        <Field label="Command" hint={`/aiflow-wf-${workflow.command ?? workflow.id}`}>
          <Input value={workflow.command ?? ""} placeholder={workflow.id} onChange={(e) => onChange({ ...workflow, command: e.target.value || undefined })} />
        </Field>
        <Field label="Beschreibung">
          <Textarea rows={3} value={workflow.description} onChange={(e) => onChange({ ...workflow, description: e.target.value })} />
        </Field>
      </Section>
      <Section title="Variablen">
        {Object.entries(workflow.variables).map(([k, v]) => (
          <div key={k} className="flex gap-1">
            <Input className="w-28 font-mono text-xs" value={k} readOnly />
            <Input className="font-mono text-xs" value={v} onChange={(e) => onChange({ ...workflow, variables: { ...workflow.variables, [k]: e.target.value } })} />
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...workflow, variables: Object.fromEntries(Object.entries(workflow.variables).filter(([x]) => x !== k)) })}>
              <Icon name="x" size={12} />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          onClick={() => {
            const key = prompt("Name der Variable")?.trim();
            if (key) onChange({ ...workflow, variables: { ...workflow.variables, [key]: "" } });
          }}
        >
          <Icon name="plus" size={12} /> Variable
        </Button>
      </Section>
      <Section title="Dokumente & Zugriffs-Matrix">
        {docs.map(([name, spec]) => (
          <div key={name} className="space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-semibold">{name}</span>
              <button type="button" className="ml-auto text-xs text-rose-600" onClick={() => onChange({ ...workflow, documents: Object.fromEntries(docs.filter(([d]) => d !== name)) })}>
                entfernen
              </button>
            </div>
            <Input placeholder="Zweck" value={spec.description} onChange={(e) => setDoc(name, { description: e.target.value })} />
            <Input placeholder="Export ins Repo (Pfad-Template, optional)" value={spec.exportTo ?? ""} onChange={(e) => setDoc(name, { exportTo: e.target.value || undefined })} />
            <Toggle checked={spec.requiredAtEnd} onChange={(v) => setDoc(name, { requiredAtEnd: v })} label="Pflicht am Ende" />
          </div>
        ))}
        <Button
          size="sm"
          onClick={() => {
            const name = prompt("Dateiname, z. B. plan.md")?.trim();
            if (name) onChange({ ...workflow, documents: { ...workflow.documents, [name]: { description: "", format: "markdown", requiredAtEnd: false, showInReview: true } } });
          }}
        >
          <Icon name="plus" size={12} /> Dokument
        </Button>
        {docs.length > 0 && agentNodes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="mt-2 w-full text-xs">
              <thead>
                <tr>
                  <th className="py-1 text-left font-medium text-slate-500">Knoten</th>
                  {docs.map(([d]) => (
                    <th key={d} className="px-1 py-1 font-mono font-medium text-slate-500">
                      {d.replace(/\.md$/, "")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {agentNodes.map(([nid, n]) => (
                  <tr key={nid} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1 pr-2">{n.label ?? nid}</td>
                    {docs.map(([d]) => (
                      <td key={d} className="px-1 py-0.5 text-center">
                        <select
                          aria-label={`${nid} ${d}`}
                          value={n.documents[d] ?? "none"}
                          onChange={(e) => onChange({ ...workflow, nodes: { ...workflow.nodes, [nid]: { ...n, documents: { ...n.documents, [d]: e.target.value as DocumentAccess } } } })}
                          className="rounded border-0 bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800"
                        >
                          {ACCESS_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[10px] text-slate-500">– kein Zugriff · R lesen · A anhängen · W schreiben · W! muss schreiben</p>
          </div>
        )}
      </Section>
      <Section title="Workspace & Limits" defaultOpen={false}>
        <Field label="Basis" hint="working-tree (inkl. uncommitted), head oder branch:<name>">
          <Input value={workflow.settings.workspace.base} onChange={(e) => onChange({ ...workflow, settings: { ...workflow.settings, workspace: { ...workflow.settings.workspace, base: e.target.value } } })} />
        </Field>
        <Field label="Setup-Befehl (nach Worktree-Erzeugung)">
          <Input className="font-mono" value={workflow.settings.workspace.setup ?? ""} onChange={(e) => onChange({ ...workflow, settings: { ...workflow.settings, workspace: { ...workflow.settings.workspace, setup: e.target.value || undefined } } })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max. Schritte">
            <Input type="number" value={workflow.settings.limits.maxSteps} onChange={(e) => onChange({ ...workflow, settings: { ...workflow.settings, limits: { ...workflow.settings.limits, maxSteps: Number(e.target.value) } } })} />
          </Field>
          <Field label="Max. Dauer">
            <Input value={String(workflow.settings.limits.maxDuration)} onChange={(e) => onChange({ ...workflow, settings: { ...workflow.settings, limits: { ...workflow.settings.limits, maxDuration: e.target.value } } })} />
          </Field>
          <Field label="Parallele Sessions">
            <Input type="number" value={workflow.settings.limits.maxParallelSessions} onChange={(e) => onChange({ ...workflow, settings: { ...workflow.settings, limits: { ...workflow.settings.limits, maxParallelSessions: Number(e.target.value) } } })} />
          </Field>
          <Field label="Abschluss-Standard">
            <Select value={workflow.settings.finalize} onChange={(e) => onChange({ ...workflow, settings: { ...workflow.settings, finalize: e.target.value as Workflow["settings"]["finalize"] } })} options={["review", "apply", "branch", "patch", "none"].map((v) => ({ value: v, label: v }))} />
          </Field>
        </div>
      </Section>
    </div>
  );
}
