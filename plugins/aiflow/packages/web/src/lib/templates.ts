import type { AgentInput } from "@aiflow/core";

/** Rollen-Vorlagen (PLAN.md 7.4). Werden beim Anlegen kopiert und gehören dann dem Nutzer. */
export const TEMPLATES: (AgentInput & { id: string; name: string; description: string })[] = [
  { id: "analyst", name: "Anforderungs-Analyst", description: "Präzisiert den Auftrag, listet Annahmen und offene Fragen.", permissions: { preset: "read-only", questions: true } },
  { id: "evaluator", name: "Evaluator / Triage", description: "Klassifiziert Aufgaben nach Größe, Risiko oder Bereich.", decision: { votes: 3 } },
  { id: "architect", name: "Architekt", description: "Entwirft Struktur, Schnittstellen und Datenmodell." },
  { id: "planner", name: "Planner", description: "Zerlegt in Teilschritte mit Akzeptanzkriterien.", output: { type: "json", schema: { type: "object", required: ["tasks"], properties: { tasks: { type: "array", items: { type: "string" } } } } } },
  { id: "implementer", name: "Implementer", description: "Setzt um, schreibt Tests, hält sich an den Plan.", permissions: { preset: "implement" }, contextMode: "resume" },
  { id: "test-writer", name: "Test-Writer", description: "Schreibt Tests vorab oder ergänzend.", permissions: { preset: "implement" } },
  { id: "debugger", name: "Debugger / Fixer", description: "Reproduziert Fehler, findet die Ursache, behebt minimal.", permissions: { preset: "implement" } },
  { id: "security-reviewer", name: "Security-Reviewer", description: "Prüft auf OWASP-Risiken, Secrets, Injection, AuthZ.", output: { type: "json", schema: { type: "object", required: ["approved", "findings"], properties: { approved: { type: "boolean" }, findings: { type: "array", items: { type: "object" } } } } } },
  { id: "verifier", name: "Verifier", description: "Prüft Akzeptanzkriterien gegen die Umsetzung.", output: { type: "json", schema: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" }, gaps: { type: "array", items: { type: "string" } } } } } },
  { id: "decider", name: "Decider / Judge", description: "Wählt unter Kandidaten mit Begründung." },
  { id: "documenter", name: "Documenter", description: "Schreibt Doku, Changelog und Commit-Text.", permissions: { preset: "implement" } },
  { id: "research-orchestrator", name: "Recherche-Orchestrator", description: "Delegiert Teilfragen in Wellen an Explorer.", subagents: { enabled: true, allowed: ["code-explorer"], mode: "enforced" } },
];
