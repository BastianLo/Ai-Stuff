# Status

## Meilensteine

| | Inhalt | Stand |
|---|---|---|
| M0 | Gerüst, Tooling (aus AiFlow), AGENTS.md, Spikes | erledigt; Spikes gegen Typen geprüft, live offen (`docs/spikes.md`). Statt `figr_ping` gibt es den Adapter-Test gegen einen nachgebauten Kontext. |
| M1 | Konfiguration und Kern | erledigt: Schema (strikt), global+Projekt, `extends`, Validierung gegen Agenten, Watcher; Gate-Automat, Runden, Quorum, Veto, Verfall, Stagnation, `decide`, nächster Schritt, Statustexte |
| M2 | Durchsetzung ohne Muster | erledigt: geführte Sessions, Kind-Zuordnung (Ereignis + lazy), `evaluate` + `execute.before`, Kontext-Hook, `figr_verdict` inkl. direkter Reviewer, Artefakte file/diff/text, Stop-Guard, `figr_status`, `figr_submit`, Persistenz, Audit-Log |
| M3 | Review-Gremium | erledigt: Fan-out-Runner, Checks parallel, Befund-Zusammenführung, Eskalation, menschliche Freigabe |
| M4 | Multi-Plan | erledigt: multi-plan und single, Synthese, Report-Schemas, Konfliktfrage |
| M5 | Best-of-N | erledigt: Worktrees, Übertragung des Arbeitsstands, Checks pro Kandidat, Richter mit harter Grün-Regel, Übernahme ohne halbes Anwenden, Patches, Aufräumen |
| M6 | TUI und Befehle | erledigt: Seitenleiste, Prompt-Zeile, Toasts (über `status.json`), Befehle `/figr`, `/figr on|off`, `-profile`, `-skip`, `-reset`, `-findings` |
| M7 | Doku, Beispiele, Schema | erledigt bis auf den Live-Test: README, Beispiel-Agenten, Presets strict/quick/solo, `figr.schema.json`, `report.md`. Live-Checkliste offen (`docs/live-test.md`), Screenshots offen. |
| M8 | Härtung | teilweise: Wiederaufnahme nach Neustart, Diff-Cache, Kürzung großer Diffs/Ausgaben. Offen: Muster `merge`, Backlog-Muster (11.4). |

`pnpm check`: grün (Typecheck Server + TUI, ESLint strictTypeChecked, dependency-cruiser, Vitest). Abdeckung gesamt ~88 % Anweisungen; Kern ~96 % Anweisungen / ~86 % Zweige (Ziel aus dem Plan: 100 % Zweige im Kern – offen).

## Abweichungen vom Plan

- **Sub-Agent-Sperren nur über `execute.before`**, nicht über `evaluate` (sonst würden gesperrte Agenten aus der Sub-Agent-Liste verschwinden statt mit Begründung abgelehnt zu werden). Edit/Shell über beide Wege.
- **TUI-Zustand über `status.json`** statt `ctx.storage` (TUI-Storage ist laut Typen getrennt; Spike S10 Plan B).
- **Eigene git-Worktrees** statt `ctx.worktree` (S8 Plan B).
- **`pattern: "single"`** ist für Plan-Gates (`artifact.type: file`, über `figr_plan`) und für Code-Gates (`diff`, direkter Aufruf des Agenten) erlaubt – so steht es auch im Profil `quick` aus 6.2.
- **Kurz-IDs** der Versionen: erster Buchstabe des Gates + Zähler (`p1`, `i1`, …).
- **Texte**: Sperrmeldungen und Statustexte deutsch, Systemblöcke und Prompts englisch (14.2). Eine eigene Textsammlung `util/text.ts` gibt es nicht; die Texte stehen an ihrer Verwendungsstelle.
- **Shell-Allowlist**: Verkettete Befehle werden pro Segment geprüft; Umleitungen, `$(…)`, Backticks und `&` gelten als nicht prüfbar und werden abgelehnt.
- **Evidence `check`** wird beim Stop-Guard und bei `figr_status` ausgeführt (nicht bei jeder Statusberechnung).

## Bekannte Grenzen

- Nicht live getestet (siehe oben).
- `figr.confirm` wird automatisch bestätigt, wenn der Orchestrator-Agent pauschal `*` erlaubt. Beispiel-Agent setzt die Aktion explizit auf `ask`.
- Background-Sub-Agenten zählen erst als Nachweis, wenn ihr Ergebnis als `completed` zurückkommt.
