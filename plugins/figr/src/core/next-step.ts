import type { ProfileConfig } from "../config/schema.ts";
import { isComplete, isDone, type GateView } from "./gates.ts";
import { phaseAgents } from "./graph.ts";

/** Empfohlener Erzeuger-Aufruf für ein offenes Gate. */
function produceStep(view: GateView): string {
  const { config, name } = view;
  const p = config.produce;
  if (p?.pattern === "multi-plan" || (p?.pattern === "single" && config.artifact?.type === "file")) return `figr_plan(task: "…")`;
  if (p?.pattern === "single") return `subagent(agent: "${p.agent}", …)`;
  if (p?.pattern === "best-of-n") return `figr_best_of_n(task: "…")`;
  if (config.artifact?.type === "text") return `figr_submit(gate: "${name}", text: "…")`;
  const agent = phaseAgents(config)[0];
  if (config.artifact?.type === "file") return agent ? `subagent(agent: "${agent}") – schreibt ${config.artifact.path}` : `die Datei ${config.artifact.path} anlegen lassen`;
  return agent ? `subagent(agent: "${agent}", …)` : `das Artefakt für „${name}“ erzeugen`;
}

/** Nächster Schritt für genau ein Gate. */
export function gateStep(view: GateView): string | undefined {
  const { name, status, config } = view;
  switch (status) {
    case "passed":
    case "skipped":
      return undefined;
    case "blocked":
      return `Zuerst ${view.missingRequires.join(", ")} erfüllen.`;
    case "open": {
      if (view.evidence && !config.approve) {
        const sub = config.evidence?.subagents;
        const left = Math.max(0, view.evidence.need - view.evidence.have);
        if (sub && left > 0) return `Noch ${left} Lauf/Läufe mit subagent(agent: ${sub.agents.map((a) => `"${a}"`).join(" | ")}).`;
        if (config.evidence?.file) return `Datei ${config.evidence.file.path} anlegen lassen.`;
        if (config.evidence?.check) return `Check „${config.evidence.check}“ grün bekommen.`;
      }
      return produceStep(view);
    }
    case "in_review": {
      if (view.awaitingHuman) return `Wartet auf Freigabe durch den Nutzer: figr_review(gate: "${name}") erneut aufrufen.`;
      const pending = view.evaluation?.pending ?? config.approve?.reviewers ?? [];
      if (view.round?.interrupted) return `Review-Runde unterbrochen: figr_review(gate: "${name}") erneut aufrufen.`;
      if (view.round && pending.length > 0) return `figr_review(gate: "${name}") – offen: ${pending.join(", ")}.`;
      return `figr_review(gate: "${name}").`;
    }
    case "changes_requested":
    case "rejected": {
      const agent = phaseAgents(config)[0];
      const how = config.artifact?.type === "text" ? `figr_submit(gate: "${name}", …)` : agent ? `über ${agent}` : "das Artefakt";
      return `Befunde einarbeiten (${how}), dann figr_review(gate: "${name}").`;
    }
  }
}

/** Nächster empfohlener Schritt für die ganze Session. */
export function nextStep(views: readonly GateView[]): string {
  if (isComplete(views)) return "Alle nötigen Gates sind erfüllt – du kannst abschließen.";
  for (const v of views) {
    if (isDone(v.status) || v.status === "blocked") continue;
    const step = gateStep(v);
    if (step) return `${v.name}: ${step}`;
  }
  const blocked = views.find((v) => v.status === "blocked");
  return blocked ? `${blocked.name}: ${gateStep(blocked) ?? ""}` : "figr_status aufrufen.";
}

/** Offene Gates (nicht erfüllt), die das Ende verhindern. */
export function openGates(profile: ProfileConfig, views: readonly GateView[]): GateView[] {
  const finals = views.filter((v) => v.config.final);
  if (finals.length === 0) return views.filter((v) => !isDone(v.status));
  const needed = new Set<string>();
  const add = (name: string): void => {
    if (needed.has(name)) return;
    needed.add(name);
    for (const r of profile.gates[name]?.requires ?? []) add(r);
  };
  for (const f of finals) add(f.name);
  return views.filter((v) => needed.has(v.name) && !isDone(v.status));
}
