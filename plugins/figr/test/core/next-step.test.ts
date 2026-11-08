import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import { computeGates, type GateView } from "../../src/core/gates.ts";
import { gateStep, nextStep } from "../../src/core/next-step.ts";
import { compactStatus, statusText } from "../../src/core/status.ts";
import { newSessionState, RoundSchema, type SessionState } from "../../src/core/types.ts";

const profileOf = (gates: Record<string, unknown>) => resolveConfig({ defaultProfile: "p", profiles: { p: { gates } } }).profiles.p!;
const by = (views: GateView[], name: string) => views.find((v) => v.name === name)!;
const gs = (o: Record<string, unknown> = {}) => ({ versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: false, evidenceFlags: {}, ...o });

describe("nächster Schritt je Gate-Art", () => {
  it.each([
    [{ artifact: { type: "text" }, approve: { reviewers: ["r"] } }, 'figr_submit(gate: "g"'],
    [{ artifact: { type: "file", path: "x.md" }, agents: ["writer"], approve: { reviewers: ["r"] } }, 'subagent(agent: "writer") – schreibt x.md'],
    [{ artifact: { type: "file", path: "x.md" }, approve: { reviewers: ["r"] } }, "die Datei x.md anlegen lassen"],
    [{ artifact: { type: "diff" }, agents: ["impl"], approve: { reviewers: ["r"] } }, 'subagent(agent: "impl", …)'],
    [{ artifact: { type: "diff" }, approve: { reviewers: ["r"] } }, "das Artefakt für „g“ erzeugen"],
    [{ artifact: { type: "diff" }, produce: { pattern: "single", agent: "impl" }, approve: { reviewers: ["r"] } }, 'subagent(agent: "impl", …)'],
    [{ evidence: { file: { path: "README.md" } } }, "Datei README.md anlegen lassen"],
    [{ evidence: { check: "npm test" } }, "Check „npm test“ grün bekommen"],
  ])("%j", (gate, want) => {
    const views = computeGates(profileOf({ g: gate }), newSessionState("s", "p", 0), {});
    expect(nextStep(views)).toContain(want);
  });

  it("Evidence aus Host-Flags, Überarbeitung, unterbrochene Runde, offene Reviewer", () => {
    const p = profileOf({
      e: { evidence: { file: { path: "a" }, check: "true" } },
      t: { requires: ["e"], artifact: { type: "text" }, approve: { reviewers: ["r1", "r2"] } },
      d: { requires: ["t"], final: true },
    });
    const s: SessionState = newSessionState("s", "p", 0);
    s.gates.e = gs({ evidenceFlags: { file: true } });
    expect(by(computeGates(p, s, {}), "e").status).toBe("open");
    s.gates.e = gs({ evidenceFlags: { file: true, check: true } });
    let views = computeGates(p, s, { t: "h1" });
    expect(by(views, "e").status).toBe("passed");
    expect(gateStep(by(views, "t"))).toBe('figr_review(gate: "t").');
    expect(gateStep(by(views, "d"))).toContain("Zuerst t erfüllen");

    s.gates.t = gs({ versions: [{ hash: "h1", short: "t1", at: 0 }] });
    const round = RoundSchema.parse({ index: 1, version: "h1", short: "t1", reviewers: ["r1", "r2"], verdicts: { r1: { reviewer: "r1", verdict: "approved", summary: "", findings: [], at: 0 } }, startedAt: 0, checks: [] });
    s.gates.t.rounds.push(round);
    views = computeGates(p, s, { t: "h1" });
    expect(gateStep(by(views, "t"))).toContain("offen: r2");
    round.interrupted = true;
    expect(gateStep(by(computeGates(p, s, { t: "h1" }), "t"))).toContain("unterbrochen");
    round.verdicts.r2 = { reviewer: "r2", verdict: "changes_requested", summary: "", findings: [{ severity: "minor", message: "m" }], at: 0 };
    views = computeGates(p, s, { t: "h1" });
    expect(gateStep(by(views, "t"))).toContain("figr_submit");
    const text = statusText({ profileName: "p", profile: p, views, state: s });
    expect(text).toContain("Offene Befunde t (t1)");
    expect(text).toContain("[minor] m (r2)");
  });

  it("Statustext zeigt laufende Fan-outs und die letzte Blockade; kompakte Zeile kürzt Namen", () => {
    const p = profileOf({ implementation: { artifact: { type: "diff" }, approve: { reviewers: ["r"] } }, research: { evidence: { subagents: { agents: ["x"], min: 2 } } } });
    const s = newSessionState("s", "p", 0);
    s.fanouts.push({ id: "f", kind: "review", gate: "implementation", startedAt: 0, jobs: [{ label: "r", agent: "r", status: "running" }] });
    s.lastBlock = { message: "FiGr: gesperrt\nDetails", at: 0 };
    s.enabled = false;
    const views = computeGates(p, s, { implementation: "h" });
    const text = statusText({ profileName: "p", profile: p, views, state: s });
    expect(text).toContain("FiGr · p (aus)");
    expect(text).toContain("… review (implementation): r=running");
    expect(text).toContain("Letzte Blockade: FiGr: gesperrt");
    expect(compactStatus(views)).toBe("FiGr: impl 0/1 · rese ▶");
  });
});
