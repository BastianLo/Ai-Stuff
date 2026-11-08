import type { ProfileConfig } from "../config/schema.ts";
import type { GateView } from "./gates.ts";
import { gateStep, nextStep } from "./next-step.ts";
import { roundFindings } from "./round.ts";
import type { GateStatus, SessionState } from "./types.ts";

export const STATUS_ICON: Record<GateStatus, string> = {
  passed: "✔",
  skipped: "⏭",
  blocked: "○",
  open: "▶",
  in_review: "▶",
  changes_requested: "⨯",
  rejected: "⨯",
};

const STATUS_LABEL: Record<GateStatus, string> = {
  passed: "abgenommen",
  skipped: "übersprungen",
  blocked: "gesperrt",
  open: "offen",
  in_review: "im Review",
  changes_requested: "Änderungen verlangt",
  rejected: "abgelehnt",
};

/** Eine Zeile pro Gate, z. B. `✔ plan  p2 · 2/2 Freigaben · Runde 2`. */
export function gateLine(v: GateView): string {
  const parts: string[] = [STATUS_LABEL[v.status]];
  if (v.evidence) parts.push(`${Math.min(v.evidence.have, v.evidence.need)}/${v.evidence.need} Nachweise`);
  if (v.version) parts.push(v.version.short);
  if (v.config.approve && v.version) {
    const ev = v.evaluation;
    parts.push(`${ev?.approved ?? 0}/${ev?.required ?? v.config.approve.reviewers.length} Freigaben`);
    if (v.round) parts.push(`Runde ${v.round.index}`);
  }
  if (v.awaitingHuman) parts.push("wartet auf Nutzer");
  return `${STATUS_ICON[v.status]} ${v.name.padEnd(14)} ${parts.join(" · ")}`;
}

export interface StatusInput {
  readonly profileName: string;
  readonly profile: ProfileConfig;
  readonly views: readonly GateView[];
  readonly state: SessionState;
}

/** Kompakter Systemblock für den Orchestrator (plan.md 10.4, ~15 Zeilen). */
export function systemBlock(input: StatusInput): string {
  const { profile, views, state } = input;
  const r = profile.rules;
  const rules: string[] = [];
  if (!r.orchestrator.mayEdit) rules.push("You must not edit files yourself; delegate changes to sub-agents.");
  rules.push(`Shell is limited to: ${r.orchestrator.shell.allow.join(", ") || "nothing"}.`);
  for (const v of views) {
    if (v.config.requires.length > 0) rules.push(`Gate "${v.name}" requires ${v.config.requires.join(", ")}; its agents (${phaseList(v)}) are blocked until then.`);
    if (v.config.approve) rules.push(`Gate "${v.name}" needs reviewer approval (${v.config.approve.reviewers.join(", ")}, quorum ${String(v.config.approve.quorum)}) via figr_review – text approvals do not count.`);
  }
  if (views.some((v) => v.config.final)) rules.push(`You may only finish when gate "${views.find((v) => v.config.final)?.name ?? ""}" is satisfied.`);
  return [
    `# FiGr guardrails (profile ${input.profileName})`,
    "FiGr enforces these rules; blocked actions return a reason and the next step.",
    ...rules.map((l) => `- ${l}`),
    "",
    "## Current gate status",
    ...views.map(gateLine),
    `Sub-agents used: ${state.subagentsTotal}/${r.subagents.maxTotal}`,
    `Next step: ${nextStep(views)}`,
  ].join("\n");
}

function phaseList(v: GateView): string {
  const p = v.config.produce;
  const names = new Set(v.config.agents);
  if (p?.pattern === "multi-plan") p.planners.forEach((a) => names.add(a));
  else if (p) names.add(p.agent);
  return [...names].join(", ") || "–";
}

/** Text für figr_status bzw. `/figr` (max. ~40 Zeilen). */
export function statusText(input: StatusInput, opts: { findings?: boolean } = {}): string {
  const { profile, views, state } = input;
  const lines = [`FiGr · ${input.profileName}${state.enabled ? "" : " (aus)"}`, ...views.map(gateLine)];
  for (const v of views) {
    const step = gateStep(v);
    if (step && v.status !== "blocked") lines.push(`  ${v.name}: ${step}`);
  }
  const running = state.fanouts;
  for (const f of running) lines.push(`… ${f.kind} (${f.gate}): ${f.jobs.map((j) => `${j.label}=${j.status}`).join(", ")}`);
  if (state.lastBlock) lines.push(`Letzte Blockade: ${state.lastBlock.message.split("\n")[0] ?? ""}`);
  if (opts.findings !== false) {
    const open = views.filter((v) => v.round && (v.status === "changes_requested" || v.status === "rejected"));
    for (const v of open) {
      if (!v.round) continue;
      const findings = roundFindings(v.round).slice(0, 8);
      if (findings.length === 0) continue;
      lines.push(`Offene Befunde ${v.name} (${v.round.short}):`);
      for (const f of findings) lines.push(`  [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message} (${f.from.join(", ")})`);
    }
  }
  lines.push(`Sub-Agenten: ${state.subagentsTotal}/${profile.rules.subagents.maxTotal}`);
  lines.push(`Nächster Schritt: ${nextStep(views)}`);
  return lines.slice(0, 40).join("\n");
}

/** Einzeiler für die Prompt-Zeile der TUI, z. B. `FiGr: plan 1/2 · impl ○`. */
export function compactStatus(views: readonly GateView[]): string {
  const parts = views
    .filter((v) => v.config.approve || v.config.evidence)
    .map((v) => {
      const name = v.name.length > 6 ? v.name.slice(0, 4) : v.name;
      if (v.status === "passed" || v.status === "skipped" || v.status === "blocked" || !v.config.approve) return `${name} ${STATUS_ICON[v.status]}`;
      return `${name} ${v.evaluation?.approved ?? 0}/${v.evaluation?.required ?? v.config.approve.reviewers.length}`;
    });
  return `FiGr: ${parts.join(" · ")}`;
}
