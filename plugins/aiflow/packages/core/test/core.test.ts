import { describe, expect, it } from "vitest";
import {
  buildHandoffSchema,
  evaluateBooleanVote,
  evaluateCondition,
  evaluatePermission,
  majorityVote,
  mcpRules,
  nodePorts,
  parseDuration,
  parseHandoff,
  presetRules,
  renderTemplate,
  validateJsonSchema,
  validateWorkflow,
  workflowSchema,
  WorkflowGraph,
  type WorkflowInput,
} from "@aiflow/core";
import { loadExamples } from "./fixtures.js";

const { agents, workflows } = loadExamples();
const ctx = { agents, workflows };

function wf(input: Omit<WorkflowInput, "id" | "name"> & { id?: string }) {
  return workflowSchema.parse({ id: "test", name: "Test", ...input });
}

function codes(input: Parameters<typeof wf>[0]): string[] {
  return validateWorkflow(wf(input), ctx).issues.filter((i) => i.severity === "error").map((i) => i.code);
}

const minimal = {
  nodes: { start: { type: "start" as const }, work: { type: "agent" as const, agent: "implementer" }, done: { type: "end" as const } },
  edges: [
    { from: "start", to: "work" },
    { from: "work", to: "done" },
  ],
};

describe("Beispiel-Workflows", () => {
  it("lädt alle Beispiele", () => {
    expect(workflows.size).toBeGreaterThanOrEqual(6);
    expect(agents.size).toBeGreaterThanOrEqual(15);
  });
  for (const [id, workflow] of workflows) {
    it(`validiert ${id}`, () => {
      const result = validateWorkflow(workflow, ctx);
      expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    });
  }
});

describe("Validator – positive und negative Fälle", () => {
  it("akzeptiert einen minimalen Workflow", () => expect(codes(minimal)).toEqual([]));

  it("verlangt genau einen Start", () => {
    expect(codes({ ...minimal, nodes: { ...minimal.nodes, start2: { type: "start" } }, edges: [...minimal.edges, { from: "start2", to: "work" }] })).toContain("start.count");
  });

  it("verlangt einen Ende-Knoten", () => {
    expect(codes({ nodes: { start: { type: "start" }, a: { type: "agent", agent: "implementer" } }, edges: [{ from: "start", to: "a" }, { from: "a", to: "a", loop: { max: 2, onExceeded: "a" } }] })).toContain("end.missing");
  });

  it("meldet unerreichbare Knoten", () => {
    expect(codes({ ...minimal, nodes: { ...minimal.nodes, orphan: { type: "agent", agent: "implementer" } }, edges: [...minimal.edges, { from: "orphan", to: "done" }] })).toContain("node.unreachable");
  });

  it("meldet unverbundene Ports", () => {
    expect(codes({ ...minimal, edges: [{ from: "start", to: "work" }] })).toContain("port.unconnected");
  });

  it("verlangt Limits für Zyklen", () => {
    const c = codes({
      nodes: { start: { type: "start" }, a: { type: "agent", agent: "implementer" }, r: { type: "agent", agent: "reviewer", ports: { ok: { description: "gut" }, nok: { description: "schlecht" } } }, done: { type: "end" } },
      edges: [{ from: "start", to: "a" }, { from: "a", to: "r" }, { from: "r.nok", to: "a" }, { from: "r.ok", to: "done" }],
    });
    expect(c).toContain("loop.no-limit");
  });

  it("verlangt Beschreibungen und mindestens zwei Zweige", () => {
    const c = codes({
      nodes: { start: { type: "start" }, r: { type: "agent", agent: "reviewer", ports: { ok: { description: "" } } }, done: { type: "end" } },
      edges: [{ from: "start", to: "r" }, { from: "r.ok", to: "done" }],
    });
    expect(c).toEqual(expect.arrayContaining(["decision.single-branch", "decision.no-description"]));
  });

  it("meldet unbekannte Agenten, Ports und Templates", () => {
    expect(codes({ ...minimal, nodes: { ...minimal.nodes, work: { type: "agent", agent: "gibt-es-nicht" } } })).toContain("agent.unknown");
    expect(codes({ ...minimal, edges: [{ from: "start", to: "work" }, { from: "work.nope", to: "done" }] })).toContain("edge.unknown-port");
    expect(codes({ ...minimal, nodes: { ...minimal.nodes, work: { type: "agent", agent: "implementer", instructions: "{{vars.fehlt}}" } } })).toContain("template.unknown-var");
  });

  it("verlangt strukturierte Parallelität", () => {
    const c = codes({
      nodes: { start: { type: "start" }, a: { type: "agent", agent: "reviewer" }, b: { type: "agent", agent: "reviewer" }, j1: { type: "join" }, j2: { type: "join" }, done: { type: "end" } },
      edges: [{ from: "start", to: "a" }, { from: "start", to: "b" }, { from: "a", to: "j1" }, { from: "b", to: "j2" }, { from: "j1", to: "done" }, { from: "j2", to: "done" }],
    });
    expect(c).toContain("parallel.unstructured");
  });

  it("verbietet parallele Schreiber desselben Dokuments", () => {
    const c = codes({
      documents: { "plan.md": {} },
      nodes: {
        start: { type: "start" },
        a: { type: "agent", agent: "reviewer", documents: { "plan.md": "write" } },
        b: { type: "agent", agent: "reviewer", documents: { "plan.md": "write" } },
        j: { type: "join" },
        done: { type: "end" },
      },
      edges: [{ from: "start", to: "a" }, { from: "start", to: "b" }, { from: "a", to: "j" }, { from: "b", to: "j" }, { from: "j", to: "done" }],
    });
    expect(c).toContain("documents.parallel-write");
  });

  it("prüft Sub-Agenten-Einstellungen", () => {
    const c = codes({ ...minimal, nodes: { ...minimal.nodes, work: { type: "agent", agent: "implementer", subagents: { enabled: true, allowed: [] } } } });
    expect(c).toContain("subagents.none-allowed");
    const c2 = codes({ ...minimal, nodes: { ...minimal.nodes, work: { type: "agent", agent: "implementer", subagents: { enabled: true, allowed: ["code-explorer"], maxParallel: 5, maxRuns: 2 } } } });
    expect(c2).toContain("subagents.budget");
  });

  it("meldet rekursive Sub-Workflows", () => {
    expect(codes({ nodes: { start: { type: "start" }, s: { type: "subworkflow", workflow: "test" }, done: { type: "end" } }, edges: [{ from: "start", to: "s" }, { from: "s.success", to: "done" }, { from: "s.rejected", to: "done" }, { from: "s.failed", to: "done" }] })).toContain("subworkflow.recursive");
  });
});

describe("Graph", () => {
  it("findet Rückkanten und Ports", () => {
    const g = new WorkflowGraph(workflows.get("feature-review")!);
    const back = g.edges.filter((e) => g.backEdges.has(e.key)).map((e) => `${e.from}.${e.port}`);
    expect(back).toEqual(expect.arrayContaining(["checks.failed", "verdict.rejected"]));
    expect(nodePorts(g.node("verdict"))).toEqual(["approved", "rejected"]);
    expect(nodePorts(g.node("checks"))).toEqual(["passed", "failed"]);
    expect(g.out("checks", "passed")).toHaveLength(3);
  });
});

describe("Templates und Bedingungen", () => {
  it("rendert Variablen strikt", () => {
    expect(renderTemplate("Hallo {{input.name}} ({{node.a.visits}})", { input: { name: "Welt" }, node: { a: { visits: 2 } } })).toBe("Hallo Welt (2)");
    expect(() => renderTemplate("{{x.y}}", {})).toThrow(/Unbekannte/);
    expect(renderTemplate("[{{x}}]", {}, { strict: false })).toBe("[]");
  });

  it("wertet JSON Logic aus", () => {
    const data = { exitCode: 0, output: { findings: [{ severity: "high" }, { severity: "low" }] } };
    expect(evaluateCondition({ "==": [{ var: "exitCode" }, 0] }, data)).toBe(true);
    expect(evaluateCondition({ some: [{ var: "output.findings" }, { severityAtLeast: [{ var: "severity" }, "medium"] }] }, data)).toBe(true);
    expect(evaluateCondition({ all: [{ var: "output.findings" }, { severityAtLeast: [{ var: "severity" }, "medium"] }] }, data)).toBe(false);
    expect(evaluateCondition({ and: [{ ">": [{ count: [{ var: "output.findings" }] }, 1] }, { matches: ["abc", "^a"] }] }, data)).toBe(true);
    expect(() => evaluateCondition({ eval: ["x"] }, data)).toThrow(/Unbekannter/);
  });
});

describe("Übergabe und Abstimmung", () => {
  it("baut ein Schema mit Zweigen und Ausgabe-Vertrag", () => {
    const schema = buildHandoffSchema({
      branches: [
        { port: "approved", description: "gut", instructions: [] },
        { port: "rejected", description: "schlecht", instructions: ["Liste die Mängel"] },
      ],
      output: { type: "json", schema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } } },
    });
    expect(parseHandoff(schema, { summary: "ok", branch: "approved", branchReason: "passt", output: { approved: true } }).branch).toBe("approved");
    expect(() => parseHandoff(schema, { summary: "ok", branch: "vielleicht", branchReason: "x", output: { approved: true } })).toThrow(/branch/);
    expect(() => parseHandoff(schema, { summary: "ok", branch: "approved", branchReason: "x" })).toThrow(/output/);
  });

  it("entscheidet per Mehrheit mit Fallback bei Gleichstand", () => {
    expect(majorityVote(["a", "b", "a"]).winner).toBe("a");
    expect(majorityVote(["a", "b"], "b")).toMatchObject({ winner: "b", tie: true });
    expect(evaluateBooleanVote([true, false, true], "majority")).toBe(true);
    expect(evaluateBooleanVote([true, false, true], "veto")).toBe(false);
  });

  it("prüft JSON-Schemas", () => {
    expect(validateJsonSchema({ type: "array", items: { type: "integer" }, minItems: 1 }, [1, 2])).toEqual([]);
    expect(validateJsonSchema({ type: "array", items: { type: "integer" } }, [1, "x"])).toHaveLength(1);
  });
});

describe("Rechte und Hilfsfunktionen", () => {
  it("wendet die letzte passende Regel an", () => {
    const rules = presetRules("read-only");
    expect(evaluatePermission(rules, "shell", "rm -rf build")).toBe("deny");
    expect(evaluatePermission(rules, "shell", "git diff HEAD")).toBe("allow");
    expect(evaluatePermission(presetRules("implement"), "shell", "git push origin main")).toBe("deny");
    expect(evaluatePermission(presetRules("implement"), "edit", "src/a.ts")).toBe("allow");
  });

  it("MCP-Zugriff: Standard pro Agent, Ausnahmen pro Server, Verbot schlägt Erlaubnis", () => {
    const rules = mcpRules({ default: "deny", allow: ["github", "jira"], deny: ["jira"] });
    expect(evaluatePermission(rules, "mcp", "context7")).toBe("deny");
    expect(evaluatePermission(rules, "mcp", "github")).toBe("allow");
    expect(evaluatePermission(rules, "mcp", "jira")).toBe("deny");
    expect(evaluatePermission(mcpRules({ default: "allow", allow: [], deny: [] }), "mcp", "x")).toBe("allow");
  });

  it("wertet Muster in Aktionen aus (MCP-Tools <server>_*)", () => {
    const rules = [{ action: "github_*", resource: "*", effect: "deny" as const }];
    expect(evaluatePermission(rules, "github_create_issue", "*", "allow")).toBe("deny");
    expect(evaluatePermission(rules, "gitlab_x", "*", "allow")).toBe("allow");
  });

  it("parst Dauern", () => {
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration(500)).toBe(500);
    expect(() => parseDuration("bald")).toThrow();
  });
});
