# Umsetzungsstand (bis M4)

Arbeitsnotizen für die Umsetzung von PLAN.md, Phasen 0–8. Wird nach jedem Schritt aktualisiert.

## Entscheidungen während der Umsetzung
- TypeScript 5.9 statt 7 (typescript-eslint unterstützt < 6.1).
- Node 22 (≥ 22.12) statt 24; Persistenz über das eingebaute `node:sqlite` statt `better-sqlite3` (keine native Abhängigkeit).
- Tests liegen in `packages/*/test`, Vitest löst `@aiflow/*` per Alias auf `src` auf. Typprüfung der Tests über `tsconfig.check.json`.
- Run-Zustand: Event-Log (Historie) + Zustands-Snapshot nach jedem Übergang (Wiederaufnahme). Siehe ADR-002.
- Map-Knoten („Für jedes“) und Sub-Agenten laufen als Unter-Schritte innerhalb eines Schritts (gemeinsamer Sub-Step-Runner).
- `exactOptionalPropertyTypes` vorerst aus (Reibung mit Zod-Optionals); alle anderen strikten Optionen an.
- Simulations-Runtime (`--runtime simulation`) für Demos, Testlauf und E2E; schreibt echte Dateien.
- Ports intern englisch: `next`, `error`; benutzerdefinierte Ports frei.
- MCP-Rechte als versionsneutrale Aktion `mcp` (Ressource = Servername); die Runtime löst sie pro Session mit der Serverliste des Arbeitsverzeichnisses zu `<server>_*`-Regeln auf (Quelle: opencode v1.19.5 `mcp/catalog.ts` `toolName`, v2.2.6 `tool/mcp.ts` `name`; beide werten Muster in Aktionen aus).

## Wichtige Erkenntnisse
- v2-Sessions nutzen den Standard-Agenten; der AiFlow-System-Prompt kommt per `session.hook("context")` aus der Worker-API.
- Plugin-Rolle per `AIFLOW_WORKER=1` (Worker) bzw. ohne (Bridge). Worker-API des Daemons: `/api/worker/sessions/:id/{handoff,delegate,progress,context}`.
- TUI-Teile sind gegen @opencode/plugin/tui 2.2.6 und @opencode-ai/plugin/tui 1.19.5 typgeprüft (`tsconfig.tui.json`), aber nicht in einer echten TUI ausgeführt.

## Fortschritt
- [x] P0 Fundament
- [x] P1 Core (27 Tests, alle Beispiele validieren)
- [x] P2 Engine + Testkit + Store (24 Szenario-Tests, 6 Store-Tests)
- [x] P3 Workspace-git (8 Tests inkl. Integration), Runtime-opencode v1/v2 (10 Tests, gemockte Server), Plugin Worker-Rolle + Runtime-opencode + Plugin (Worker-Rolle)
- [x] P4 Server (Hono, Auth/OTP, Host/Origin-Schutz, SSE, Worker-API), Client, CLI (14 API-Tests); `pnpm check` grün (95 Tests)
- [x] P5 Web I: Agenten-Editor (alle Tabs, Playground), Bausteine, Workflow-Editor (Drag & Drop, Ports, Inspector, Zugriffs-Matrix, Live-Validierung, Testlauf, YAML, Undo/Redo)
- [~] P6 Plugin Bridge-Rolle (v1/v2 Server + TUI geschrieben, typgeprüft gegen echte APIs; 6 Tests; Smoke-Test mit echtem opencode offen)
- [x] P7 Web II: Run-Ansicht (Live-Graph, Gantt, Schritt-Details mit Prompt/Verlauf/Diff), Review (Teil-Übernahme, Änderungen anfordern, Branch), History, Inbox, Dashboard
- [x] P8 Für-jedes, Sub-Workflows, Sub-Agenten (Wellen, Budgets, erzwungen/optional), Stimmen, Simulation, Playground, Stagnationserkennung bei Schleifen
- [x] Tests: 109 Unit/Integration (`pnpm check`), 7 Playwright-E2E (`pnpm test:e2e`)
- [x] MCP-Rechte pro Agent (Standard erlaubt/verboten, Ausnahmen pro Server; Abbildung auf `<server>_*` in v1/v2, harte Prüfung im Plugin; erzwungene Delegation sperrt MCP)
- [x] Konfigurierbar: opencode-Konfigurationsdatei für den Worker (`OPENCODE_CONFIG`) und Datenverzeichnis (CLI-Option, Umgebung, `config.json`, Plugin-Optionen)
- [x] Screenshots: `docs/screenshots` (16 Bilder, `node scripts/screenshots.mjs`)

## Offen
- Smoke-Test mit echtem opencode v1/v2 und Modell (Spikes S1–S10 aus PLAN.md); TUI-Teile nie in einer echten TUI ausgeführt.
