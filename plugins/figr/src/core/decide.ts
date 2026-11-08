import type { ProfileConfig } from "../config/schema.ts";
import { matchesAny } from "../util/pattern.ts";
import { reviewTarget, type GateView } from "./gates.ts";
import { phaseAgents } from "./graph.ts";
import { gateStep } from "./next-step.ts";
import type { ChildRole, SessionState } from "./types.ts";

export type SessionRole = { readonly kind: "orchestrator" } | { readonly kind: "child"; readonly role: ChildRole };

export type Action =
  | { readonly kind: "edit"; readonly path?: string }
  | { readonly kind: "shell"; readonly command: string }
  /** `viaFigr`: von einem FiGr-Muster gestartet (nicht direkt durch das Modell). */
  | { readonly kind: "subagent"; readonly agent: string; readonly viaFigr?: boolean };

export type Decision = { readonly allow: true } | { readonly allow: false; readonly message: string };

export interface DecideInput {
  readonly profile: ProfileConfig;
  readonly views: readonly GateView[];
  readonly state: SessionState;
}

const ALLOW: Decision = { allow: true };
const deny = (message: string): Decision => ({ allow: false, message: `FiGr: ${message}` });

/** Rollen, die nur prüfen und nie ändern. */
const READ_ONLY_ROLES: ReadonlySet<ChildRole> = new Set(["reviewer", "judge"]);

/**
 * Zerlegt einen Shell-Befehl an Operatoren. Umleitungen, Befehlsersetzung und Hintergrundprozesse
 * gelten als nicht prüfbar (`undefined`), damit `git status > datei` oder `ls $(rm …)` nicht durchrutschen.
 */
export function shellSegments(command: string): string[] | undefined {
  if (/[<>`]|\$\(|(^|[^&])&($|[^&])/.test(command)) return undefined;
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function blockedBy(view: GateView, views: readonly GateView[]): string {
  const details = view.missingRequires.map((name) => {
    const req = views.find((v) => v.name === name);
    if (!req) return `„${name}“`;
    const ev = req.evaluation;
    const count = req.config.approve ? ` (${ev?.approved ?? 0}/${ev?.required ?? req.config.approve.reviewers.length} Freigaben)` : req.evidence ? ` (${req.evidence.have}/${req.evidence.need} Nachweise)` : "";
    return `„${name}“ ist nicht erfüllt${count}`;
  });
  const first = views.find((v) => v.name === view.missingRequires[0]);
  const step = first ? gateStep(first) : undefined;
  return `${details.join(", ")}.${step ? ` Nächster Schritt: ${step}` : ""}`;
}

/** Zentrale Regelentscheidung (rein, plan.md 10.1). Gleiche Funktion für permission.evaluate und execute.before. */
export function decide(action: Action, role: SessionRole, input: DecideInput): Decision {
  const { profile, views, state } = input;
  const rules = profile.rules;
  if (!state.enabled) return ALLOW;

  switch (action.kind) {
    case "edit": {
      if (role.kind === "orchestrator" && !rules.orchestrator.mayEdit) {
        return deny("Der Orchestrator ändert keine Dateien. Delegiere die Änderung an einen Sub-Agenten (Phase-Agent des passenden Gates).");
      }
      if (role.kind === "child" && READ_ONLY_ROLES.has(role.role)) return deny("Reviewer und Richter prüfen nur und ändern keine Dateien. Gib dein Ergebnis über das FiGr-Tool ab.");
      return ALLOW;
    }
    case "shell": {
      if (role.kind !== "orchestrator") return ALLOW;
      const segments = shellSegments(action.command);
      const allow = rules.orchestrator.shell.allow;
      if (segments && segments.length > 0 && segments.every((s) => matchesAny(allow, s))) return ALLOW;
      return deny(`Shell-Befehl für den Orchestrator nicht erlaubt: \`${action.command.slice(0, 120)}\`. Erlaubt: ${allow.join(", ") || "nichts"}. Lass Änderungen, Builds und Tests von Sub-Agenten ausführen.`);
    }
    case "subagent": {
      const { agent } = action;
      if (state.subagentsTotal >= rules.subagents.maxTotal) return deny(`Sub-Agent-Budget erschöpft (${state.subagentsTotal}/${rules.subagents.maxTotal}). Frage den Nutzer, ob das Budget erhöht werden soll.`);
      if (role.kind === "orchestrator" && !action.viaFigr && rules.orchestrator.maxDirectSubagentsPerTurn !== null && state.directSubagentsThisTurn >= rules.orchestrator.maxDirectSubagentsPerTurn) {
        return deny(`Höchstens ${rules.orchestrator.maxDirectSubagentsPerTurn} direkte Sub-Agent-Aufrufe pro Nutzernachricht.`);
      }
      const phase = views.filter((v) => phaseAgents(v.config).includes(agent));
      if (phase.length > 0) {
        const usable = phase.filter((v) => v.missingRequires.length === 0 && v.status !== "skipped");
        if (usable.length === 0) {
          const first = phase[0];
          if (!first) return ALLOW;
          if (first.status === "skipped") return ALLOW;
          return deny(`„${agent}“ gehört zu Gate „${first.name}“, das ${first.config.requires.map((r) => `„${r}“`).join(", ")} voraussetzt. ${blockedBy(first, views)}`);
        }
        if (!action.viaFigr) {
          const enforced = usable.find((v) => v.config.produce?.enforce && producedBy(v).includes(agent));
          if (enforced) {
            const tool = enforced.config.produce?.pattern === "best-of-n" ? "figr_best_of_n" : "figr_plan";
            return deny(`Gate „${enforced.name}“ muss über ${tool} erzeugt werden (produce.enforce). Rufe ${tool}(task: "…") auf statt „${agent}“ direkt.`);
          }
        }
        return ALLOW;
      }
      const reviewing = views.filter((v) => v.config.approve?.reviewers.includes(agent));
      if (reviewing.length > 0 && !reviewTarget(reviewing)) {
        const first = reviewing[0];
        const why = first?.status === "blocked" && first ? blockedBy(first, views) : `Es gibt noch kein Artefakt zum Prüfen.${first ? ` Nächster Schritt: ${gateStep(first) ?? ""}` : ""}`;
        return deny(`Reviewer „${agent}“ (Gate ${reviewing.map((v) => `„${v.name}“`).join(", ")}) kann noch nicht prüfen. ${why}`);
      }
      return ALLOW;
    }
  }
}

function producedBy(view: GateView): string[] {
  const p = view.config.produce;
  if (!p) return [];
  return p.pattern === "multi-plan" ? [...p.planners, p.synthesizer] : [p.agent];
}
