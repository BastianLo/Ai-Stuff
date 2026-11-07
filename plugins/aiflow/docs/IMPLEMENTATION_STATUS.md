# Umsetzungsstand (bis M4)

Arbeitsnotizen für die Umsetzung von PLAN.md, Phasen 0–8. Wird nach jedem Schritt aktualisiert.

## Entscheidungen während der Umsetzung
- TypeScript 5.9 statt 7 (typescript-eslint unterstützt < 6.1).
- Node 22 (≥ 22.12) statt 24; Persistenz über das eingebaute `node:sqlite` statt `better-sqlite3` (keine native Abhängigkeit).
- Tests liegen in `packages/*/test`, Vitest löst `@aiflow/*` per Alias auf `src` auf. Typprüfung der Tests über `tsconfig.check.json`.
- Run-Zustand: Event-Log (Historie) + Zustands-Snapshot nach jedem Übergang (Wiederaufnahme). Siehe ADR-002.
- Map-Knoten („Für jedes“) und Sub-Agenten laufen als Unter-Schritte innerhalb eines Schritts (gemeinsamer Sub-Step-Runner).
- `exactOptionalPropertyTypes` vorerst aus (Reibung mit Zod-Optionals); alle anderen strikten Optionen an.
- Ports intern englisch: `next`, `error`; benutzerdefinierte Ports frei.

## Fortschritt
- [x] P0 Fundament
- [x] P1 Core (27 Tests, alle Beispiele validieren)
- [x] P2 Engine + Testkit + Store (24 Szenario-Tests, 6 Store-Tests)
- [ ] P3 Workspace-git + Runtime-opencode + Plugin (Worker-Rolle)
- [ ] P4 Server + Client + CLI
- [ ] P5 Web I (Agenten, Workflow-Editor)
- [ ] P6 Plugin Bridge-Rolle (v1/v2, TUI)
- [ ] P7 Web II (Runs, Review, History, Inbox)
- [ ] P8 Für-jedes, Sub-Workflows, Sub-Agenten, Stimmen, Simulation, Playground
- [ ] Tests + Screenshots (docs/screenshots)
