import type { ConfigIssue } from "./load.ts";
import { gateOrder, phaseAgents } from "../core/graph.ts";
import type { FigrConfig } from "./schema.ts";

export interface AgentInfo {
  readonly id: string;
  readonly mode: "primary" | "subagent" | "all";
  readonly hidden?: boolean;
  /** Regeln aus der Agent-Datei, sofern bekannt: `{ action, resource, effect }`. */
  readonly permissions?: readonly { readonly action: string; readonly resource: string; readonly effect: string }[];
}

export interface ValidationResult {
  readonly errors: ConfigIssue[];
  readonly warnings: ConfigIssue[];
}

function canEdit(agent: AgentInfo): boolean | undefined {
  if (!agent.permissions) return undefined;
  let effect: string | undefined;
  for (const r of agent.permissions) if (r.action === "edit" || r.action === "*") if (r.resource === "*" || r.resource === "**") effect = r.effect;
  return effect === undefined ? undefined : effect !== "deny";
}

/** Querverweise gegen die Agentenliste, Zyklen, Quorum und Unabhängigkeit (plan.md 6.3). */
export function validateConfig(config: FigrConfig, agents: readonly AgentInfo[]): ValidationResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));
  const checkAgent = (path: string, id: string, mode: "subagent" | "primary"): AgentInfo | undefined => {
    const a = byId.get(id);
    if (!a) {
      errors.push({ path, message: `Agent „${id}“ existiert nicht (bekannt: ${[...byId.keys()].sort().join(", ") || "keine"})` });
      return undefined;
    }
    if (mode === "subagent" && a.mode === "primary") errors.push({ path, message: `Agent „${id}“ ist primary, erwartet wird ein Sub-Agent (mode: subagent)` });
    if (mode === "primary" && a.mode === "subagent") errors.push({ path, message: `Agent „${id}“ ist ein Sub-Agent, Orchestratoren müssen primary sein` });
    return a;
  };

  config.orchestrators.forEach((id, i) => checkAgent(`orchestrators.${i}`, id, "primary"));

  for (const [pname, profile] of Object.entries(config.profiles)) {
    const base = `profiles.${pname}`;
    const { cycle } = gateOrder(profile);
    if (cycle) errors.push({ path: `${base}.gates`, message: `Zyklus in requires: ${cycle.join(" → ")}` });
    const finals = Object.entries(profile.gates).filter(([, g]) => g.final);
    if (finals.length > 1) errors.push({ path: `${base}.gates`, message: `Höchstens ein Gate darf final sein (gefunden: ${finals.map(([n]) => n).join(", ")})` });

    for (const [gname, gate] of Object.entries(profile.gates)) {
      const g = `${base}.gates.${gname}`;
      gate.requires.forEach((r, i) => {
        if (!profile.gates[r]) errors.push({ path: `${g}.requires.${i}`, message: `Gate „${r}“ existiert nicht` });
      });
      phaseAgents(gate).forEach((a) => checkAgent(`${g}.agents`, a, "subagent"));
      if (gate.produce?.pattern === "best-of-n") checkAgent(`${g}.produce.judge`, gate.produce.judge, "subagent");
      gate.evidence?.subagents?.agents.forEach((a, i) => {
        if (!byId.has(a)) warnings.push({ path: `${g}.evidence.subagents.agents.${i}`, message: `Agent „${a}“ existiert nicht` });
      });
      if (gate.produce && !gate.artifact) errors.push({ path: `${g}.produce`, message: "produce braucht ein artifact" });
      if (gate.produce?.pattern === "best-of-n" && gate.artifact && gate.artifact.type !== "diff") errors.push({ path: `${g}.produce`, message: "best-of-n erzeugt Code und braucht artifact.type = diff" });
      if (gate.produce?.pattern === "multi-plan" && gate.artifact && gate.artifact.type !== "file") errors.push({ path: `${g}.produce`, message: "multi-plan schreibt eine Datei und braucht artifact.type = file" });
      if (gate.produce?.pattern === "single" && gate.artifact?.type === "text") errors.push({ path: `${g}.produce`, message: "single braucht artifact.type = file (Plan) oder diff (Code)" });

      const approve = gate.approve;
      if (!approve) continue;
      if (!gate.artifact) errors.push({ path: `${g}.approve`, message: "approve braucht ein artifact (file, diff oder text)" });
      if (typeof approve.quorum === "number" && approve.quorum > approve.reviewers.length) {
        errors.push({ path: `${g}.approve.quorum`, message: `Quorum ${approve.quorum} ist mit ${approve.reviewers.length} Reviewer(n) nicht erreichbar` });
      }
      const phase = new Set(phaseAgents(gate));
      approve.reviewers.forEach((r, i) => {
        const a = checkAgent(`${g}.approve.reviewers.${i}`, r, "subagent");
        if (phase.has(r)) warnings.push({ path: `${g}.approve.reviewers.${i}`, message: `„${r}“ ist Phase-Agent und Reviewer desselben Gates (nicht unabhängig)` });
        if (a && canEdit(a)) warnings.push({ path: `${g}.approve.reviewers.${i}`, message: `Reviewer „${r}“ hat Bearbeitungsrechte; setze in der Agent-Datei edit auf deny` });
      });
    }
  }
  return { errors, warnings };
}
