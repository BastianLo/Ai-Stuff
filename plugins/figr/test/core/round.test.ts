import { describe, expect, it } from "vitest";
import { ApproveSchema } from "../../src/config/schema.ts";
import { escalationReason, evaluateRound, required, roundFindings, stagnationFingerprint } from "../../src/core/round.ts";
import { RoundSchema, type Round, type Verdict } from "../../src/core/types.ts";

const approve = (o: Record<string, unknown> = {}) => ApproveSchema.parse({ reviewers: ["a", "b", "c"], ...o });
const v = (reviewer: string, verdict: Verdict["verdict"], findings: Verdict["findings"] = []): Verdict => ({ reviewer, verdict, summary: "s", findings, at: 1 });
const round = (verdicts: Verdict[], o: Partial<Round> = {}): Round =>
  RoundSchema.parse({ index: 1, version: "h", short: "p1", reviewers: ["a", "b", "c"], verdicts: Object.fromEntries(verdicts.map((x) => [x.reviewer, x])), startedAt: 0, ...o });

describe("required", () => {
  it.each([
    ["all", 3, 3],
    ["majority", 3, 2],
    ["majority", 4, 3],
    ["majority", 1, 1],
    [2, 3, 2],
  ] as const)("%s von %i → %i", (q, n, want) => expect(required(q, n)).toBe(want));
});

describe("evaluateRound", () => {
  it.each([
    ["alle zugestimmt", [v("a", "approved"), v("b", "approved"), v("c", "approved")], {}, "passed"],
    ["ausstehend", [v("a", "approved")], {}, "in_review"],
    ["alle geurteilt, Quorum verfehlt", [v("a", "approved"), v("b", "changes_requested"), v("c", "approved")], {}, "changes_requested"],
    ["Mehrheit reicht vor dem letzten Urteil", [v("a", "approved"), v("b", "approved")], { quorum: "majority" }, "passed"],
    ["Veto blockiert trotz Quorum", [v("a", "approved"), v("b", "approved"), v("c", "rejected")], { quorum: "majority", veto: true }, "rejected"],
    ["rejected ohne Veto zählt als Nein", [v("a", "approved"), v("b", "approved"), v("c", "rejected")], { quorum: "majority" }, "passed"],
  ] as const)("%s", (_n, verdicts, o, want) => {
    expect(evaluateRound(round([...verdicts]), approve(o)).status).toBe(want);
  });

  it("missing zählt als entschieden", () => {
    const r = round([v("a", "approved"), v("b", "approved")], { missing: ["c"] });
    expect(evaluateRound(r, approve()).status).toBe("changes_requested");
    expect(evaluateRound(r, approve()).pending).toEqual([]);
  });

  it("Checks: ausstehend blockiert passed, rot macht changes_requested", () => {
    const all = [v("a", "approved"), v("b", "approved"), v("c", "approved")];
    const cfg = approve({ checks: ["npm test"] });
    expect(evaluateRound(round(all), cfg).status).toBe("in_review");
    expect(evaluateRound(round(all, { checks: [{ command: "npm test", ok: true, exitCode: 0, output: "", durationMs: 1, timedOut: false }] }), cfg).status).toBe("passed");
    const red = round(all, { checks: [{ command: "npm test", ok: false, exitCode: 1, output: "boom", durationMs: 1, timedOut: false }] });
    expect(evaluateRound(red, cfg).status).toBe("changes_requested");
    expect(roundFindings(red)[0]).toMatchObject({ severity: "blocker", from: ["check"] });
  });
});

describe("Befunde und Stagnation", () => {
  const f = (message: string, severity: "blocker" | "minor" = "minor") => ({ severity, message });
  it("führt Duplikate zusammen und sortiert nach Schwere", () => {
    const r = round([v("a", "changes_requested", [f("Token fehlt!"), f("nit")]), v("b", "changes_requested", [f("token  fehlt"), f("Kaputt", "blocker")])]);
    const out = roundFindings(r);
    expect(out[0]?.message).toBe("Kaputt");
    expect(out.find((x) => x.message === "Token fehlt!")?.from).toEqual(["a", "b"]);
  });

  it("Fingerprint ist unabhängig von Reihenfolge und Schreibweise", () => {
    const r1 = round([v("a", "changes_requested", [f("A"), f("B")])]);
    const r2 = round([v("b", "changes_requested", [f("b "), f("a")])]);
    expect(stagnationFingerprint(r1)).toBe(stagnationFingerprint(r2));
    expect(stagnationFingerprint(round([]))).toBe("");
  });

  it("escalationReason: maxRounds und Stagnation", () => {
    const failed = (msg: string, i: number) => round([v("a", "changes_requested", [f(msg)]), v("b", "approved"), v("c", "approved")], { index: i, version: `h${i}` });
    const cfg = approve({ maxRounds: 3 });
    expect(escalationReason([failed("x", 1)], cfg, true)).toBeUndefined();
    expect(escalationReason([failed("x", 1), failed("x", 2)], cfg, true)).toBe("stagnation");
    expect(escalationReason([failed("x", 1), failed("x", 2)], cfg, false)).toBeUndefined();
    expect(escalationReason([failed("x", 1), failed("y", 2), failed("z", 3)], cfg, true)).toBe("maxRounds");
  });
});
