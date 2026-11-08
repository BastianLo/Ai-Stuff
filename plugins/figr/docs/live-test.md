# Live-Test (plan.md 17, Checkliste für M7)

Mit echtem opencode v2, den Beispiel-Agenten (`examples/agent`) und `examples/figr.jsonc`. Protokoll pro Punkt: Datum, opencode-Version, Ergebnis, Auffälligkeiten.

**Stand:** noch nicht durchgeführt (in der Entwicklungsumgebung kein opencode mit Modellzugang). Alle Punkte sind über den FakeHost automatisiert getestet (`test/scenario.test.ts`, `test/patterns/patterns.test.ts`, `test/host/v2.test.ts`).

| # | Prüfung | So prüfen | Ergebnis |
|---|---|---|---|
| 1 | Orchestrator kann nicht editieren | Orchestrator bitten, eine Datei direkt zu ändern | offen |
| 2 | Implementer vor Plan-Abnahme gesperrt, verständliche Meldung | „Implementiere X sofort“ | offen |
| 3 | Review-Gremium mit 2 Reviewern zählt approved/changes korrekt | `figr_review(gate: "plan")`, Sidebar beobachten | offen |
| 4 | Plan ändert sich → Freigabe verfällt | nach Abnahme Plan ändern lassen, `/figr` | offen |
| 5 | Best-of-3 übernimmt den Gewinner | `figr_best_of_n`, `git diff` danach | offen |
| 6 | Stop-Guard schickt nach | Orchestrator vor `implementation` „fertig“ sagen lassen | offen |
| 7 | Eskalationsdialog erscheint | Reviewer, der immer `changes_requested` gibt; 3 Runden | offen |
| 8 | Seitenleiste aktualisiert sich | während Review/Best-of-N | offen |
| 9 | SkillSmith-Tools bleiben nutzbar | `skill_search` im Orchestrator und in Kind-Sessions | offen |

Zusätzlich prüfen (aus den Spikes): Darstellung von `figr.confirm` im Dialog (S7), Kind-Sessions in Worktrees haben die Rechte ihres Agenten (S8), plugin-erzeugte Kinder sind in der TUI sichtbar (S4).
