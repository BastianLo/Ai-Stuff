import { truncateMiddle, type AgentDefinition, type ContextInclude, type DiffStat, type Snippet } from "@aiflow/core";
import type { DelegationOffer, DocumentGrant } from "./ports.js";

export interface JournalEntry {
  label: string;
  agent?: string;
  summary: string;
  port?: string;
}

export interface PromptParts {
  workflowName: string;
  workflowDescription: string;
  stepNumber: number;
  nodeId: string;
  nodeLabel: string;
  visit: number;
  loop?: { iteration: number; max: number };
  userPrompt: string;
  task?: string;
  include: ReadonlySet<ContextInclude>;
  journal: JournalEntry[];
  inbound?: {
    fromLabel: string;
    port?: string;
    instruction?: string;
    summary?: string;
    details?: string;
    handoff?: string;
    output?: unknown;
    feedback?: string;
    subagentResults?: { agent: string; task: string; status: string; summary?: string }[];
  };
  documents: DocumentGrant[];
  workspace: { path: string; readOnly: boolean; writeScope?: string[]; diffStat?: DiffStat; diff?: string };
  candidates?: { id: string; label: string; path: string; summary?: string }[];
  branches?: { port: string; description: string }[];
}

const ACCESS_LABEL: Record<DocumentGrant["access"], string> = {
  read: "lesen",
  append: "nur ergänzen (bestehenden Inhalt nicht ändern)",
  write: "lesen und schreiben",
  "write-required": "muss in diesem Schritt geschrieben werden",
};

/** Baut den Prompt eines Agent-Schritts deterministisch (PLAN.md 7.9). */
export function buildStepPrompt(p: PromptParts): string {
  const out: string[] = [];
  const iteration = p.loop ? ` · Durchlauf ${p.loop.iteration} von max. ${p.loop.max}` : p.visit > 1 ? ` · Besuch ${p.visit}` : "";
  out.push(`# AiFlow · Workflow „${p.workflowName}“ · Schritt ${p.stepNumber} · Knoten „${p.nodeLabel}“${iteration}`);
  if (p.include.has("input.prompt")) out.push("## Auftrag des Nutzers", p.userPrompt.trim() || "(kein Auftrag)");
  if (p.workflowDescription.trim()) out.push("## Ziel des Workflows", p.workflowDescription.trim());
  if (p.task?.trim()) out.push("## Deine Aufgabe in diesem Schritt", p.task.trim());

  if (p.include.has("journal") && p.journal.length > 0) {
    const entries = p.journal.slice(-15).map((j, i) => `${i + 1}. ${j.label}${j.agent ? ` (${j.agent})` : ""}: ${oneLine(j.summary)}${j.port && j.port !== "next" ? ` → ${j.port}` : ""}`);
    out.push("## Bisheriger Ablauf", entries.join("\n"));
  }

  const ib = p.inbound;
  if (ib) {
    const lines: string[] = [];
    if (ib.instruction) lines.push(`Anweisung: ${ib.instruction}`);
    if (p.include.has("summary") && ib.summary) lines.push(ib.summary);
    if (ib.handoff) lines.push(ib.handoff);
    if (p.include.has("details") && ib.details) lines.push(`Details:\n${ib.details}`);
    if (p.include.has("output") && ib.output !== undefined) lines.push(`Strukturierte Ausgabe:\n\`\`\`json\n${truncateMiddle(JSON.stringify(ib.output, null, 2), 6000)}\n\`\`\``);
    if (p.include.has("subagents") && ib.subagentResults && ib.subagentResults.length > 0) {
      lines.push(`Ergebnisse der Sub-Agenten:\n${ib.subagentResults.map((r) => `- ${r.agent} (${r.status}): ${oneLine(r.task)} → ${oneLine(r.summary ?? "")}`).join("\n")}`);
    }
    if (lines.length > 0) out.push(`## Übergabe von „${ib.fromLabel}“${ib.port && ib.port !== "next" ? ` (Zweig: ${ib.port})` : ""}`, lines.join("\n\n"));
    if (ib.feedback && (p.include.has("feedback") || p.include.has("script.output") || p.include.has("join.feedback"))) {
      out.push("## Feedback", truncateMiddle(ib.feedback, 12000));
    }
  }

  if (p.candidates && p.candidates.length > 0 && p.include.has("candidates")) {
    out.push(
      "## Kandidaten",
      p.candidates.map((c) => `- ${c.id} (${c.label}): ${c.path}${c.summary ? ` – ${oneLine(c.summary)}` : ""}`).join("\n"),
      "Wähle in deiner Übergabe genau einen Kandidaten (`selectedCandidate`) und begründe die Wahl.",
    );
  }

  if (p.include.has("documents") && p.documents.length > 0) {
    out.push("## Dokumente", p.documents.map((d) => `- ${d.name} · ${ACCESS_LABEL[d.access]} · ${d.path}${d.description ? ` · ${d.description}` : ""}`).join("\n"));
  }

  const ws = p.workspace;
  const wsLines = [`Arbeitsverzeichnis: ${ws.path} (${ws.readOnly ? "nur lesen" : "schreibbar"})`];
  if (ws.writeScope && ws.writeScope.length > 0) wsLines.push(`Schreiben nur in: ${ws.writeScope.join(", ")}`);
  if (ws.diffStat && (p.include.has("diff.stat") || p.include.has("diff.full"))) {
    wsLines.push(`Änderungen seit Run-Start: ${ws.diffStat.files} Dateien, +${ws.diffStat.additions} / −${ws.diffStat.deletions}`);
  }
  if (ws.diff && p.include.has("diff.full")) wsLines.push(`\`\`\`diff\n${truncateMiddle(ws.diff, 20000)}\n\`\`\``);
  out.push("## Arbeitsumgebung", wsLines.join("\n"));

  if (p.branches && p.branches.length > 1) {
    out.push("## Mögliche Zweige", p.branches.map((b) => `- ${b.port}: ${b.description}`).join("\n"));
  }
  out.push(
    "## Abschluss",
    "Arbeite selbstständig, bis die Aufgabe vollständig erledigt ist. Danach wirst du um eine strukturierte Übergabe gebeten.",
  );
  return out.join("\n\n");
}

export function buildSystemPrompt(agent: AgentDefinition, snippets: ReadonlyMap<string, Snippet>, delegation?: DelegationOffer): string {
  const parts = [`Du bist „${agent.name}“. ${agent.description}`.trim()];
  if (agent.identity.trim()) parts.push(agent.identity.trim());
  for (const id of agent.snippets) {
    const s = snippets.get(id);
    if (s && s.kind === "instruction") parts.push(`### ${s.name}\n${s.content.trim()}`);
  }
  if (delegation) {
    const list = delegation.allowed.map((a) => `- ${a.id}: ${a.name} – ${a.description}`).join("\n");
    parts.push(
      [
        "### Delegation an Sub-Agenten",
        "Mit dem Tool `aiflow_delegate` startest du eine Welle von Teilaufgaben. Jede Teilaufgabe nennt einen Agenten und einen präzisen Auftrag.",
        "Der Aufruf liefert die Ergebnisse aller Teilaufgaben gesammelt zurück. Bleibt danach etwas unklar, starte eine weitere Welle.",
        delegation.mode === "enforced"
          ? "Du darfst nicht selbst recherchieren oder Dateien ändern. Delegiere die Arbeit vollständig."
          : "Kleine Aufgaben darfst du selbst erledigen; große teilst du auf.",
        `Höchstens ${delegation.maxParallel} Sub-Agenten laufen parallel, insgesamt stehen noch ${delegation.remainingRuns} Läufe zur Verfügung.`,
        `Erlaubte Agenten:\n${list}`,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

function oneLine(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 240 ? `${single.slice(0, 237)}…` : single;
}
