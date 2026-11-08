# Spikes (plan.md 17)

**Stand:** In der Entwicklungsumgebung gab es kein lauffähiges opencode v2 mit Modellzugang. Alle Spikes sind deshalb **gegen die Typen von `@opencode/plugin` / `@opencode/client` 2.2.6 geprüft** (Typecheck des Adapters gegen die echten Typen, Adapter-Test mit nachgebautem Kontext), aber **nicht live**. Wo die Annahme unsicher ist, hat die Umsetzung den Plan B gleich mit eingebaut.

| # | Frage | Umsetzung / Absicherung | Live offen |
|---|---|---|---|
| S1 | `permission.hook("evaluate")` für edit/shell/subagent, kommt `message` an? | `evaluate` sperrt **edit/write/patch** und **shell/bash** (Orchestrator, Reviewer). Zusätzlich prüft `tool.hook("execute.before")` dieselben Regeln über `decide()` (Plan B gleich aktiv). **Änderung nach Prüfung:** `subagent` wird **nicht** in `evaluate` gesperrt, weil opencode dieselbe Auswertung nutzt, um die Liste sichtbarer Sub-Agenten zu bilden – gesperrte Phase-Agenten wären sonst unsichtbar statt mit Begründung abgelehnt. Sub-Agent-Regeln laufen nur über `execute.before`. | ja |
| S2 | Bricht `throw` in `execute.before` ab, sieht das Modell die Meldung? | Wird genutzt (Text beginnt mit „FiGr:“). | ja |
| S3 | Kind-Sessions per `session.create({ parentID, agent, location })`, `prompt`, `wait` | Fan-out-Runner nutzt genau das. Fällt `wait` aus, kann der Port in `host/v2.ts` auf das Idle-Ereignis umgestellt werden. Fehlt nach `wait` das Ergebnis, fordert der Runner selbst per `prompt` nach (geteilter Zähler mit dem Idle-Hook, max. 2). | ja |
| S4 | Erscheinen plugin-erzeugte Kinder in der TUI wie Sub-Agenten? | Gleicher Mechanismus (`parentID`); Status zusätzlich in der Seitenleiste. | ja |
| S5 | `session.hook("context")`: Tools ausblenden, Eingabeschema setzen | Genutzt (`Reflect.deleteProperty(event.tools, …)`, `event.tools.figr_report.input = …`). Zusätzlich lehnen die Tools selbst ab, wenn die Rolle nicht passt. | ja |
| S6 | `session.synthetic(delivery: "queue")` im Idle-Hook setzt die Session fort? | Genutzt für Stop-Guard und Nachforderungen. | ja |
| S7 | `permission.assert` zeigt Dialog; Freitext bei Ablehnung? | Aktion `figr.confirm`, Titel/Detail in `metadata`. Ablehnung mit Feedback → `Tool.Error` → Text geht an den Orchestrator; einfache Ablehnung → „nicht freigegeben“. | ja (Darstellung von `metadata` im Dialog) |
| S8 | `ctx.worktree.create` oder eigenes `git worktree`? | **Eigenes** `git worktree add --detach` (Plan B), unabhängig von `projectID`. Arbeitsstand wird per Patch übertragen und als Basis-Commit im Worktree festgehalten. | Rechte der Kind-Session mit `location.directory` im Worktree |
| S9 | `ctx.storage` über Neustarts, pro Projekt? | Zustand unter `figr/session/<id>` (Session-IDs sind global eindeutig). Wiederaufnahme getestet mit In-Memory-Storage. | ja |
| S10 | Sehen TUI- und Server-Teil denselben Zustand? | **Plan B umgesetzt:** Der TUI-Storage ist laut Typen ein eigener Speicher. Der Server schreibt deshalb `workDir/<sid>/status.json`, die TUI liest die Datei (1 s Takt) für die Root-Session der angezeigten Session. Slots: `sidebar.content`, `prompt.footer.status`. | ja |
| S11 | `session.created` mit `parentID` vor dem ersten Tool des Kindes? | Ereignis wird genutzt (enthält laut Typ auch `agent`); Fallback: lazy über `session.get` in jedem Hook. | ja |

Die Live-Checkliste steht in `docs/live-test.md`.
