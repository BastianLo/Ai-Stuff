import type { GateView } from "../core/gates.ts";
import { nextStep } from "../core/next-step.ts";
import { evaluateRound, roundFindings } from "../core/round.ts";
import { gateLine } from "../core/status.ts";
import type { SessionState } from "../core/types.ts";

/** `report.md`: Gates, Runden, Befunde, Overrides (plan.md 13). */
export function renderReport(input: { profileName: string; views: readonly GateView[]; state: SessionState }): string {
  const { views, state } = input;
  const out = [`# FiGr-Bericht · Session ${state.sessionID}`, "", `Profil: ${input.profileName} · Basis: ${state.baseCommit ?? "–"} · Sub-Agenten: ${state.subagentsTotal}`, "", "## Gates", "", "```", ...views.map(gateLine), "```", ""];
  for (const v of views) {
    if (v.state.rounds.length === 0) continue;
    out.push(`## ${v.name}`, "");
    for (const r of v.state.rounds) {
      const ev = v.config.approve ? evaluateRound(r, v.config.approve) : undefined;
      out.push(`### Runde ${r.index} · ${r.short}${ev ? ` · ${ev.status} (${ev.approved}/${ev.required})` : ""}`, "");
      for (const reviewer of r.reviewers) {
        const verdict = r.verdicts[reviewer];
        out.push(verdict ? `- **${reviewer}**: ${verdict.verdict} – ${verdict.summary}` : `- **${reviewer}**: ${r.missing.includes(reviewer) ? "kein Urteil" : "ausstehend"}`);
      }
      for (const c of r.checks ?? []) out.push(`- Check \`${c.command}\`: ${c.ok ? "grün" : "rot"}`);
      const findings = roundFindings(r);
      if (findings.length > 0) out.push("", ...findings.map((f) => `  - [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message} (${f.from.join(", ")})`));
      out.push("");
    }
  }
  if (state.overrides.length > 0) {
    out.push("## Overrides", "", ...state.overrides.map((o) => `- ${new Date(o.at).toISOString()} ${o.kind} ${o.gate} (${o.by})${o.note ? ` – ${o.note}` : ""}`), "");
  }
  out.push(`Nächster Schritt: ${nextStep(views)}`, "");
  return out.join("\n");
}
