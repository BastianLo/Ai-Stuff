import type { GateView } from "../core/gates.ts";
import { gateStep, nextStep } from "../core/next-step.ts";
import { escalationReason, evaluateRound, roundFindings } from "../core/round.ts";
import type { Round, SessionState, Verdict } from "../core/types.ts";
import { reviewerPrompt } from "../fanout/prompts.ts";
import { runFanout, type FanoutJob } from "../fanout/runner.ts";
import { FigrError } from "../util/errors.ts";
import type { PatternHost } from "./host.ts";

export interface ToolRun {
  readonly signal: AbortSignal;
  readonly progress: (message: string) => void;
}

const VERDICT_ICON: Record<Verdict["verdict"], string> = { approved: "✔", changes_requested: "⨯", rejected: "⛔" };

const REASON_TEXT: Record<string, string> = { maxRounds: "maximale Rundenzahl erreicht", stagnation: "gleiche Befunde wie in der Vorrunde (Stagnation)" };

/** Kompakte Rückgabe einer Runde an den Orchestrator (plan.md 11.1, Schritt 5). */
export function formatRound(view: GateView, round: Round, after: readonly GateView[]): string {
  const approve = view.config.approve;
  if (!approve) return "";
  const ev = evaluateRound(round, approve);
  const lines = [`FiGr Review „${view.name}“ ${round.short} · Runde ${round.index}: ${ev.status} (${ev.approved}/${ev.required} Freigaben)`];
  for (const r of round.reviewers) {
    const v = round.verdicts[r];
    if (v) lines.push(`- ${r}: ${VERDICT_ICON[v.verdict]} ${v.verdict} – ${v.summary}`);
    else if (round.missing.includes(r)) lines.push(`- ${r}: kein Urteil (missing)`);
    else lines.push(`- ${r}: ausstehend`);
  }
  if (round.checks && round.checks.length > 0) {
    lines.push(`Checks: ${round.checks.map((c) => `${c.command} ${c.ok ? "✔" : c.timedOut ? "⨯ Zeitlimit" : `⨯ Exit ${c.exitCode ?? "?"}`}`).join("; ")}`);
    for (const c of round.checks.filter((x) => !x.ok)) lines.push("```", `$ ${c.command}`, c.output.trim().slice(-1500), "```");
  }
  const findings = roundFindings(round).filter((f) => f.from[0] !== "check");
  if (findings.length > 0) {
    lines.push("Befunde:");
    for (const f of findings) lines.push(`- [${f.severity}] ${f.location ? `${f.location}: ` : ""}${f.message}${f.suggestion ? ` → ${f.suggestion}` : ""} (${f.from.join(", ")})`);
  }
  const updated = after.find((v) => v.name === view.name);
  const step = updated ? gateStep(updated) : undefined;
  lines.push(`Nächster Schritt: ${step ? `${view.name}: ${step}` : nextStep(after)}`);
  return lines.join("\n");
}

/** Review-Gremium: `figr_review({ gate, focus? })` (plan.md 11.1). */
export async function runReview(host: PatternHost, state: SessionState, input: { gate: string; focus?: string; task?: string }, run: ToolRun): Promise<string> {
  const profile = host.profile(state);
  let views = await host.views(state);
  const view = views.find((v) => v.name === input.gate);
  if (!view) throw new FigrError(`Unbekanntes Gate „${input.gate}“. Gates: ${views.map((v) => v.name).join(", ")}.`);
  const approve = view.config.approve;
  if (!approve) throw new FigrError(`Gate „${view.name}“ hat keine Reviewer (approve). ${gateStep(view) ?? ""}`);
  if (view.status === "blocked") throw new FigrError(`Gate „${view.name}“ ist gesperrt. ${gateStep(view) ?? ""}`);
  if (view.status === "skipped") return `Gate „${view.name}“ wurde übersprungen. Nächster Schritt: ${nextStep(views)}`;
  const version = view.version;
  if (!version) throw new FigrError(`Für Gate „${view.name}“ gibt es noch kein Artefakt. Nächster Schritt: ${gateStep(view) ?? ""}`);
  if (view.status === "passed") return `Gate „${view.name}“ ist für ${version.short} bereits abgenommen. Nächster Schritt: ${nextStep(views)}`;

  if (view.awaitingHuman) return humanStep(host, state, view);

  const existing = view.round;
  // Gleiche Version bereits entschieden: Ergebnis dieser Runde gilt (plan.md 11.1, Schritt 1).
  if (existing && isDecided(existing, approve)) return formatRound(view, existing, views);
  // Vor einer neuen Runde: Rundenlimit bzw. Stagnation → Nutzer fragen (plan.md 5.4).
  const gs = view.state;
  if (!existing) {
    const reason = escalationReason(gs.rounds, approve, profile.rules.stagnation.enabled);
    if (reason && !(gs.escalated?.version === version.hash && gs.escalated.answered)) {
      const answer = await host.escalate(state, view, REASON_TEXT[reason] ?? reason);
      if (answer) return answer.text;
    }
  }
  let round = existing;
  round ??= host.ensureRound(state, view.name, version);
  round.interrupted = false;
  host.touch(state);

  const pending = round.reviewers.filter((r) => !round.verdicts[r] && !round.missing.includes(r));
  const artifact = await host.describeArtifact(state, view);
  const jobs: FanoutJob[] = pending.map((agent) => ({
    label: agent,
    role: "reviewer",
    agent,
    title: `FiGr · Review ${view.name} ${version.short} · ${agent}`,
    prompt: reviewerPrompt({ gate: view.name, short: version.short, artifact, ...(approve.rubric ? { rubric: approve.rubric } : {}), ...(input.focus ? { focus: input.focus } : {}), ...(input.task ? { task: input.task } : {}) }),
  }));
  const budget = profile.rules.subagents.maxTotal - state.subagentsTotal;
  if (jobs.length > budget) throw new FigrError(`Sub-Agent-Budget reicht nicht (${jobs.length} Reviewer nötig, ${Math.max(0, budget)} übrig).`);

  run.progress(`Review ${view.name} ${version.short}: ${jobs.length} Reviewer${approve.checks.length > 0 ? `, ${approve.checks.length} Check(s)` : ""}`);
  const checks = host.runRoundChecks(state, view.name, round, run.signal);
  if (jobs.length > 0) {
    const fanout = host.startFanout(state, "review", view.name, jobs);
    const current = round;
    try {
      const results = await runFanout<Verdict>(
        state.sessionID,
        jobs,
        host.fanoutDeps(state, fanout, () => ({ gate: view.name, version: version.hash }), (child) => (child.done ? current.verdicts[child.agent] : undefined)),
        { maxParallel: profile.rules.subagents.maxParallel, signal: run.signal },
      );
      for (const r of results) if (r.status !== "done" && !current.verdicts[r.job.agent] && !current.missing.includes(r.job.agent)) current.missing.push(r.job.agent);
    } finally {
      host.endFanout(state, fanout);
    }
  }
  await checks;
  host.touch(state);
  if (run.signal.aborted) throw new FigrError("Review abgebrochen. Die Runde bleibt offen; figr_review erneut aufrufen.");

  views = await host.views(state);
  const after = views.find((v) => v.name === view.name) ?? view;
  if (after.awaitingHuman) return `${formatRound(view, round, views)}\n${await humanStep(host, state, after)}`;
  const status = evaluateRound(round, approve).status;
  let text = formatRound(view, round, views);
  if (status === "changes_requested" || status === "rejected") {
    const reason = escalationReason(after.state.rounds, approve, profile.rules.stagnation.enabled);
    if (reason) {
      const answer = await host.escalate(state, after, REASON_TEXT[reason] ?? reason);
      if (answer) text += `\n\n${answer.text}`;
    }
  }
  return text;
}

function isDecided(round: Round, approve: NonNullable<GateView["config"]["approve"]>): boolean {
  return evaluateRound(round, approve).status !== "in_review";
}

async function humanStep(host: PatternHost, state: SessionState, view: GateView): Promise<string> {
  const version = view.version;
  if (!version) return "";
  const answer = await host.humanApproval(state, view);
  if (answer.approved) {
    view.state.humanApproved = version.hash;
    host.touch(state);
    const views = await host.views(state);
    return `Nutzer hat Gate „${view.name}“ (${version.short}) freigegeben. Nächster Schritt: ${nextStep(views)}`;
  }
  return answer.feedback
    ? `Nutzer hat Gate „${view.name}“ nicht freigegeben. Anweisung des Nutzers: ${answer.feedback}`
    : `Nutzer hat Gate „${view.name}“ nicht freigegeben. Frage nach, was fehlt, oder überarbeite das Artefakt.`;
}
