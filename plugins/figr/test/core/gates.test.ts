import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import { computeGates, isComplete, reviewTarget, type GateView } from "../../src/core/gates.ts";
import { nextStep, openGates } from "../../src/core/next-step.ts";
import { compactStatus, statusText, systemBlock } from "../../src/core/status.ts";
import { newSessionState, RoundSchema, type SessionState } from "../../src/core/types.ts";
import { testConfigRaw } from "../fake-host.ts";

const cfg = resolveConfig(testConfigRaw());
const profile = cfg.profiles.strict!;
const by = (views: GateView[], name: string) => views.find((v) => v.name === name)!;

function state(): SessionState {
  return newSessionState("s1", "strict", 0);
}
function withVersion(s: SessionState, gate: string, hash: string, short: string): void {
  s.gates[gate] ??= { versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: false, evidenceFlags: {} };
  s.gates[gate].versions.push({ hash, short, at: 0 });
}
function addRound(s: SessionState, gate: string, hash: string, verdicts: Record<string, "approved" | "changes_requested" | "rejected">, reviewers: string[]): void {
  const gs = s.gates[gate]!;
  gs.rounds.push(
    RoundSchema.parse({
      index: gs.rounds.length + 1,
      version: hash,
      short: gs.versions.find((v) => v.hash === hash)?.short ?? "?",
      reviewers,
      verdicts: Object.fromEntries(Object.entries(verdicts).map(([r, verdict]) => [r, { reviewer: r, verdict, summary: "", findings: [], at: 0 }])),
      startedAt: 0,
      checks: [],
    }),
  );
}

describe("computeGates", () => {
  it("Ausgangslage: research offen, Rest gesperrt", () => {
    const views = computeGates(profile, state(), {});
    expect(views.map((v) => [v.name, v.status])).toEqual([
      ["research", "open"],
      ["plan", "blocked"],
      ["implementation", "blocked"],
      ["done", "blocked"],
    ]);
    expect(by(views, "plan").missingRequires).toEqual(["research"]);
    expect(nextStep(views)).toContain('subagent(agent: "explore")');
  });

  it("Nachweis erfüllt → plan offen, Artefakt → in_review, Freigaben → passed", () => {
    const s = state();
    s.gates.research = { versions: [], rounds: [], skipped: false, evidenceRuns: [{ agent: "explore", at: 0 }], evidencePassed: false, evidenceFlags: {} };
    let views = computeGates(profile, s, {});
    expect(by(views, "research").status).toBe("passed");
    expect(by(views, "plan").status).toBe("open");
    expect(nextStep(views)).toContain("figr_plan");

    withVersion(s, "plan", "h1", "p1");
    views = computeGates(profile, s, { plan: "h1" });
    expect(by(views, "plan").status).toBe("in_review");
    expect(by(views, "plan").version).toEqual({ hash: "h1", short: "p1" });

    addRound(s, "plan", "h1", { "architect-reviewer": "approved", "security-reviewer": "changes_requested" }, ["architect-reviewer", "security-reviewer"]);
    views = computeGates(profile, s, { plan: "h1" });
    expect(by(views, "plan").status).toBe("changes_requested");
    expect(nextStep(views)).toContain('figr_review(gate: "plan")');

    withVersion(s, "plan", "h2", "p2");
    addRound(s, "plan", "h2", { "architect-reviewer": "approved", "security-reviewer": "approved" }, ["architect-reviewer", "security-reviewer"]);
    views = computeGates(profile, s, { plan: "h2" });
    expect(by(views, "plan").status).toBe("passed");
    expect(by(views, "implementation").status).toBe("open");
    expect(nextStep(views)).toContain("figr_best_of_n");
  });

  it("Verfall: neue Plan-Version sperrt die abhängige Implementierung wieder", () => {
    const s = state();
    s.gates.research = { versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: true, evidenceFlags: {} };
    withVersion(s, "plan", "h1", "p1");
    s.gates.plan!.passedVersion = "h1";
    expect(by(computeGates(profile, s, { plan: "h1", implementation: "d1" }), "implementation").status).toBe("in_review");
    withVersion(s, "plan", "h2", "p2");
    const views = computeGates(profile, s, { plan: "h2", implementation: "d1" });
    expect(by(views, "plan").status).toBe("in_review");
    expect(by(views, "implementation").status).toBe("blocked");
  });

  it("invalidateOnChange: false behält die Freigabe", () => {
    const p = resolveConfig(testConfigRaw({ defaultProfile: "s", profiles: { s: { gates: { plan: { artifact: { type: "file", path: "p.md" }, approve: { reviewers: ["a"], invalidateOnChange: false } } } } } })).profiles.s!;
    const s = state();
    withVersion(s, "plan", "h1", "p1");
    s.gates.plan!.passedVersion = "h1";
    expect(by(computeGates(p, s, { plan: "h2" }), "plan").status).toBe("passed");
  });

  it("skipped zählt wie passed; menschliche Freigabe hält in_review", () => {
    const p = resolveConfig(testConfigRaw({ defaultProfile: "s", profiles: { s: { gates: { a: {}, plan: { requires: ["a"], artifact: { type: "text" }, approve: { reviewers: ["r"], human: true } }, done: { requires: ["plan"], final: true } } } } })).profiles.s!;
    const s = state();
    s.gates.a = { versions: [], rounds: [], skipped: true, evidenceRuns: [], evidencePassed: false, evidenceFlags: {} };
    withVersion(s, "plan", "t1", "p1");
    addRound(s, "plan", "t1", { r: "approved" }, ["r"]);
    let views = computeGates(p, s, { plan: "t1" });
    expect(by(views, "a").status).toBe("skipped");
    expect(by(views, "plan").status).toBe("in_review");
    expect(by(views, "plan").awaitingHuman).toBe(true);
    expect(isComplete(views)).toBe(false);
    s.gates.plan!.humanApproved = "t1";
    views = computeGates(p, s, { plan: "t1" });
    expect(by(views, "plan").status).toBe("passed");
    expect(isComplete(views)).toBe(true);
  });

  it("openGates folgt nur der Kette des final-Gates", () => {
    const views = computeGates(profile, state(), {});
    expect(openGates(profile, views).map((v) => v.name)).toEqual(["research", "plan", "implementation", "done"]);
  });

  it("reviewTarget bevorzugt Gates, die auf Review warten", () => {
    const s = state();
    s.gates.research = { versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: true, evidenceFlags: {} };
    withVersion(s, "plan", "h1", "p1");
    const views = computeGates(profile, s, { plan: "h1" });
    expect(reviewTarget(views.filter((v) => v.config.approve))?.name).toBe("plan");
    expect(reviewTarget(views.filter((v) => v.name === "implementation"))).toBeUndefined();
  });

  it("Status-Texte", () => {
    const s = state();
    const views = computeGates(profile, s, {});
    const block = systemBlock({ profileName: "strict", profile, views, state: s });
    expect(block).toContain("You must not edit files yourself");
    expect(block).toContain('Gate "plan" requires research');
    expect(statusText({ profileName: "strict", profile, views, state: s })).toContain("Nächster Schritt");
    expect(compactStatus(views)).toMatch(/^FiGr: /);
  });
});
