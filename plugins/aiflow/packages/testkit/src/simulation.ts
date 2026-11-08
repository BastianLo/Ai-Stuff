import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { FakeIo } from "./fake-runtime.js";
import { dirname, join } from "node:path";
import { slugify, type JsonSchema } from "@aiflow/core";
import type { AgentRuntime, AgentStepContext, AgentStepRequest, AgentStepResult, RuntimeCapabilities } from "@aiflow/engine";
import { sleep } from "./fake-runtime.js";
import { sampleFromSchema } from "./sample.js";

export interface SimulationOptions {
  /** Faktor für Wartezeiten (1 = realistisch langsam für Demos, 0 = sofort). */
  speed?: number;
  /** Reviewer lehnen beim ersten Besuch ab (zeigt Schleifen). */
  rejectFirst?: boolean;
  /** Feste Zweigwahl je Knoten (Testlauf im Editor). */
  choices?: Record<string, string>;
  /** Dateien wirklich schreiben (false: gar nicht schreiben). */
  writeFiles?: boolean;
  /** Statt ins Dateisystem über diese Schreiber schreiben (In-Memory-Workspaces im Testlauf). */
  io?: FakeIo;
}

/**
 * Runtime ohne LLM für Demos, Testläufe und E2E-Tests. Erzeugt plausible Ausgaben, schreibt Dateien und
 * Dokumente, delegiert in Wellen und trifft Entscheidungen nach festen Regeln.
 */
export class SimulationRuntime implements AgentRuntime {
  readonly id = "simulation";
  private readonly visits = new Map<string, number>();

  constructor(private readonly options: SimulationOptions = {}) {}

  capabilities(): RuntimeCapabilities {
    return { structuredOutput: "native", sessionFork: true, userQuestions: "none" };
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    const factor = this.options.speed ?? 1;
    if (factor > 0) await sleep(ms * factor, signal);
  }

  async runAgentStep(request: AgentStepRequest, context: AgentStepContext): Promise<AgentStepResult> {
    const key = request.parentStepId ? `${request.runId}:${request.parentStepId}:${request.agent.id}` : `${request.runId}:${request.nodeId}`;
    const visit = (this.visits.get(key) ?? 0) + 1;
    this.visits.set(key, visit);
    const role = roleOf(request);
    const topic = topicOf(request.prompt);

    context.activity({ kind: "progress", message: `${request.agent.name} liest den Kontext` });
    context.activity({ kind: "tool", tool: "read", status: "called", input: { filePath: "README.md" } });
    await this.wait(400, context.signal);
    context.activity({ kind: "tool", tool: "read", status: "succeeded" });
    for (const chunk of narrative(role, topic, visit)) {
      context.activity({ kind: "text", text: chunk });
      await this.wait(350, context.signal);
    }

    if (request.delegation && !request.parentStepId) {
      const allowed = request.delegation.allowed.map((a) => a.id);
      const pick = (i: number) => allowed[i % allowed.length] ?? allowed[0] ?? "";
      const first = await context.delegate([
        { agent: pick(0), task: `Wie ist der bestehende Code rund um „${topic}“ aufgebaut? Nenne Dateien und Einstiegspunkte.` },
        { agent: pick(1), task: `Welche Doku und Konventionen gelten für „${topic}“?` },
        { agent: pick(0), task: `Welche Tests decken „${topic}“ bisher ab?` },
      ]);
      context.activity({ kind: "progress", message: `Welle ${first.wave}: ${first.results.length} Ergebnisse` });
      if (!first.budgetExhausted) await context.delegate([{ agent: pick(0), task: `Offene Frage aus Welle 1: Welche Randfälle gibt es bei „${topic}“?` }]);
    }

    const writable = !request.workspace.readOnly && request.agent.permissions.preset !== "read-only";
    if (writable && this.options.writeFiles !== false) {
      const files = filesFor(role, topic, visit);
      for (const [path, content] of Object.entries(files)) {
        context.activity({ kind: "tool", tool: "edit", status: "called", input: { filePath: path } });
        if (this.options.io?.workspace) this.options.io.workspace.writeByPath(request.workspace.path, path, content);
        else writeFile(join(request.workspace.path, path), content);
        await this.wait(250, context.signal);
        context.activity({ kind: "tool", tool: "edit", status: "succeeded" });
      }
    }
    for (const doc of request.documents) {
      if (doc.access === "read" || this.options.writeFiles === false) continue;
      const content = documentFor(doc.name, role, topic, visit);
      if (this.options.io?.documents) {
        this.options.io.documents.writeByPath(doc.path, content);
      } else {
        const previous = existsSync(doc.path) ? readFileSync(doc.path, "utf8") : "";
        writeFile(doc.path, doc.access === "append" ? `${previous}${previous ? "\n" : ""}${content}` : content);
      }
      context.activity({ kind: "tool", tool: "write", status: "succeeded", input: { filePath: doc.name } });
    }

    await this.wait(300, context.signal);
    const handoff = this.handoff(request, role, topic, visit);
    const votes = request.votes > 1 ? Array.from({ length: request.votes }, (_, i) => ({ ...handoff, branch: i === request.votes - 1 && request.votes > 2 ? altBranch(request.handoffSchema, handoff.branch) : handoff.branch })) : undefined;
    return { sessionId: `sim_${request.stepId}`, handoff, ...(votes ? { votes } : {}), usage: { inputTokens: 1800 + request.prompt.length, outputTokens: 600 } };
  }

  private handoff(request: AgentStepRequest, role: Role, topic: string, visit: number): Record<string, unknown> & { branch?: string } {
    const props = (request.handoffSchema.properties ?? {}) as Record<string, JsonSchema>;
    const rejecting = role === "review" && this.options.rejectFirst !== false && visit === 1 && /security/i.test(request.agent.id);
    const out: Record<string, unknown> & { branch?: string } = { summary: summaryFor(role, request.agent.name, topic, visit, rejecting) };
    if (props.branch) {
      const options = (props.branch.enum ?? []) as string[];
      const fixed = this.options.choices?.[request.nodeId];
      out.branch = fixed && options.includes(fixed) ? fixed : rejecting ? (options.find((o) => /reject|nicht|nok|failed/.test(o)) ?? options[0]) : (options.find((o) => /approve|ok|mittel|freigegeben/.test(o)) ?? options[0]);
      out.branchReason = rejecting ? "Ein Befund mit Schweregrad hoch ist offen." : "Die Kriterien des Zweigs sind erfüllt.";
    }
    if (props.output) {
      out.output = sampleFromSchema(props.output, {
        approved: !rejecting,
        findings: rejecting ? [{ severity: "high", file: `src/${slugify(topic)}.js`, line: 4, message: "Token wird im Klartext geloggt" }] : [],
        tasks: [`Datenmodell für ${topic}`, `API-Endpunkt für ${topic}`, `Tests für ${topic}`],
        gaps: [],
        openQuestions: [],
      });
    }
    if (props.selectedCandidate) {
      const candidates = (props.selectedCandidate.enum ?? []) as string[];
      out.selectedCandidate = candidates[1] ?? candidates[0];
      out.summary = `Kandidat ${String(out.selectedCandidate)} ist am einfachsten und am besten getestet.`;
    }
    out.handoff = role === "plan" ? "Details stehen in plan.md." : `Bitte auf ${topic} achten.`;
    return out;
  }
}

type Role = "plan" | "implement" | "review" | "docs" | "research" | "triage" | "decide" | "other";

function roleOf(request: AgentStepRequest): Role {
  const id = request.agent.id;
  const tags = request.agent.tags.join(" ");
  if (/plan|architect/.test(id)) return "plan";
  if (/review|verifier/.test(id) || /review/.test(tags)) return "review";
  if (/implement|fixer|analyst|refactor/.test(id)) return "implement";
  if (/document/.test(id)) return "docs";
  if (/explorer|research/.test(id)) return "research";
  if (/evaluator|triage/.test(id)) return "triage";
  if (/decider/.test(id)) return "decide";
  return "other";
}

function topicOf(prompt: string): string {
  const match = /## Auftrag des Nutzers\n\n([^\n]+)/.exec(prompt) ?? /^([^\n#][^\n]*)/m.exec(prompt);
  return (match?.[1] ?? "Feature").replace(/[.:]$/, "").slice(0, 60);
}

function narrative(role: Role, topic: string, visit: number): string[] {
  const again = visit > 1 ? " (Nachbesserung)" : "";
  switch (role) {
    case "plan":
      return [`Ich analysiere „${topic}“ und zerlege es in überprüfbare Schritte.`, "Plan mit Akzeptanzkriterien steht."];
    case "implement":
      return [`Ich setze „${topic}“ um${again}.`, "Implementierung und Tests geschrieben."];
    case "review":
      return [`Ich prüfe die Änderungen zu „${topic}“.`, "Befunde dokumentiert."];
    case "research":
      return [`Ich untersuche den Code zu „${topic}“.`];
    case "docs":
      return ["Ich dokumentiere die Änderungen."];
    default:
      return [`Ich bearbeite „${topic}“.`];
  }
}

function summaryFor(role: Role, name: string, topic: string, visit: number, rejecting: boolean): string {
  switch (role) {
    case "plan":
      return `Plan für „${topic}“ mit 3 Teilschritten und Akzeptanzkriterien erstellt.`;
    case "implement":
      return visit > 1 ? `Befunde behoben: Logging bereinigt, Tests ergänzt (Durchlauf ${visit}).` : `„${topic}“ umgesetzt: Service, Endpunkt und Tests.`;
    case "review":
      return rejecting ? `${name}: 1 Befund (hoch) – Token wird geloggt.` : `${name}: keine Befunde mit Schweregrad ≥ medium.`;
    case "docs":
      return "Doku und Changelog-Eintrag ergänzt.";
    case "research":
      return `Relevante Stellen zu „${topic}“ gefunden.`;
    case "triage":
      return `Mittlere Aufgabe: mehrere Module betroffen.`;
    default:
      return `${name} hat „${topic}“ bearbeitet.`;
  }
}

function filesFor(role: Role, topic: string, visit: number): Record<string, string> {
  const slug = slugify(topic) || "feature";
  const name = slug.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  if (role === "docs") return { [`docs/${slug}.md`]: `# ${topic}\n\nDieses Feature wurde mit AiFlow umgesetzt.\n\n## Nutzung\n\n\`\`\`ts\nimport { ${name} } from "../src/${slug}";\n\`\`\`\n` };
  if (role !== "implement") return {};
  const log = visit > 1 ? "" : `  console.log("token", token);\n`;
  return {
    [`src/${slug}.js`]: `/** ${topic} */\nexport function ${name}(request, token) {\n${log}  if (!String(request.email ?? "").includes("@")) return { ok: false };\n  return { ok: token.length > 0 };\n}\n`,
    [`test/${slug}.test.js`]: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${name} } from "../src/${slug}.js";\n\ntest("${topic.replace(/"/g, "")}", () => {\n  assert.equal(${name}({ email: "a@b.de" }, "t").ok, true);\n  assert.equal(${name}({ email: "kaputt" }, "t").ok, false);\n});\n`,
  };
}

function documentFor(name: string, role: Role, topic: string, visit: number): string {
  if (name.startsWith("plan")) return `# Plan: ${topic}\n\n## Teilschritte\n1. Datenmodell\n2. API-Endpunkt\n3. Tests\n\n## Akzeptanzkriterien\n- Ungültige E-Mails werden abgelehnt\n- Tokens werden nie geloggt\n`;
  if (name.startsWith("research")) return `# Recherche: ${topic}\n\n- Einstieg: \`src/server.ts\`\n- Konvention: Services unter \`src/\`, Tests unter \`test/\`\n- Randfälle: abgelaufene Tokens, doppelte Anfragen\n`;
  if (name.startsWith("review")) return `- ${role === "review" ? "Review" : "Notiz"} (Durchlauf ${visit}): keine offenen Punkte zu ${topic}.`;
  if (name.startsWith("architecture")) return `# Architektur: ${topic}\n\nModule: api, service, storage.\n`;
  return `# ${name}\n\n${topic}\n`;
}

function altBranch(schema: JsonSchema, current: string | undefined): string | undefined {
  const options = (((schema.properties as Record<string, JsonSchema> | undefined)?.branch?.enum ?? []) as string[]).filter((o) => o !== current);
  return options[0] ?? current;
}


function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
