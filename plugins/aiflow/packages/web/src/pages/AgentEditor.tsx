import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { agentSchema, KNOWN_ACTIONS, presetRules, type AgentDefinition, type PermissionRule } from "@aiflow/core";
import { api, useProject } from "../lib/api";
import { snippetList, useAgents, useRuntime, useSnippets } from "../lib/queries";
import { TEMPLATES } from "../lib/templates";
import { Icon } from "../components/Icon";
import { AgentAvatar, Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Tabs, Textarea, Toggle } from "../components/ui";

type Tab = "identity" | "model" | "permissions" | "mcp" | "output" | "behavior" | "test";

function blank(templateId?: string): AgentDefinition {
  const t = TEMPLATES.find((x) => x.id === templateId);
  return agentSchema.parse({ id: t?.id ?? "", name: t?.name ?? "", description: t?.description ?? "", ...(t ?? {}) });
}

export function AgentEditor() {
  const { id = "neu" } = useParams();
  const [params] = useSearchParams();
  const [project] = useProject();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isNew = id === "neu";
  const entry = useQuery({ queryKey: ["definition", "agents", id, project], queryFn: () => api.getDefinition<AgentDefinition>("agents", id, project), enabled: !isNew });
  const [agent, setAgent] = useState<AgentDefinition | undefined>(isNew ? blank(params.get("template") ?? undefined) : undefined);
  const [tab, setTab] = useState<Tab>("identity");
  const [scope, setScope] = useState<"global" | "project">("global");
  const snippets = snippetList(useSnippets(project).data);
  const agents = useAgents(project);
  const runtime = useRuntime();

  useEffect(() => {
    if (entry.data?.definition) {
      setAgent(entry.data.definition);
      setScope(entry.data.scope);
    }
  }, [entry.data]);

  const save = useMutation({
    mutationFn: (a: AgentDefinition) => api.saveDefinition("agents", a.id, a, scope, project),
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ["definitions"] });
      if (isNew) navigate(`/agents/${saved.id}${project ? `?project=${encodeURIComponent(project)}` : ""}`, { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteDefinition("agents", id, scope, project),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["definitions"] });
      navigate("/agents");
    },
  });

  const systemPreview = useMemo(() => {
    if (!agent) return "";
    const parts = [`Du bist „${agent.name}“. ${agent.description}`, agent.identity];
    for (const s of agent.snippets) {
      const snip = snippets.find((x) => x.id === s);
      if (snip) parts.push(`### ${snip.name}\n${snip.content}`);
    }
    return parts.filter(Boolean).join("\n\n");
  }, [agent, snippets]);

  if (!agent) return <div className="text-sm text-slate-500">Lädt…</div>;
  const update = (patch: Partial<AgentDefinition>) => setAgent({ ...agent, ...patch });
  const rules = agent.permissions.rules;
  const setRules = (r: PermissionRule[]) => update({ permissions: { ...agent.permissions, rules: r } });
  const otherAgents = (agents.data ?? []).filter((a) => a.id !== agent.id && a.definition && !a.shadowed);
  const sub = agent.subagents;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <AgentAvatar name={agent.name || "?"} color={agent.appearance.color} size={34} /> {agent.name || "Neuer Agent"}
          </span>
        }
        subtitle={isNew ? "Agenten sind wiederverwendbar. Im Workflow lassen sich Modell, Anweisungen und Rechte pro Knoten überschreiben." : `${scope === "project" ? "Projekt" : "Global"} · ${entry.data?.file ?? ""}`}
        actions={
          <>
            <Select value={scope} onChange={(e) => setScope(e.target.value as "global" | "project")} className="w-44" options={[{ value: "global", label: "Global" }, ...(project ? [{ value: "project", label: "Projekt (.aiflow/)" }] : [])]} />
            {!isNew && (
              <Button variant="ghost" onClick={() => confirm(`Agent „${agent.name}“ löschen?`) && remove.mutate()}>
                <Icon name="trash" /> Löschen
              </Button>
            )}
            <Button variant="primary" onClick={() => save.mutate(agent)} disabled={!agent.id || !agent.name || save.isPending}>
              <Icon name="save" /> Speichern
            </Button>
          </>
        }
      />
      <ErrorBox error={save.error ?? remove.error} />
      {save.isSuccess && <div className="mb-3 text-sm text-emerald-600">Gespeichert (Version {save.data.version}).</div>}
      <Card>
        <div className="px-4 pt-2">
          <Tabs<Tab>
            active={tab}
            onChange={setTab}
            tabs={[
              { id: "identity", label: "Identität" },
              { id: "model", label: "Modell" },
              { id: "permissions", label: "Werkzeuge & Rechte" },
              { id: "mcp", label: "MCP & Skills" },
              { id: "output", label: "Ausgabe" },
              { id: "behavior", label: "Verhalten" },
              { id: "test", label: "Testen" },
            ]}
          />
        </div>
        <div className="space-y-4 p-4">
          {tab === "identity" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="ID" hint="Kleinbuchstaben, Ziffern, Bindestriche">
                    <Input value={agent.id} disabled={!isNew} onChange={(e) => update({ id: e.target.value })} />
                  </Field>
                  <Field label="Name">
                    <Input value={agent.name} onChange={(e) => update({ name: e.target.value })} />
                  </Field>
                </div>
                <Field label="Beschreibung" hint="Erscheint in der Palette und wird anderen Agenten gezeigt (z. B. bei Delegation).">
                  <Input value={agent.description} onChange={(e) => update({ description: e.target.value })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Tags (Komma)">
                    <Input value={agent.tags.join(", ")} onChange={(e) => update({ tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) })} />
                  </Field>
                  <Field label="Farbe">
                    <Input type="color" value={agent.appearance.color} onChange={(e) => update({ appearance: { ...agent.appearance, color: e.target.value } })} className="h-9" />
                  </Field>
                </div>
                <Field label="Identität (System-Prompt, Markdown)" hint="Rolle, Haltung, Arbeitsweise, Qualitätsmaßstäbe, Verbote.">
                  <Textarea rows={10} value={agent.identity} onChange={(e) => update({ identity: e.target.value })} />
                </Field>
                <Field label="Bausteine">
                  <div className="flex flex-wrap gap-2">
                    {snippets
                      .filter((s) => s.kind === "instruction")
                      .map((s) => (
                        <label key={s.id} className="flex items-center gap-1.5 text-sm">
                          <input type="checkbox" checked={agent.snippets.includes(s.id)} onChange={(e) => update({ snippets: e.target.checked ? [...agent.snippets, s.id] : agent.snippets.filter((x) => x !== s.id) })} />
                          {s.name}
                        </label>
                      ))}
                  </div>
                </Field>
                <Toggle checked={agent.includeProjectInstructions} onChange={(v) => update({ includeProjectInstructions: v })} label="AGENTS.md und Projektregeln einbeziehen" />
              </div>
              <Field label="Vorschau: zusammengesetzter System-Prompt">
                <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">{systemPreview}</pre>
              </Field>
            </div>
          )}

          {tab === "model" && (
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <Field label="Modell" hint="Leer = Standardmodell des Workflows bzw. von opencode.">
                <Select
                  value={agent.model?.ref ?? ""}
                  onChange={(e) => update({ model: e.target.value ? { ...(agent.model ?? {}), ref: e.target.value } : undefined })}
                  options={[{ value: "", label: "Standard" }, ...(runtime.data?.models ?? []).map((m) => ({ value: `${m.providerID}/${m.modelID}`, label: `${m.name} (${m.providerID})` })), ...(agent.model && !(runtime.data?.models ?? []).some((m) => `${m.providerID}/${m.modelID}` === agent.model?.ref) ? [{ value: agent.model.ref, label: agent.model.ref }] : [])]}
                />
              </Field>
              <Field label="Variante / Reasoning" hint="z. B. high">
                <Input value={agent.model?.variant ?? ""} disabled={!agent.model} onChange={(e) => agent.model && update({ model: { ...agent.model, variant: e.target.value || undefined } })} />
              </Field>
              <Field label="Temperatur" hint="DeepSeek wendet temperature nur bei ausgeschaltetem Thinking an.">
                <Input type="number" step="0.1" min="0" max="2" value={agent.model?.temperature ?? ""} disabled={!agent.model} onChange={(e) => agent.model && update({ model: { ...agent.model, temperature: e.target.value === "" ? undefined : Number(e.target.value) } })} />
              </Field>
              <Field label="top_p">
                <Input type="number" step="0.05" min="0" max="1" value={agent.model?.topP ?? ""} disabled={!agent.model} onChange={(e) => agent.model && update({ model: { ...agent.model, topP: e.target.value === "" ? undefined : Number(e.target.value) } })} />
              </Field>
              <Field label="Max. Schritte (Tool-Iterationen)">
                <Input type="number" value={agent.limits.maxSteps ?? ""} onChange={(e) => update({ limits: { ...agent.limits, maxSteps: e.target.value ? Number(e.target.value) : undefined } })} />
              </Field>
              <Field label="Timeout pro Schritt">
                <Input value={String(agent.limits.timeout)} onChange={(e) => update({ limits: { ...agent.limits, timeout: e.target.value } })} />
              </Field>
            </div>
          )}

          {tab === "permissions" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Preset">
                  <Select
                    value={agent.permissions.preset}
                    onChange={(e) => update({ permissions: { ...agent.permissions, preset: e.target.value as AgentDefinition["permissions"]["preset"] } })}
                    options={[{ value: "read-only", label: "Nur lesen (Standard)" }, { value: "implement", label: "Implementieren" }, { value: "full", label: "Voll" }]}
                    className="w-56"
                  />
                </Field>
                <Toggle checked={agent.permissions.questions} onChange={(v) => update({ permissions: { ...agent.permissions, questions: v } })} label="Rückfragen an den Nutzer erlaubt" />
              </div>
              <div className="text-xs text-slate-500">
                Regeln werden in Reihenfolge ausgewertet, die letzte passende Regel gewinnt. Preset-Regeln: {presetRules(agent.permissions.preset).length}. Zusätzliche Regeln:
              </div>
              <table className="w-full max-w-3xl text-sm">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="py-1 font-medium">Aktion</th>
                    <th className="py-1 font-medium">Ressource (Muster)</th>
                    <th className="py-1 font-medium">Effekt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={i}>
                      <td className="py-1 pr-2">
                        <Select value={r.action} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)))} options={KNOWN_ACTIONS.map((a) => ({ value: a, label: a }))} />
                      </td>
                      <td className="py-1 pr-2">
                        <Input value={r.resource} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, resource: e.target.value } : x)))} />
                      </td>
                      <td className="py-1 pr-2">
                        <Select value={r.effect} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, effect: e.target.value as PermissionRule["effect"] } : x)))} options={["allow", "ask", "deny"].map((v) => ({ value: v, label: v }))} />
                      </td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
                          <Icon name="x" size={12} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button size="sm" onClick={() => setRules([...rules, { action: "shell", resource: "*", effect: "deny" }])}>
                <Icon name="plus" size={12} /> Regel
              </Button>
              {agent.permissions.preset !== "read-only" && rules.every((r) => r.action !== "shell" || r.effect !== "deny") && (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">Hinweis: Shell ist erlaubt. Prüfe, ob eine Denylist (z. B. für Deployments) nötig ist.</div>
              )}
            </div>
          )}

          {tab === "mcp" && (
            <div className="max-w-2xl space-y-3">
              <p className="text-sm text-slate-600 dark:text-slate-400">MCP-Server aus der opencode-Konfiguration. Ohne Auswahl sind alle erlaubt, die nicht abgewählt sind.</p>
              {(runtime.data?.mcp ?? []).length === 0 && <div className="text-sm text-slate-500">Keine MCP-Server gefunden (Runtime: {runtime.data?.id}).</div>}
              {runtime.data?.mcp.map((m) => (
                <div key={m.name} className="flex items-center gap-3 text-sm">
                  <Badge color={m.status === "connected" ? "green" : "amber"}>{m.status}</Badge>
                  <span className="flex-1 font-medium">{m.name}</span>
                  <Select
                    value={agent.mcp.allow.includes(m.name) ? "allow" : agent.mcp.deny.includes(m.name) ? "deny" : "default"}
                    onChange={(e) => {
                      const allow = agent.mcp.allow.filter((x) => x !== m.name);
                      const deny = agent.mcp.deny.filter((x) => x !== m.name);
                      if (e.target.value === "allow") allow.push(m.name);
                      if (e.target.value === "deny") deny.push(m.name);
                      update({ mcp: { allow, deny } });
                    }}
                    options={[{ value: "default", label: "Standard" }, { value: "allow", label: "erlauben" }, { value: "deny", label: "verbieten" }]}
                    className="w-36"
                  />
                </div>
              ))}
            </div>
          )}

          {tab === "output" && <OutputTab agent={agent} update={update} />}

          {tab === "behavior" && (
            <div className="space-y-5">
              <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
                <Field label="Kontext-Modus">
                  <Select value={agent.contextMode} onChange={(e) => update({ contextMode: e.target.value as AgentDefinition["contextMode"] })} options={[{ value: "fresh", label: "frisch (Standard)" }, { value: "resume", label: "fortsetzen" }, { value: "fork", label: "fork vom Vorgänger" }]} />
                </Field>
                <Field label="Retries">
                  <Input type="number" min={0} max={5} value={agent.limits.retries} onChange={(e) => update({ limits: { ...agent.limits, retries: Number(e.target.value) } })} />
                </Field>
                <Field label="Entscheidungs-Stimmen" hint="Mehrheit aus n Stimmen">
                  <Input type="number" min={1} max={9} value={agent.decision.votes} onChange={(e) => update({ decision: { votes: Number(e.target.value) } })} />
                </Field>
              </div>
              <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                <Toggle
                  checked={sub?.enabled ?? false}
                  onChange={(v) => update({ subagents: { ...(sub ?? { allowed: [], mode: "optional", maxParallel: 4, maxRuns: 12, depth: 0, workspace: "read-only", documents: "read", context: ["input.prompt", "documents"], timeoutPerAgent: "20m", keepTools: [] }), enabled: v } })}
                  label={<span className="font-medium">Sub-Agenten (Standard für Knoten mit diesem Agenten)</span>}
                />
                {sub?.enabled && (
                  <div className="mt-4 space-y-3">
                    <Field label="Erlaubte Agenten">
                      <div className="flex flex-wrap gap-2">
                        {otherAgents.map((a) => (
                          <label key={a.id} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-sm dark:border-slate-700">
                            <input type="checkbox" checked={sub.allowed.includes(a.id)} onChange={(e) => update({ subagents: { ...sub, allowed: e.target.checked ? [...sub.allowed, a.id] : sub.allowed.filter((x) => x !== a.id) } })} />
                            {a.definition?.name}
                          </label>
                        ))}
                        <label className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-sm dark:border-slate-700">
                          <input type="checkbox" checked={sub.allowed.includes(agent.id)} onChange={(e) => update({ subagents: { ...sub, allowed: e.target.checked ? [...sub.allowed, agent.id] : sub.allowed.filter((x) => x !== agent.id) } })} />
                          sich selbst
                        </label>
                      </div>
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-4">
                      <Field label="Delegationsmodus">
                        <Select value={sub.mode} onChange={(e) => update({ subagents: { ...sub, mode: e.target.value as "optional" | "enforced" } })} options={[{ value: "optional", label: "optional" }, { value: "enforced", label: "erzwungen" }]} />
                      </Field>
                      <Field label="Max. parallel">
                        <Input type="number" min={1} value={sub.maxParallel} onChange={(e) => update({ subagents: { ...sub, maxParallel: Number(e.target.value) } })} />
                      </Field>
                      <Field label="Max. Runs (Budget)">
                        <Input type="number" min={1} value={sub.maxRuns} onChange={(e) => update({ subagents: { ...sub, maxRuns: Number(e.target.value) } })} />
                      </Field>
                      <Field label="Max. Wellen">
                        <Input type="number" min={1} value={sub.maxWaves ?? ""} onChange={(e) => update({ subagents: { ...sub, maxWaves: e.target.value ? Number(e.target.value) : undefined } })} />
                      </Field>
                      <Field label="Verschachtelungstiefe">
                        <Input type="number" min={0} max={3} value={sub.depth} onChange={(e) => update({ subagents: { ...sub, depth: Number(e.target.value) } })} />
                      </Field>
                      <Field label="Workspace">
                        <Select value={sub.workspace} onChange={(e) => update({ subagents: { ...sub, workspace: e.target.value as "read-only" | "isolate" } })} options={[{ value: "read-only", label: "nur lesen (geteilt)" }, { value: "isolate", label: "isoliert + Merge" }]} />
                      </Field>
                      <Field label="Dokumente">
                        <Select value={sub.documents} onChange={(e) => update({ subagents: { ...sub, documents: e.target.value as "none" | "read" } })} options={[{ value: "read", label: "lesen" }, { value: "none", label: "kein Zugriff" }]} />
                      </Field>
                      <Field label="Timeout je Sub-Agent">
                        <Input value={String(sub.timeoutPerAgent)} onChange={(e) => update({ subagents: { ...sub, timeoutPerAgent: e.target.value } })} />
                      </Field>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "test" && <PlaygroundTab agentId={agent.id} disabled={isNew} />}
        </div>
      </Card>
    </div>
  );
}

function OutputTab({ agent, update }: { agent: AgentDefinition; update: (p: Partial<AgentDefinition>) => void }) {
  const [text, setText] = useState(agent.output.type === "json" ? JSON.stringify(agent.output.schema, null, 2) : "");
  const [error, setError] = useState<string>();
  return (
    <div className="max-w-3xl space-y-3">
      <Select
        value={agent.output.type}
        onChange={(e) => update({ output: e.target.value === "json" ? { type: "json", schema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } } } : { type: "text" } })}
        options={[{ value: "text", label: "Freitext" }, { value: "json", label: "JSON-Schema (auswertbar für Bedingungen und Abstimmungen)" }]}
        className="w-96"
      />
      {agent.output.type === "json" && (
        <>
          <Textarea
            rows={16}
            mono
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              try {
                const schema = JSON.parse(e.target.value) as Record<string, unknown>;
                setError(undefined);
                update({ output: { type: "json", schema } });
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
          {error && <div className="text-xs text-rose-600">JSON ungültig: {error}</div>}
          <p className="text-xs text-slate-500">Beispiel Reviewer: approved (boolean) und findings[] mit severity, file, line, message.</p>
        </>
      )}
    </div>
  );
}

function PlaygroundTab({ agentId, disabled }: { agentId: string; disabled: boolean }) {
  const [project] = useProject();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const run = useMutation({ mutationFn: () => api.playground(agentId, { project: project ?? "", prompt }), onSuccess: ({ runId }) => navigate(`/runs/${runId}${project ? `?project=${encodeURIComponent(project)}` : ""}`) });
  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-sm text-slate-600 dark:text-slate-400">Den Agenten ohne Workflow ausprobieren. Er arbeitet in einem isolierten Workspace; das Ergebnis erscheint als Review.</p>
      <Textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Test-Auftrag" />
      <Button variant="primary" disabled={disabled || !project || !prompt.trim() || run.isPending} onClick={() => run.mutate()}>
        <Icon name="beaker" /> Im Playground starten
      </Button>
      {!project && <div className="text-xs text-amber-600">Bitte oben ein Projekt wählen.</div>}
      <ErrorBox error={run.error} />
    </div>
  );
}
