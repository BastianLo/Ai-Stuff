import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactPath } from "../artifacts/version.ts";
import type { BestOfNProduce } from "../config/schema.ts";
import { gateStep, nextStep } from "../core/next-step.ts";
import { CandidateReportSchema, JudgeReportSchema, type CandidateReport, type JudgeReport } from "../core/reports.ts";
import type { CheckResult, SessionState } from "../core/types.ts";
import { candidatePrompt, judgePrompt, type JudgeCandidate } from "../fanout/prompts.ts";
import { runFanout, type FanoutJob, type FanoutResult } from "../fanout/runner.ts";
import { FigrError, messageOf } from "../util/errors.ts";
import { runChecks } from "../workspace/checks.ts";
import { addWorktree, applyPatch, diffStat, fullDiff, gitOut, headCommit, isRepo, removeWorktree } from "../workspace/git.ts";
import type { PatternHost } from "./host.ts";
import type { ToolRun } from "./review.ts";

const LETTERS = "ABCDEFGH";
const MAX_JUDGE_DIFF = 200 * 1024;

interface Candidate {
  readonly label: string;
  readonly dir: string;
  readonly base: string;
  patch: string;
  stat: string;
  checks: CheckResult[];
  report?: CandidateReport;
  status: string;
}

function bestOfNGate(host: PatternHost, state: SessionState): [string, BestOfNProduce] {
  const found = Object.entries(host.profile(state).gates).find(([, g]) => g.produce?.pattern === "best-of-n");
  const produce = found?.[1].produce;
  if (!found || produce?.pattern !== "best-of-n") throw new FigrError("Kein Gate mit produce.pattern best-of-n konfiguriert.");
  return [found[0], produce];
}

/** Best-of-N: `figr_best_of_n({ task, n?, agent? })` (plan.md 11.3). */
export async function runBestOfN(host: PatternHost, state: SessionState, input: { task: string; n?: number; agent?: string }, run: ToolRun): Promise<string> {
  const profile = host.profile(state);
  const [gateName, produce] = bestOfNGate(host, state);
  const gate = profile.gates[gateName];
  const views = await host.views(state);
  const view = views.find((v) => v.name === gateName);
  if (!gate || !view) throw new FigrError(`Unbekanntes Gate „${gateName}“.`);
  if (view.status === "blocked") throw new FigrError(`Gate „${gateName}“ ist gesperrt. ${gateStep(view) ?? ""}`);
  const agent = input.agent ?? produce.agent;
  if (agent !== produce.agent && !gate.agents.includes(agent)) throw new FigrError(`„${agent}“ ist kein Implementer von Gate „${gateName}“.`);
  const n = Math.min(Math.max(input.n ?? produce.n, 1), LETTERS.length);
  const budget = profile.rules.subagents.maxTotal - state.subagentsTotal;
  if (n + 1 > budget) throw new FigrError(`Sub-Agent-Budget reicht nicht (${n + 1} nötig, ${Math.max(0, budget)} übrig).`);

  const loc = host.location(state);
  if (!(await isRepo(loc.project))) throw new FigrError("Best-of-N braucht ein git-Repository im Projektverzeichnis.");
  const head = await headCommit(loc.project);
  if (!head) throw new FigrError("Best-of-N braucht mindestens einen Commit (HEAD).");

  // Plan-Datei (falls vorhanden) absolut an die Kandidaten geben.
  const planGate = gate.requires.map((r) => profile.gates[r]).find((g) => g?.artifact?.type === "file");
  const planPath = planGate?.artifact?.type === "file" ? artifactPath(planGate.artifact, loc) : undefined;

  const root = join(tmpdir(), "figr", state.sessionID.replace(/[^\w-]/g, "_"), `bon-${host.ports.clock.now()}`);
  const candidatesDir = join(loc.sessionDir, "candidates");
  mkdirSync(candidatesDir, { recursive: true });
  const exclude = [loc.workDirRel];
  const candidates: Candidate[] = [];
  try {
    // 1. Worktrees vom aktuellen Arbeitsstand (HEAD + ungespeicherte Änderungen).
    run.progress(`Best-of-${n}: Worktrees anlegen`);
    const current = await fullDiff(loc.project, head, exclude);
    for (let i = 0; i < n; i++) {
      const label = LETTERS[i] ?? String(i);
      const dir = join(root, `cand-${label}`);
      mkdirSync(root, { recursive: true });
      await addWorktree(loc.project, dir, head);
      await applyPatch(dir, current);
      // Startstand des Kandidaten als Basis seines Diffs festhalten.
      await gitOut(dir, ["add", "-A"]);
      await gitOut(dir, ["commit", "--allow-empty", "-q", "-m", "figr: candidate base"]);
      candidates.push({ label, dir, base: await gitOut(dir, ["rev-parse", "HEAD"]), patch: "", stat: "", checks: [], status: "pending" });
    }

    // 2. Kandidaten parallel.
    const jobs: FanoutJob[] = candidates.map((c) => ({
      label: c.label,
      role: "candidate",
      agent,
      title: `FiGr · Kandidat ${c.label} · ${agent}`,
      directory: c.dir,
      prompt: candidatePrompt({ task: input.task, directory: c.dir, label: c.label, ...(planPath ? { planPath } : {}) }),
    }));
    const fanout = host.startFanout(state, "best-of-n", gateName, jobs);
    let results: FanoutResult<CandidateReport>[];
    try {
      results = await runFanout<CandidateReport>(state.sessionID, jobs, host.fanoutDeps(state, fanout, (job) => ({ label: job.label }), (c) => parseWith(CandidateReportSchema, c.report)), { maxParallel: profile.rules.subagents.maxParallel, signal: run.signal });
    } finally {
      host.endFanout(state, fanout);
    }
    if (run.signal.aborted) throw new FigrError("Best-of-N abgebrochen. Nichts wurde übernommen.");

    // 3. Diffs und Checks pro Kandidat.
    run.progress(`Best-of-${n}: Checks`);
    for (const c of candidates) {
      const r = results.find((x) => x.job.label === c.label);
      c.status = r?.status ?? "missing";
      if (r?.result) c.report = r.result;
      c.patch = await fullDiff(c.dir, c.base, [loc.workDirRel]);
      c.stat = await diffStat(c.dir, c.base, [loc.workDirRel]);
      writeFileSync(join(candidatesDir, `${c.label}.patch`), c.patch);
    }
    await Promise.all(
      candidates.map(async (c) => {
        if (c.patch.trim().length === 0 || produce.checks.length === 0) return;
        c.checks = await runChecks(produce.checks, c.dir, { signal: run.signal, parallel: produce.checksParallel, onFull: (cmd, out) => host.audit.attach(state.sessionID, `cand-${c.label}-${cmd}.log`, out) });
      }),
    );
    const viable = candidates.filter((c) => c.patch.trim().length > 0);
    if (viable.length === 0) throw new FigrError(`Kein Kandidat hat Änderungen erzeugt (${candidates.map((c) => `${c.label}: ${c.status}`).join(", ")}).`);
    const green = viable.filter((c) => c.checks.every((x) => x.ok));
    const allowed = (green.length > 0 ? green : viable).map((c) => c.label);

    // 4. Richter (bei nur einem brauchbaren Kandidaten entfällt er).
    let judge: JudgeReport | undefined;
    let winner: Candidate | undefined;
    if (viable.length === 1) {
      winner = viable[0];
    } else {
      const judgeJob: FanoutJob = {
        label: "judge",
        role: "judge",
        agent: produce.judge,
        title: `FiGr · Richter · ${produce.judge}`,
        prompt: judgePrompt({ task: input.task, ...(planPath ? { planPath } : {}), candidates: viable.map((c) => judgeCandidate(c, candidatesDir)) }),
      };
      const jf = host.startFanout(state, "best-of-n", gateName, [judgeJob]);
      host.setJudgeRule(jf.id, { all: viable.map((c) => c.label), allowed });
      try {
        const [jr] = await runFanout<JudgeReport>(state.sessionID, [judgeJob], host.fanoutDeps(state, jf, () => ({}), (c) => parseWith(JudgeReportSchema, c.report)), { maxParallel: 1, signal: run.signal });
        judge = jr?.result;
      } finally {
        host.endFanout(state, jf);
      }
      winner = judge ? viable.find((c) => c.label === judge?.winner.toUpperCase()) : undefined;
      // Ohne Urteil: bester grüner Kandidat mit dem kleinsten Diff (deterministischer Rückfall).
      if (!winner) winner = [...viable].filter((c) => allowed.includes(c.label)).sort((a, b) => a.patch.length - b.patch.length)[0];
    }
    if (!winner) throw new FigrError("Kein Gewinner bestimmbar.");

    // 5. Übernahme des Gewinners ins Projekt (kein halbes Anwenden).
    run.progress(`Best-of-${n}: übernehme ${winner.label}`);
    try {
      await applyPatch(loc.project, winner.patch, { threeWay: true });
    } catch (error) {
      host.audit.write(state.sessionID, "apply", { gate: gateName, winner: winner.label, ok: false, error: messageOf(error) });
      throw new FigrError(`Gewinner ${winner.label} ließ sich nicht übernehmen: ${messageOf(error)}. Patch: ${join(candidatesDir, `${winner.label}.patch`)}`);
    }
    host.audit.write(state.sessionID, "apply", { gate: gateName, winner: winner.label, ok: true });
    host.bumpDiff();
    const after = await host.views(state);
    return [
      `FiGr Best-of-${n}: Gewinner ${winner.label}${judge ? ` (Richter ${produce.judge})` : viable.length === 1 ? " (einziger brauchbarer Kandidat)" : " (Rückfall: kein Richterurteil)"} – übernommen.`,
      ...(judge ? [`Begründung: ${judge.reasons}`, `Ranking: ${judge.ranking.join(" > ")}`, ...(judge.mergeIdeas ? [`Ideen zum Kombinieren: ${judge.mergeIdeas}`] : [])] : []),
      "Kandidaten:",
      ...candidates.map((c) => `- ${c.label}: ${c.status}, ${checkSummary(c)}, Patch ${join(candidatesDir, `${c.label}.patch`)}${c.report ? ` – ${c.report.summary}` : ""}`),
      `Nächster Schritt: ${nextStep(after)}`,
    ].join("\n");
  } finally {
    // 6. Aufräumen, auch bei Fehlern.
    for (const c of candidates) await removeWorktree(loc.project, c.dir).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function checkSummary(c: Candidate): string {
  if (c.patch.trim().length === 0) return "keine Änderungen";
  if (c.checks.length === 0) return "keine Checks";
  return c.checks.every((x) => x.ok) ? "Checks grün" : `Checks rot (${c.checks.filter((x) => !x.ok).map((x) => x.command).join(", ")})`;
}

function judgeCandidate(c: Candidate, dir: string): JudgeCandidate {
  const diff = c.patch.length > MAX_JUDGE_DIFF ? `${c.patch.slice(0, MAX_JUDGE_DIFF)}\n… [gekürzt, vollständig unter ${join(dir, `${c.label}.patch`)}]` : c.patch;
  const checks = c.checks.length === 0 ? "green (no checks configured)" : c.checks.every((x) => x.ok) ? `green (${c.checks.map((x) => x.command).join(", ")})` : `red: ${c.checks.filter((x) => !x.ok).map((x) => `${x.command} → ${x.output.slice(-400)}`).join(" | ")}`;
  return { label: c.label, patchPath: join(dir, `${c.label}.patch`), diff, stat: c.stat, checks, ...(c.report ? { report: `${c.report.summary}${c.report.knownIssues.length ? ` (known issues: ${c.report.knownIssues.join("; ")})` : ""}` } : {}) };
}

function parseWith<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T | undefined {
  if (value === undefined) return undefined;
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
}
