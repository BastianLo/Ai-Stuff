import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactPath } from "../artifacts/version.ts";
import { gateStep, nextStep } from "../core/next-step.ts";
import { PlannerReportSchema, SynthesizerReportSchema, type PlannerReport, type SynthesizerReport } from "../core/reports.ts";
import type { SessionState } from "../core/types.ts";
import { plannerPrompt, synthesizerPrompt } from "../fanout/prompts.ts";
import { runFanout, type FanoutJob } from "../fanout/runner.ts";
import { FigrError } from "../util/errors.ts";
import type { PatternHost } from "./host.ts";
import type { ToolRun } from "./review.ts";

/** Gate, das per Plan-Muster erzeugt wird: das erste mit produce multi-plan/single. */
function planGate(host: PatternHost, state: SessionState, gate?: string): string {
  const gates = host.profile(state).gates;
  if (gate) {
    if (!gates[gate]) throw new FigrError(`Unbekanntes Gate „${gate}“.`);
    return gate;
  }
  const found = Object.entries(gates).find(([, g]) => g.artifact?.type === "file" && (g.produce?.pattern === "multi-plan" || g.produce?.pattern === "single"));
  if (!found) throw new FigrError("Kein Gate mit produce.pattern multi-plan oder single konfiguriert.");
  return found[0];
}

/** Multi-Plan bzw. Single: `figr_plan({ task, planners?, context? })` (plan.md 11.2). */
export async function runPlan(host: PatternHost, state: SessionState, input: { task: string; planners?: string[]; context?: string; gate?: string }, run: ToolRun): Promise<string> {
  const profile = host.profile(state);
  const gateName = planGate(host, state, input.gate);
  const views = await host.views(state);
  const view = views.find((v) => v.name === gateName);
  const gate = profile.gates[gateName];
  if (!view || !gate) throw new FigrError(`Unbekanntes Gate „${gateName}“.`);
  if (view.status === "blocked") throw new FigrError(`Gate „${gateName}“ ist gesperrt. ${gateStep(view) ?? ""}`);
  const artifact = gate.artifact;
  const produce = gate.produce;
  if (artifact?.type !== "file" || (produce?.pattern !== "multi-plan" && produce?.pattern !== "single")) throw new FigrError(`Gate „${gateName}“ wird nicht über figr_plan erzeugt.`);

  const loc = host.location(state);
  const target = artifactPath(artifact, loc);
  const plansDir = join(loc.sessionDir, "plans");
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });

  if (produce.pattern === "single") {
    const agent = input.planners?.[0] ?? produce.agent;
    const jobs: FanoutJob[] = [{ label: agent, role: "planner", agent, title: `FiGr · Plan · ${agent}`, prompt: plannerPrompt({ task: input.task, planPath: target, ...(input.context ? { context: input.context } : {}) }) }];
    const [result] = await planners(host, state, gateName, jobs, run);
    if (!result?.report || !existsSync(target)) throw new FigrError(`Planer „${agent}“ hat keinen Plan geliefert (${result?.status ?? "missing"}). Erneut versuchen oder anderen Planer wählen.`);
    host.bumpDiff();
    const after = await host.views(state);
    const v = after.find((x) => x.name === gateName);
    return [`FiGr Plan (${agent}) → ${target}${v?.version ? ` · Version ${v.version.short}` : ""}`, `Zusammenfassung: ${result.report.summary}`, ...list("Risiken", result.report.risks), ...list("Offene Fragen", result.report.openQuestions), `Nächster Schritt: ${nextStep(after)}`].join("\n");
  }

  const names = input.planners && input.planners.length > 0 ? input.planners : produce.planners;
  const unknown = names.filter((n) => !produce.planners.includes(n) && !gate.agents.includes(n));
  if (unknown.length > 0) throw new FigrError(`Nicht konfigurierte Planer: ${unknown.join(", ")}. Erlaubt: ${produce.planners.join(", ")}.`);
  const jobs: FanoutJob[] = names.map((agent) => ({
    label: agent,
    role: "planner",
    agent,
    title: `FiGr · Plan · ${agent}`,
    prompt: plannerPrompt({ task: input.task, planPath: join(plansDir, `${agent}.md`), ...(input.context ? { context: input.context } : {}) }),
  }));
  const results = await planners(host, state, gateName, jobs, run);
  const plans = results.filter((r) => r.report && existsSync(join(plansDir, `${r.job.agent}.md`))).map((r) => ({ agent: r.job.agent, path: join(plansDir, `${r.job.agent}.md`), summary: r.report?.summary ?? "" }));
  if (plans.length === 0) throw new FigrError(`Kein Planer hat einen Plan geliefert (${results.map((r) => `${r.job.agent}: ${r.status}`).join(", ")}).`);

  run.progress(`Synthese von ${plans.length} Plänen durch ${produce.synthesizer}`);
  const synthJob: FanoutJob = { label: produce.synthesizer, role: "synthesizer", agent: produce.synthesizer, title: `FiGr · Plan-Synthese · ${produce.synthesizer}`, prompt: synthesizerPrompt({ task: input.task, plans, planPath: target }) };
  const fanout = host.startFanout(state, "plan", gateName, [synthJob]);
  let synth: SynthesizerReport | undefined;
  try {
    const [r] = await runFanout<SynthesizerReport>(state.sessionID, [synthJob], host.fanoutDeps(state, fanout, () => ({}), (c) => parse(SynthesizerReportSchema, c.report)), { maxParallel: 1, signal: run.signal });
    synth = r?.result;
  } finally {
    host.endFanout(state, fanout);
  }
  if (!synth || !existsSync(target)) throw new FigrError(`Synthesizer „${produce.synthesizer}“ hat keinen zusammengeführten Plan geliefert. Einzelpläne liegen unter ${plansDir}.`);

  let conflictNote = "";
  if (synth.conflicts.length > 0 && produce.askOnConflict) {
    const answer = await host.ask(state, `FiGr: Konflikte im Plan „${gateName}“`, `Die Planer widersprechen sich:\n${synth.conflicts.map((c) => `- ${c}`).join("\n")}\n\nPlan so übernehmen? (Ablehnen mit Text = deine Entscheidung geht an den Orchestrator.)`);
    conflictNote = answer.approved ? "Nutzer hat den Plan trotz Konflikten bestätigt." : answer.feedback ? `Entscheidung des Nutzers zu den Konflikten (in den Plan einarbeiten): ${answer.feedback}` : "Nutzer hat den Plan wegen der Konflikte nicht bestätigt – nachfragen.";
  }
  host.bumpDiff();
  const after = await host.views(state);
  const v = after.find((x) => x.name === gateName);
  return [
    `FiGr Multi-Plan: ${plans.length}/${jobs.length} Pläne → Synthese ${target}${v?.version ? ` · Version ${v.version.short}` : ""}`,
    ...plans.map((p) => `- ${p.agent}: ${p.summary}`),
    ...list("Entscheidungen", synth.decisions.map((d) => `${d.topic}: ${d.chosen}${d.from.length ? ` (von ${d.from.join(", ")})` : ""} – ${d.reason}`)),
    ...list("Konflikte", synth.conflicts),
    ...(conflictNote ? [conflictNote] : []),
    `Nächster Schritt: ${nextStep(after)}`,
  ].join("\n");
}

async function planners(host: PatternHost, state: SessionState, gate: string, jobs: FanoutJob[], run: ToolRun) {
  const profile = host.profile(state);
  const budget = profile.rules.subagents.maxTotal - state.subagentsTotal;
  if (jobs.length + 1 > budget) throw new FigrError(`Sub-Agent-Budget reicht nicht (${jobs.length + 1} nötig, ${Math.max(0, budget)} übrig).`);
  run.progress(`Planung: ${jobs.map((j) => j.agent).join(", ")}`);
  const fanout = host.startFanout(state, "plan", gate, jobs);
  try {
    const results = await runFanout<PlannerReport>(state.sessionID, jobs, host.fanoutDeps(state, fanout, () => ({}), (c) => parse(PlannerReportSchema, c.report)), { maxParallel: profile.rules.subagents.maxParallel, signal: run.signal });
    return results.map((r) => ({ ...r, report: r.result }));
  } finally {
    host.endFanout(state, fanout);
  }
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T | undefined {
  if (value === undefined) return undefined;
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
}

function list(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`${title}:`, ...items.map((i) => `- ${i}`)];
}
