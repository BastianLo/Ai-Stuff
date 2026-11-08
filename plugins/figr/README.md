# FiGr – Fixed Guardrails für opencode v2

FiGr ist ein opencode-v2-Plugin für Orchestrator-Workflows. Der Orchestrator delegiert weiter frei an seine Sub-Agenten. FiGr **setzt dabei Regeln durch**:

- **Abnahmen durch Reviewer**: Ein Gate (z. B. `plan`, `implementation`) gilt erst als erfüllt, wenn genug Reviewer per `figr_verdict` zugestimmt haben. Ein „LGTM“ im Text zählt nicht. Optional mit Veto, Checks (`npm test`) und menschlicher Freigabe.
- **Reihenfolgen**: Ohne abgenommenen Plan kein Implementer, ohne abgenommene Implementierung kein „fertig“.
- **Freigaben gelten pro Version**: Ändert sich Plan oder Code, verfällt die Freigabe.
- **Muster als Tools**: `figr_review` (Review-Gremium), `figr_plan` (mehrere Planer + Synthese), `figr_best_of_n` (N Implementer in git-Worktrees, Richter, Übernahme).
- **Der Orchestrator ändert nichts selbst**: `edit`/`write`/`patch` gesperrt, Shell nur per Allowlist.
- **Stop-Guard**: Meldet der Orchestrator zu früh „fertig“, schickt FiGr eine Fortsetzung mit den offenen Gates.

Alles bleibt in opencode: Sub-Agenten sind normale Kind-Sessions, Rückfragen kommen als normale Freigabedialoge, der Status steht in der Seitenleiste.

## Schnellstart

1. Plugin eintragen (`opencode.json` im Projekt), lokal über den Pfad:

   ```json
   { "plugins": [{ "package": "/pfad/zu/plugins/figr", "options": { "profile": "strict" } }] }
   ```

   Abhängigkeiten einmal installieren: `cd plugins/figr && pnpm install`.

2. Beispiel-Agenten kopieren (oder eigene verwenden):

   ```sh
   mkdir -p .opencode/agent && cp plugins/figr/examples/agent/*.md .opencode/agent/
   ```

3. Konfiguration anlegen:

   ```sh
   cp plugins/figr/examples/figr.jsonc .opencode/figr.jsonc
   ```

4. `.opencode/figr/` in `.gitignore` aufnehmen (FiGr legt dort Plan, Patches, Log und Bericht ab).

5. opencode starten und den Agenten `orchestrator` wählen. Ab jetzt ist die Session geführt.

Ohne `figr.jsonc` ist FiGr inaktiv und meldet das bei `/figr`.

## Konfiguration

`.opencode/figr.jsonc` (Projekt) überschreibt `~/.config/opencode/figr.jsonc` (global). Objekte werden tief zusammengeführt, Arrays ersetzt. Unbekannte Schlüssel sind Fehler. Änderungen werden ohne Neustart übernommen; bei Fehlern bleibt die letzte gültige Konfiguration aktiv. Das JSON-Schema liegt in `figr.schema.json`.

```jsonc
{
  "orchestrators": ["orchestrator"],     // primäre Agenten, deren Sessions FiGr führt
  "defaultProfile": "strict",
  "profiles": {
    "strict": {
      "gates": {
        "research": { "evidence": { "subagents": { "agents": ["explore"], "min": 2 } } },
        "plan": {
          "requires": ["research"],
          "artifact": { "type": "file", "path": "plan.md" },
          "produce": { "pattern": "multi-plan", "planners": ["planner-a", "planner-b"], "synthesizer": "plan-synthesizer" },
          "agents": ["planner"],
          "approve": { "reviewers": ["architect-reviewer", "security-reviewer"], "quorum": "all", "veto": true, "maxRounds": 3 }
        },
        "implementation": {
          "requires": ["plan"],
          "artifact": { "type": "diff" },
          "produce": { "pattern": "best-of-n", "agent": "implementer", "n": 3, "judge": "code-judge", "checks": ["npm test"] },
          "agents": ["implementer"],
          "approve": { "reviewers": ["standards-reviewer"], "checks": ["npm test"] }
        },
        "done": { "requires": ["implementation"], "final": true }
      }
    },
    "quick": { "extends": "strict", "gates": { "plan": { "produce": { "pattern": "single", "agent": "planner" } } } }
  }
}
```

| Gate-Schlüssel | Bedeutung |
|---|---|
| `requires` | Gates, die vorher erfüllt sein müssen. Bis dahin sind die Phase-Agenten des Gates gesperrt. |
| `evidence` | Erfüllt durch Nachweise: `subagents` (mind. *n* erfolgreiche Läufe aus einer Liste), `file` (Datei existiert), `check` (Befehl grün). |
| `artifact` | Was abgenommen wird: `file` (Pfad relativ zu `workDir/<session>` oder `root: "project"`), `diff` (Code-Stand gegen HEAD beim Start, inkl. neuer Dateien; `ignore` für Build-Artefakte), `text` (per `figr_submit`). |
| `produce` | Erzeugungsmuster: `multi-plan`, `single`, `best-of-n`. Mit `enforce: true` ist der direkte Aufruf des Phase-Agenten gesperrt. |
| `agents` | Phase-Agenten des Gates (dürfen das Artefakt ändern). |
| `approve` | `reviewers`, `quorum` (`all` \| `majority` \| Zahl), `veto`, `maxRounds`, `checks`, `human`, `invalidateOnChange`, `rubric`. |
| `final` | Die Session darf erst enden, wenn dieses Gate erfüllt ist. |

Regeln pro Profil (`rules`): `orchestrator.mayEdit`, `orchestrator.shell.allow`, `orchestrator.maxDirectSubagentsPerTurn`, `subagents.maxParallel`, `subagents.maxTotal`, `stopGuard.enabled`/`maxNudges`/`respectQuestions`, `stagnation.enabled`.

Mitgelieferte Profile in `examples/figr.jsonc`: **strict** (volle Leitplanken), **quick** (ein Planer, ein Reviewer, kein Best-of-N), **solo** (nur „Orchestrator ändert nicht“ und Stop-Guard).

## Werkzeuge

| Tool | Für | Zweck |
|---|---|---|
| `figr_status` | Orchestrator | Gates, Versionen, Freigaben, offene Befunde, nächster Schritt |
| `figr_plan` | Orchestrator | Planer parallel → Synthesizer → `plan.md` |
| `figr_review` | Orchestrator | Review-Gremium für die aktuelle Version, inkl. Checks |
| `figr_best_of_n` | Orchestrator | N Kandidaten in Worktrees, Checks, Richter, Übernahme |
| `figr_submit` | Orchestrator | Text-Artefakt einreichen bzw. Plan-Datei aus Text anlegen |
| `figr_verdict` | Reviewer | strukturiertes Urteil (`approved` / `changes_requested` / `rejected` + Befunde) |
| `figr_report` | Kinder der Muster | strukturiertes Ergebnis (Planer, Synthesizer, Kandidat, Richter) |

Jede Session sieht nur die Tools ihrer Rolle. Reviewer können auch direkt per `subagent` gestartet werden: FiGr erkennt sie, hängt Gate und Version an den Auftrag an und zählt ihr `figr_verdict`. Fremde Tools (z. B. SkillSmith) und nicht konfigurierte Sub-Agenten bleiben unberührt.

## Befehle

| Befehl | Wirkung |
|---|---|
| `/figr` | Status als Nachricht, schreibt `workDir/<session>/report.md` |
| `/figr on`, `/figr off` | FiGr für die aktuelle Session ein-/ausschalten |
| `/figr-profile <name>` | Profil wechseln |
| `/figr-skip <gate>` | Gate überspringen (Bestätigungsdialog, protokolliert) |
| `/figr-reset <gate>` | Runden, Freigaben und Nachweise eines Gates verwerfen |
| `/figr-findings` | offene Befunde aller Gates |

Rückfragen (Eskalation nach `maxRounds` bzw. Stagnation, `approve.human`, Konflikte bei Multi-Plan, Ende trotz offener Gates) kommen als normaler opencode-Freigabedialog über die Aktion `figr.confirm`. **Ablehnen mit Text** schickt den Text als Anweisung an den Orchestrator. Achtung: Erlaubt eine Regel deines Orchestrator-Agenten pauschal `*`, werden diese Dialoge automatisch bestätigt – setze dann `{ action: "figr.confirm", resource: "*", effect: "ask" }`.

## Ablage

`workDir` (Standard `.opencode/figr`) enthält pro Session:

- `plan.md`, `plans/<planer>.md` – Pläne
- `candidates/<X>.patch` – Patches aller Best-of-N-Kandidaten
- `log.jsonl` – Audit-Log (append-only), `logs/` – volle Check-Ausgaben
- `report.md` – Bericht (bei `/figr` und am Ende)
- `status.json` – Status für die TUI

Der Zustand selbst liegt in opencodes Plugin-Storage (`figr/session/<id>`) und übersteht Neustarts. Laufende Fan-outs gelten nach einem Neustart als abgebrochen; der Status sagt dann „figr_review erneut aufrufen“.

## Entwicklung

```sh
pnpm install
pnpm check      # Typecheck (Server + TUI), ESLint (strictTypeChecked), dependency-cruiser, Vitest
pnpm coverage
pnpm schema     # figr.schema.json neu erzeugen
```

Aufbau: siehe `AGENTS.md` und `plan.md` (Abschnitt 14). Stand und Abweichungen vom Plan: `docs/STATUS.md`. Offene Live-Prüfungen: `docs/spikes.md`, `docs/live-test.md`.
