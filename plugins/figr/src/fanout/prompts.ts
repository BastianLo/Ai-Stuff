/**
 * Rollen-Prompts für Kind-Sessions. Bewusst auf Englisch (plan.md 14.2): Modelle befolgen englische Anweisungen zuverlässiger.
 * Die Agent-Dateien selbst enthalten keine FiGr-Mechanik; sie kommt über diese Prompts und den Kontext-Hook.
 */

export interface ReviewPromptInput {
  readonly gate: string;
  readonly short: string;
  readonly artifact: string;
  readonly rubric?: string;
  readonly focus?: string;
  readonly task?: string;
}

export function reviewerPrompt(i: ReviewPromptInput): string {
  return [
    `You are reviewing gate "${i.gate}", version ${i.short}.`,
    "",
    "## Artifact",
    i.artifact,
    ...(i.task ? ["", "## Original task", i.task] : []),
    ...(i.rubric ? ["", "## Evaluate against", i.rubric] : []),
    ...(i.focus ? ["", "## Focus", i.focus] : []),
    "",
    "## Rules",
    "- Review only. Do not modify any files.",
    "- Judge independently; you will not see other reviewers' verdicts.",
    "- Approve only if there are no blocker findings. `approved` with a blocker is rejected by the tool.",
    "- Finish by calling the tool `figr_verdict` exactly once with verdict, summary and findings. A verdict written only as text does not count.",
  ].join("\n");
}

/** Abschnitt, der an einen direkt (über `subagent`) gestarteten Reviewer angehängt wird (plan.md 10.2). */
export function reviewerAppendix(i: { gate: string; short: string; artifact: string }): string {
  return [
    "",
    "---",
    `FiGr: You are reviewing gate "${i.gate}", version ${i.short}. Artifact: ${i.artifact}`,
    "Do not modify files. Submit your verdict with the tool `figr_verdict` (approved | changes_requested | rejected, summary, findings).",
  ].join("\n");
}

export function plannerPrompt(i: { task: string; planPath: string; context?: string; perspective?: string }): string {
  return [
    "Write an implementation plan for the following task.",
    "",
    "## Task",
    i.task,
    ...(i.context ? ["", "## Context", i.context] : []),
    "",
    "## Output",
    `- Write the complete plan as Markdown to: ${i.planPath}`,
    "- Work independently. Do not read or wait for other plans.",
    "- The plan must be concrete: steps, files to touch, tests, risks, acceptance criteria.",
    "- Do not implement anything; only read the code and write the plan file.",
    `- Finish by calling \`figr_report\` with { planPath: "${i.planPath}", summary, risks, openQuestions }.`,
  ].join("\n");
}

export function synthesizerPrompt(i: { task: string; plans: readonly { agent: string; path: string; summary?: string }[]; planPath: string }): string {
  return [
    "Several planners wrote independent plans for the same task. Merge them into one plan.",
    "",
    "## Task",
    i.task,
    "",
    "## Plans",
    ...i.plans.map((p) => `- ${p.agent}: ${p.path}${p.summary ? ` – ${p.summary}` : ""}`),
    "",
    "## Output",
    `- Read every plan and write the merged plan as Markdown to: ${i.planPath}`,
    "- Take the strongest ideas; resolve differences with a short reason.",
    "- List only genuine conflicts that need a human decision in `conflicts`.",
    `- Finish by calling \`figr_report\` with { planPath: "${i.planPath}", decisions: [{ topic, chosen, from, reason }], conflicts }.`,
  ].join("\n");
}

export function candidatePrompt(i: { task: string; planPath?: string; directory: string; label: string }): string {
  return [
    `You are implementation candidate ${i.label}.`,
    "",
    "## Task",
    i.task,
    ...(i.planPath ? ["", "## Approved plan", `Follow the approved plan: ${i.planPath}`] : []),
    "",
    "## Rules",
    `- Work only inside your working directory: ${i.directory}`,
    "- Do not commit, push or create branches.",
    "- Run the relevant tests yourself if possible.",
    "- Finish by calling `figr_report` with { summary, testsRun, knownIssues }.",
  ].join("\n");
}

export interface JudgeCandidate {
  readonly label: string;
  readonly patchPath: string;
  readonly diff: string;
  readonly stat: string;
  readonly checks: string;
  readonly report?: string;
}

export function judgePrompt(i: { task: string; planPath?: string; candidates: readonly JudgeCandidate[] }): string {
  const anyGreen = i.candidates.some((c) => c.checks.startsWith("green"));
  return [
    `Choose the best of ${i.candidates.length} implementation candidates.`,
    "",
    "## Task",
    i.task,
    ...(i.planPath ? ["", `Approved plan: ${i.planPath}`] : []),
    "",
    ...i.candidates.flatMap((c) => [
      `## Candidate ${c.label}`,
      `Checks: ${c.checks}`,
      ...(c.report ? [`Report: ${c.report}`] : []),
      "Diff stat:",
      "```",
      c.stat || "(empty)",
      "```",
      `Full patch: ${c.patchPath}`,
      "```diff",
      c.diff,
      "```",
      "",
    ]),
    "## Rules",
    "- Judge correctness first, then fit to the plan, then code quality and tests.",
    anyGreen ? "- A candidate with failing checks must not win while another candidate has green checks." : "- All candidates have failing checks; pick the most promising one.",
    "- Do not modify any files.",
    "- Finish by calling `figr_report` with { winner, ranking, reasons, mergeIdeas? }.",
  ].join("\n");
}

export function nudgeText(role: string, tool: string): string {
  return `FiGr: You have not called \`${tool}\` yet. As ${role} you must finish by calling \`${tool}\` with the required fields. Do it now.`;
}
