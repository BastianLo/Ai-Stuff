import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import { decide, shellSegments, type Action, type SessionRole } from "../../src/core/decide.ts";
import { computeGates } from "../../src/core/gates.ts";
import { newSessionState, type SessionState } from "../../src/core/types.ts";
import { testConfigRaw } from "../fake-host.ts";

const ORCH: SessionRole = { kind: "orchestrator" };
const REVIEWER: SessionRole = { kind: "child", role: "reviewer" };
const PHASE: SessionRole = { kind: "child", role: "phase" };

function run(action: Action, role: SessionRole, mutate: (s: SessionState) => void = () => undefined, raw = testConfigRaw(), current: Record<string, string> = {}) {
  const profile = resolveConfig(raw).profiles.strict!;
  const s = newSessionState("s", "strict", 0);
  mutate(s);
  return decide(action, role, { profile, views: computeGates(profile, s, current), state: s });
}

describe("decide", () => {
  it("Orchestrator darf nicht editieren, Implementer schon, Reviewer nie", () => {
    expect(run({ kind: "edit" }, ORCH)).toMatchObject({ allow: false });
    expect(run({ kind: "edit" }, PHASE)).toEqual({ allow: true });
    expect(run({ kind: "edit" }, REVIEWER)).toMatchObject({ allow: false });
  });

  it("deaktivierte Session: alles erlaubt", () => {
    expect(run({ kind: "edit" }, ORCH, (s) => (s.enabled = false))).toEqual({ allow: true });
  });

  it("Shell-Allowlist inkl. verketteter Befehle", () => {
    expect(run({ kind: "shell", command: "git status" }, ORCH)).toEqual({ allow: true });
    expect(run({ kind: "shell", command: "git status && git diff --stat" }, ORCH)).toEqual({ allow: true });
    expect(run({ kind: "shell", command: "git status && rm -rf src" }, ORCH)).toMatchObject({ allow: false });
    expect(run({ kind: "shell", command: "git diff > x.patch" }, ORCH)).toMatchObject({ allow: false });
    expect(run({ kind: "shell", command: "sed -i s/a/b/ app.js" }, ORCH)).toMatchObject({ allow: false });
    expect(run({ kind: "shell", command: "npm test" }, PHASE)).toEqual({ allow: true });
  });

  it("shellSegments erkennt Ersetzung und Hintergrund", () => {
    expect(shellSegments("ls $(rm x)")).toBeUndefined();
    expect(shellSegments("ls `rm x`")).toBeUndefined();
    expect(shellSegments("sleep 1 & rm x")).toBeUndefined();
    expect(shellSegments("ls | grep a")).toEqual(["ls", "grep a"]);
  });

  it("Implementer vor Plan-Abnahme gesperrt, mit nächstem Schritt", () => {
    const d = run({ kind: "subagent", agent: "implementer" }, ORCH, (s) => {
      s.gates.research = { versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: true, evidenceFlags: {} };
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.message).toContain("„implementer“ gehört zu Gate „implementation“");
      expect(d.message).toContain("„plan“ ist nicht erfüllt (0/2 Freigaben)");
      expect(d.message).toContain("figr_plan");
    }
  });

  it("Implementer nach Plan-Abnahme erlaubt", () => {
    const d = run(
      { kind: "subagent", agent: "implementer" },
      ORCH,
      (s) => {
        s.gates.research = { versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: true, evidenceFlags: {} };
        s.gates.plan = { versions: [{ hash: "h", short: "p1", at: 0 }], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: false, evidenceFlags: {}, passedVersion: "h" };
      },
      testConfigRaw(),
      { plan: "h" },
    );
    expect(d).toEqual({ allow: true });
  });

  it("produce.enforce verlangt das Muster", () => {
    const raw = testConfigRaw();
    const strict = (raw.profiles as Record<string, { gates: Record<string, { produce?: Record<string, unknown> }> }>).strict!;
    strict.gates.implementation!.produce!.enforce = true;
    const mut = (s: SessionState) => {
      s.gates.research = { versions: [], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: true, evidenceFlags: {} };
      s.gates.plan = { versions: [{ hash: "h", short: "p1", at: 0 }], rounds: [], skipped: false, evidenceRuns: [], evidencePassed: false, evidenceFlags: {}, passedVersion: "h" };
    };
    const d = run({ kind: "subagent", agent: "implementer" }, ORCH, mut, raw, { plan: "h" });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.message).toContain("figr_best_of_n");
    expect(run({ kind: "subagent", agent: "implementer", viaFigr: true }, ORCH, mut, raw, { plan: "h" })).toEqual({ allow: true });
  });

  it("Reviewer ohne Artefakt gesperrt; nicht konfigurierte Agenten frei", () => {
    expect(run({ kind: "subagent", agent: "security-reviewer" }, ORCH)).toMatchObject({ allow: false });
    expect(run({ kind: "subagent", agent: "docs-writer" }, ORCH)).toEqual({ allow: true });
    expect(run({ kind: "subagent", agent: "explore" }, ORCH)).toEqual({ allow: true });
  });

  it("Budget und Direktaufrufe pro Turn", () => {
    expect(run({ kind: "subagent", agent: "explore" }, ORCH, (s) => (s.subagentsTotal = 60))).toMatchObject({ allow: false });
    const raw = testConfigRaw();
    (raw.profiles as Record<string, { rules: Record<string, unknown> }>).strict!.rules.orchestrator = { maxDirectSubagentsPerTurn: 1 };
    expect(run({ kind: "subagent", agent: "explore" }, ORCH, (s) => (s.directSubagentsThisTurn = 1), raw)).toMatchObject({ allow: false });
  });
});
