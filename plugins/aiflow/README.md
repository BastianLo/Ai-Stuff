# AiFlow

Workflows aus KI-Agenten für opencode: Agenten frei definieren, per Drag & Drop zu Workflows verbinden (Verzweigung, parallel, Zusammenführung, Schleifen, Sub-Agenten), aus der Web-UI oder per `/aiflow-wf-NAME [prompt]` in opencode starten und das Ergebnis wie einen Pull Request prüfen.

AiFlow ist eine eigenständige TypeScript-Anwendung (Daemon + Web-UI auf Port 5739). Das opencode-Plugin (`opencode-aiflow`, v1 und v2) ist nur die Brücke: Commands, Live-Übersicht in der TUI und Worker-Rolle für die Agenten-Sessions. Architektur und Begründungen: [PLAN.md](PLAN.md), Stand: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Schnellstart

```bash
pnpm install && pnpm build
node packages/cli/dist/index.js serve                       # echte Runtime (opencode)
node packages/cli/dist/index.js serve --runtime simulation  # ohne LLM, für Demo und Tests
node packages/cli/dist/index.js open                        # Einmal-Login-Link im Browser öffnen
node packages/cli/dist/index.js setup opencode              # Plugin in opencode eintragen
node packages/cli/dist/index.js doctor                      # Umgebung prüfen
```

Weitere Befehle: `run <workflow> "<prompt>" --follow`, `runs`, `workflows`, `agents`, `inbox`, `status`, `stop`, `config`.

## Konfiguration

Zwei Einstellungen lassen sich dauerhaft setzen. Sie landen in `~/.config/aiflow/config.json`:

```bash
aiflow config set opencodeConfig ~/.config/opencode.jsonc   # opencode-Konfiguration für die Agenten
aiflow config set dataDir ~/aiflow-daten                     # Datenbank, Worktrees, Dokumente, Logs
aiflow config                                                # wirksame Werte anzeigen
```

Vorrang: Aufruf-Option (`--opencode-config`, `--data-dir`) > Umgebung (`AIFLOW_OPENCODE_CONFIG`, `AIFLOW_DATA_DIR`) > `config.json` > Standard (`~/.local/share/aiflow`). Das Auth-Token bleibt immer in `~/.config/aiflow`.

Startet das opencode-Plugin den Daemon automatisch, gibt es dieselben Werte als Plugin-Optionen weiter:

```jsonc
// opencode v1: "plugin", opencode v2: "plugins" mit { "package": …, "options": … }
"plugin": [["opencode-aiflow", { "url": "http://127.0.0.1:5739", "opencodeConfig": "~/.config/opencode.jsonc", "dataDir": "~/aiflow-daten" }]]
```

`opencodeConfig` wird dem Agent-Worker als `OPENCODE_CONFIG` übergeben (opencode v1 und v2). opencode lädt die Datei **zusätzlich** zur globalen Konfiguration und vor der `opencode.json` des Projekts. Das AiFlow-Plugin muss in einer dieser Dateien eingetragen sein, damit die Worker-Rolle aktiv ist. `aiflow setup opencode` schreibt den Eintrag in die konfigurierte Datei.

## Agenten-Sessions und MCP

Jeder Agent-Schritt ist eine normale opencode-Session im Worker. Sie wird im gewöhnlichen opencode-Speicher abgelegt, mit dem Titel `AiFlow · <Knoten>`, den Metadaten `aiflowRunId`/`aiflowStepId` und dem Run-Worktree als Verzeichnis. Werkzeuge, die opencode-Sessions auswerten, sehen diese Sessions also auch.

Die MCP-Server aus der opencode-Konfiguration stehen den Agenten zur Verfügung. Pro Agent (Editor → „MCP & Skills“) gilt:

- **Nicht aufgeführte Server**: erlaubt (Standard) oder verboten (dann nur ausdrücklich freigegebene Server).
- **Pro Server**: erlauben oder verbieten; ein Verbot schlägt eine Erlaubnis.
- **Erzwungene Delegation** an Sub-Agenten sperrt auch MCP-Tools (außer `mcp` steht in `keepTools`).

Die Regeln werden auf die Tool-Namen `<server>_*` abgebildet (gleiches Schema in opencode v1 und v2). Gesetzt werden sie als Session-Rechte und zusätzlich hart im Plugin geprüft. Die Serverliste enthält auch die projektlokale Konfiguration des Arbeitsverzeichnisses.

## Entwicklung

| Befehl | Zweck |
| --- | --- |
| `pnpm check` | Typecheck, Lint, Paketgrenzen, 109 Unit-/Integrationstests |
| `pnpm test:e2e` | 7 Playwright-Tests gegen Daemon mit Simulations-Runtime |
| `node scripts/screenshots.mjs` | Screenshots neu erzeugen (nach `pnpm build`) |

Regeln für Beiträge (auch durch KI-Agenten): [AGENTS.md](AGENTS.md).

## Screenshots

Alle Bilder entstehen mit der Simulations-Runtime am Demo-Projekt.

| | |
| --- | --- |
| **Übersicht** ![](docs/screenshots/01-dashboard.png) | **Workflow-Editor** ![](docs/screenshots/02-workflow-editor.png) |
| **Zusammenführung mit Veto-Abstimmung** ![](docs/screenshots/03-editor-join-inspector.png) | **Agent-Knoten mit Sub-Agenten** ![](docs/screenshots/04-editor-subagents.png) |
| **Run live: parallele Reviews** ![](docs/screenshots/05-run-live-parallel-reviews.png) | **Schritt-Details: Veto → Schleife** ![](docs/screenshots/06-run-step-detail-veto.png) |
| **Exakter Prompt eines Schritts** ![](docs/screenshots/07-run-exact-prompt.png) | **Sub-Agenten in Wellen** ![](docs/screenshots/08-run-subagents-waves.png) |
| **Review: Abschlussbericht** ![](docs/screenshots/09-review-report.png) | **Review: Diff, Teil-Übernahme** ![](docs/screenshots/10-review-diff.png) |
| **Inbox: Freigabe** ![](docs/screenshots/11-inbox-approval.png) | **Testlauf ohne LLM** ![](docs/screenshots/12-editor-simulation.png) |
| **Agenten-Editor: Rechte** ![](docs/screenshots/13-agent-editor-permissions.png) | **Agenten-Bibliothek** ![](docs/screenshots/14-agent-library.png) |
| **Run-History** ![](docs/screenshots/15-run-history.png) | **Dunkles Design** ![](docs/screenshots/16-editor-dark.png) |
