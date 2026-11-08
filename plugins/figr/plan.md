# FiGr – Leitplanken für Orchestrator-Workflows in opencode

> **FiGr** („Fixed Guardrails“) ist ein opencode-v2-Plugin. Es lässt den Orchestrator frei arbeiten und **erzwingt dabei Regeln**: Abnahmen durch mehrere Reviewer, Reihenfolgen, Best-of-N, mehrere Planer mit Abgleich und „mehr Sub-Agenten statt selbst machen“.
>
> Dieses Dokument ist der vollständige Umsetzungsplan. Ein Agent mit frischem Kontext soll danach ohne Rückfragen beginnen können. Lies zuerst Abschnitte 1–4, dann den Meilenstein, an dem du arbeitest (Abschnitt 16).

---

## Inhalt

1. Ziel und Abgrenzung
2. Ausgangslage beim Nutzer
3. Leitideen
4. Begriffe
5. Nutzererlebnis (Beispiele)
6. Konfiguration (`.opencode/figr.jsonc`)
7. Gates: Semantik im Detail
8. Artefakte und Versionen
9. Werkzeuge (Tools) von FiGr
10. Durchsetzung über opencode-v2-Hooks
11. Muster: Review-Gremium, Multi-Plan, Best-of-N
12. TUI
13. Persistenz, Audit, Wiederaufnahme
14. Architektur und Code-Struktur
15. Teststrategie
16. Meilensteine
17. Spikes (vor der Umsetzung prüfen)
18. Risiken und offene Punkte
19. Beispiel-Agenten und Presets
20. Was aus AiFlow wiederverwendet wird
21. Glossar der opencode-v2-API (verifiziert)

---

## 1. Ziel und Abgrenzung

**Ziel:** Ein Orchestrator-Agent delegiert wie bisher frei an Sub-Agenten, die als `.opencode/agent/*.md` definiert sind (planner, implementer, reviewer …). FiGr sorgt dafür, dass dabei verbindliche Regeln eingehalten werden:

- Ein Plan oder eine Implementierung gilt erst als abgenommen, wenn **alle bzw. genug Reviewer zugestimmt** haben. Die Freigabe muss strukturiert sein, nicht als Fließtext.
- **Reihenfolgen**: keine Implementierung ohne abgenommenen Plan, kein „fertig“ ohne abgenommene Implementierung.
- **Muster** sind fest eingebaut und mit einem Tool-Aufruf nutzbar: Review-Gremium, mehrere Planer mit Abgleich, Best-of-N-Implementierung.
- **Mehr Sub-Agenten**: Der Orchestrator darf selbst nicht ändern, und es gelten Mindestanzahlen (z. B. Recherche vor dem Plan).
- Alles bleibt **in opencode**: Sub-Agenten sind normale Kind-Sessions und in der TUI sichtbar, Rückfragen kommen als normale Dialoge, der Status steht in der Seitenleiste.

**Nicht-Ziele:**

- Kein eigener Daemon, keine Web-UI, kein grafischer Workflow-Editor. Das war AiFlow.
- Keine festen Ablaufgraphen. Der Orchestrator entscheidet, wann er was tut. FiGr prüft nur, ob die Regeln erfüllt sind.
- Keine Unterstützung für opencode v1 in Version 1.0. Die Architektur hält v1 als späteren Adapter offen (Abschnitt 14.3).
- Keine eigene Modellverwaltung. Modelle kommen aus den Agent-Dateien.

**Erfolgskriterium:** Ein Nutzer mit Orchestrator-, Planner-, Implementer- und Reviewer-Agenten legt eine `figr.jsonc` an. Ab dann kann der Orchestrator nachweislich nicht mehr:

- ohne abgenommenen Plan implementieren lassen,
- ohne abgenommene Implementierung fertig melden,
- selbst Code ändern.

Dabei bleibt alles in der TUI sichtbar und bedienbar.

---

## 2. Ausgangslage beim Nutzer

- opencode **v2**, hauptsächlich mit DeepSeek V4.1 Flash. Token-Verbrauch ist zweitrangig, Qualität hat Vorrang.
- Agenten liegen als Dateien in `.opencode/agent/*.md`: orchestrator (primary), planner, implementer, reviewer-Varianten usw. (subagent).
- Der Orchestrator bekommt per Prompt gesagt, wie er delegieren soll. Das funktioniert, wird aber nicht **erzwungen**: Er überspringt Reviews, implementiert selbst oder meldet zu früh „fertig“.
- Ein weiteres Plugin (SkillSmith) liefert Tools wie `skill_search` und `memory_search`. FiGr darf fremde Tools nicht einschränken.

---

## 3. Leitideen

1. **Regeln statt Workflows.** FiGr kennt Gates mit Voraussetzungen und Abnahmebedingungen, aber keine Pfeile. Wie der Orchestrator sie erfüllt, bleibt offen.
2. **Durchsetzen an den Stellen, die opencode bietet.** Dazu gehören Rechte-Auswertung (`permission.hook("evaluate")`), Tool-Hooks, der Idle-Hook vor dem Ende einer Ausführung und der Kontext-Hook. Blockiert FiGr etwas, bekommt das Modell eine **präzise Begründung mit nächstem Schritt** und korrigiert sich selbst.
3. **Strukturierte Urteile.** Reviewer geben ihr Urteil über das Tool `figr_verdict` ab. Ein „LGTM“ im Text zählt nicht.
4. **Freigaben gelten für eine bestimmte Version.** Ändert sich der Plan oder der Code nach der Freigabe, verfällt sie (konfigurierbar).
5. **Native opencode-Mittel.** Sub-Agenten laufen als Kind-Sessions (`parentID`), Nutzerentscheidungen über `permission.assert` (normaler TUI-Dialog), Zustand über `ctx.storage`.
6. **Muster als Tools.** `figr_review`, `figr_plan` und `figr_best_of_n` nehmen dem Orchestrator die Mechanik ab: Parallelität, Quorum, Worktrees, Abgleich.
7. **Fail-safe, nicht fail-silent.** Ist eine Regel nicht prüfbar, etwa wegen eines Fehlers, blockiert FiGr mit einer Erklärung. Der Nutzer kann jede Regel per Befehl übersteuern, das wird protokolliert.
8. **Klein und testbar.** Die Kernlogik (Gate-Auswertung, Quorum, Versionen) ist reine Funktion ohne I/O und umfassend getestet.

---

## 4. Begriffe

| Begriff | Bedeutung |
|---|---|
| **Geführte Session** | Session, deren Agent als Orchestrator konfiguriert ist (oder per `/figr on` aktiviert). Nur dort setzt FiGr Regeln durch. |
| **Gate** | Benannter Meilenstein (`plan`, `implementation`, `done` …) mit Voraussetzungen (`requires`), optionalem Erzeuger (`produce`) und Abnahme (`approve`). |
| **Artefakt** | Das, was ein Gate abnimmt: eine Datei (Plan), der Code-Stand (Diff) oder ein freier Text. Hat eine **Version** (Hash). |
| **Urteil (Verdict)** | Strukturierte Bewertung eines Reviewers für Gate + Artefakt-Version: `approved`, `changes_requested` oder `rejected`, mit Befunden. |
| **Runde** | Ein Review-Durchgang für eine Artefakt-Version. Neue Version bedeutet neue Runde. |
| **Quorum** | Wie viele Zustimmungen ein Gate braucht: `all`, `majority` oder eine Zahl. Dazu optional ein Veto, das bei jeder Ablehnung blockiert. |
| **Phase-Agent** | Sub-Agent, der einem Gate zugeordnet ist, z. B. `implementer` zu `implementation`. Ihn aufzurufen setzt voraus, dass `requires` des Gates erfüllt ist. |
| **Fan-out** | FiGr startet mehrere Kind-Sessions parallel (Planer, Reviewer, Best-of-N-Kandidaten). |
| **Profil** | Benannter Regelsatz (z. B. `strict`, `quick`). Pro Session wählbar. |
| **Override** | Bewusstes Übersteuern einer Regel durch den Nutzer (`/figr-skip plan`), immer protokolliert. |

---

## 5. Nutzererlebnis (Beispiele)

### 5.1 Normaler Ablauf mit Profil `strict`

```
Du: Baue Passwort-Reset per E-Mail.
Orchestrator → subagent(explore) ×2        (FiGr-Regel: mind. 2 Recherchen vor dem Plan)
Orchestrator → figr_plan(task)             (3 Planer parallel → Abgleich → .opencode/figr/<sid>/plan.md, Version p1)
Orchestrator → figr_review(gate: "plan")   (architect-reviewer + security-reviewer parallel)
   security-reviewer: changes_requested („Token-Ablauf fehlt“)
Orchestrator → überarbeitet den Plan über den planner → Version p2
Orchestrator → figr_review(gate: "plan")   (Runde 2: beide approved → Gate plan ✔)
Orchestrator → figr_best_of_n(n: 3)        (3 Implementer in Worktrees → Checks → Richter wählt B → wird übernommen)
Orchestrator → figr_review(gate: "implementation")  (standards + test reviewer, plus `npm test` als Check)
Orchestrator: „Fertig.“                    (FiGr lässt das Ende zu, weil done.requires erfüllt ist)
```

Die Seitenleiste in der TUI zeigt dabei:

```
FiGr · strict
✔ research   2/2 Recherchen
✔ plan       p2 · 2/2 Freigaben · Runde 2
▶ implementation  Best-of-3: B gewählt · Review 1/2
○ done
```

### 5.2 Der Orchestrator versucht abzukürzen

- Er ruft `subagent(agent: "implementer")` vor der Plan-Abnahme auf. FiGr lehnt ab:
  > *FiGr: „implementer“ gehört zu Gate „implementation“, das „plan“ voraussetzt. Plan ist nicht abgenommen (0/2 Freigaben). Nächster Schritt: figr_review(gate: "plan").*
- Er versucht selbst `edit` aufzurufen. Abgelehnt:
  > *FiGr: Der Orchestrator ändert keine Dateien. Delegiere an implementer (nach Plan-Abnahme).*
- Er antwortet „Fertig!“, obwohl `implementation` offen ist. Der Idle-Hook schickt automatisch nach:
  > *FiGr: Noch nicht fertig. Offen: implementation (Review 0/2). Nächster Schritt: figr_review(gate: "implementation").*

  Das passiert höchstens `stopGuard.maxNudges`-mal. Danach fragt FiGr den Nutzer.

### 5.3 Freiheit bleibt erhalten

- Der Orchestrator kann Reviewer auch direkt mit `subagent(agent: "security-reviewer", …)` starten. FiGr erkennt, dass das ein Reviewer des Gates `plan` ist, und zählt dessen `figr_verdict`.
- Nicht konfigurierte Sub-Agenten (Explorer, Doku-Agenten) und fremde Tools (SkillSmith) sind unberührt.
- Der Nutzer kann jederzeit `/figr-skip plan` (protokolliert), `/figr-profile quick` oder `/figr off` verwenden.

### 5.4 Eskalation an den Nutzer

Nach `approve.maxRounds` erfolglosen Runden, bei Stagnation (gleiche Befunde zweimal) oder wenn `approve.human: true` gilt, fragt FiGr dich per normalem opencode-Freigabedialog (`permission.assert`):

> *FiGr: Gate „plan“ nach 3 Runden nicht abgenommen. Offene Befunde: … Trotzdem fortfahren?*

Antwortest du „ablehnen“ mit Text, geht dein Text als Anweisung an den Orchestrator.

---

## 6. Konfiguration (`.opencode/figr.jsonc`)

### 6.1 Orte und Vorrang

1. `~/.config/opencode/figr.jsonc`: global (Profile, Standards)
2. `.opencode/figr.jsonc`: Projekt (überschreibt global, Tiefen-Merge, Arrays werden ersetzt)
3. Plugin-Optionen in `opencode.json`: `{ "plugins": [{ "package": "figr", "options": { "profile": "strict", "config": "pfad" } }] }`

Die Datei wird beim Start und bei Änderung neu geladen (Datei-Watcher, debounced 300 ms). Fehler gehen als Toast in die TUI und ins Log. Bei ungültiger Konfiguration bleibt die letzte gültige aktiv. Gab es noch keine, ist FiGr inaktiv und meldet das deutlich.

### 6.2 Schema (vollständig)

```jsonc
{
  "$schema": "https://…/figr.schema.json",       // M7: JSON-Schema generieren und mitliefern
  "version": 1,
  "defaultProfile": "strict",

  // Welche primären Agenten werden geführt? (Sessions mit diesem Agenten)
  "orchestrators": ["orchestrator"],

  // Wo FiGr seine Artefakte ablegt (relativ zum Projekt); pro Session ein Unterordner <sessionID>
  "workDir": ".opencode/figr",

  "profiles": {
    "strict": {
      "gates": {
        "research": {
          "description": "Codebasis verstehen, bevor geplant wird",
          "evidence": { "subagents": { "agents": ["explore", "code-explorer"], "min": 2 } }
        },
        "plan": {
          "requires": ["research"],
          "artifact": { "type": "file", "path": "plan.md" },          // relativ zu workDir/<sid>
          "produce": { "pattern": "multi-plan", "planners": ["planner-a", "planner-b", "planner-c"], "synthesizer": "plan-synthesizer" },
          "agents": ["planner", "planner-a", "planner-b", "planner-c", "plan-synthesizer"],
          "approve": {
            "reviewers": ["architect-reviewer", "security-reviewer"],
            "quorum": "all",                 // "all" | "majority" | <zahl>
            "veto": true,                    // jedes rejected blockiert, auch wenn das Quorum erreicht ist
            "maxRounds": 3,
            "human": false,                  // nach den Reviewern zusätzlich den Nutzer fragen
            "invalidateOnChange": true       // neue Artefakt-Version → Freigaben verfallen
          }
        },
        "implementation": {
          "requires": ["plan"],
          "artifact": { "type": "diff" },     // git-Diff des Arbeitsstands gegen die Basis der Session
          "produce": { "pattern": "best-of-n", "agent": "implementer", "n": 3, "judge": "code-judge", "checks": ["npm test"] },
          "agents": ["implementer"],
          "approve": {
            "reviewers": ["standards-reviewer", "test-reviewer", "security-reviewer"],
            "quorum": "all",
            "checks": ["npm run lint", "npm test"],   // müssen grün sein, sonst zählt die Runde als changes_requested
            "maxRounds": 4
          }
        },
        "done": { "requires": ["implementation"], "final": true }
      },
      "rules": {
        "orchestrator": {
          "mayEdit": false,                  // edit/write/patch für den Orchestrator verboten
          "shell": { "allow": ["git status*", "git diff*", "git log*", "ls*"] },  // sonst Shell verboten
          "maxDirectSubagentsPerTurn": null
        },
        "subagents": {
          "maxParallel": 4,                  // FiGr-Fan-outs
          "maxTotal": 60,                    // Budget pro geführter Session
          "independentReviews": true         // Reviewer sehen fremde Urteile derselben Runde nicht
        },
        "stopGuard": { "enabled": true, "maxNudges": 3 },
        "stagnation": { "enabled": true }    // gleiche Befunde in zwei Runden → Eskalation
      }
    },
    "quick": {
      "extends": "strict",
      "gates": {
        "research": { "evidence": { "subagents": { "min": 1 } } },
        "plan": { "produce": { "pattern": "single", "agent": "planner" }, "approve": { "reviewers": ["architect-reviewer"], "quorum": 1 } },
        "implementation": { "produce": { "pattern": "single", "agent": "implementer" }, "approve": { "reviewers": ["standards-reviewer"], "quorum": 1 } }
      }
    }
  }
}
```

### 6.3 Validierung (Fehler mit Pfad und Klartext)

- Alle referenzierten Agenten existieren (`ctx.agent.list()`). Reviewer, Planer und Implementer sind `mode: subagent`. Orchestratoren sind `primary`.
- Kein Zyklus in `requires`. Genau ein Gate mit `final: true`, sonst gilt implizit: Ende erlaubt, wenn alle Gates erfüllt sind.
- `quorum` ist erfüllbar: Eine Zahl darf höchstens so groß sein wie die Anzahl der Reviewer.
- `extends` ohne Zyklus. Unbekannte Schlüssel sind Fehler (strict), damit Tippfehler auffallen.
- Ein Agent darf nicht gleichzeitig Phase-Agent eines Gates und dessen Reviewer sein (Unabhängigkeit). Das ist eine Warnung, kein Fehler.
- Warnung, wenn ein Reviewer-Agent Bearbeitungsrechte hat. Reviewer sollten in ihrer Agent-Datei auf nur lesen stehen (`permissions`).

### 6.4 Gate-Typen in Kurzform

| Schlüssel | Wirkung |
|---|---|
| `requires` | Gates, die erfüllt sein müssen, bevor Phase-Agenten dieses Gates laufen oder es abgenommen werden kann |
| `evidence` | Erfüllt sich durch Nachweise statt Review, z. B. „mind. 2 Sub-Agenten aus Liste X liefen erfolgreich“, „Datei existiert“, „Check grün“ |
| `artifact` | Was abgenommen wird: `file` (Pfad), `diff` (Code-Stand), `text` (vom Orchestrator per `figr_submit` eingereicht) |
| `produce` | Empfohlenes Erzeugungsmuster. Ist `enforce: true` gesetzt, muss das Artefakt über dieses Muster entstehen, z. B. muss Best-of-N genutzt werden. |
| `agents` | Phase-Agenten des Gates |
| `approve` | Reviewer, Quorum, Veto, Runden, Checks, menschliche Freigabe, Verfall bei Änderung |
| `final` | Ende der geführten Session nur, wenn dieses Gate erfüllt ist |

---

## 7. Gates: Semantik im Detail

### 7.1 Zustände eines Gates

```
blocked ──(requires erfüllt)──▶ open ──(Artefakt vorhanden)──▶ in_review ──(Quorum)──▶ passed
   ▲                                                            │
   └──────────────(Voraussetzung verfällt)─────────────── changes_requested / rejected → open (neue Version nötig)
passed ──(Artefakt ändert sich & invalidateOnChange)──▶ in_review (neue Runde) bzw. open
überall ──/figr-skip──▶ skipped (zählt wie passed, Audit-Eintrag)
```

- `evidence`-Gates sind `passed`, sobald der Nachweis erbracht ist. Sie verfallen nicht.
- Verfällt ein Gate, das andere voraussetzen, werden die abhängigen Gates wieder `blocked`. Beispiel: Plan wird nach der Implementierung geändert, dann ist `implementation` wieder `blocked` bis zur neuen Plan-Abnahme. Wurde bereits implementiert, muss das Review erneut laufen.

### 7.2 Runden und Quorum

- Eine Runde gehört zu genau einer Artefakt-Version. Gibt ein Reviewer in einer Runde mehrere Urteile ab, zählt das letzte.
- Auswertung (reine Funktion `evaluateRound`):
  - `veto && any(rejected)` → `rejected`
  - `approvedCount >= required(quorum, reviewers)` und alle Checks grün → `passed`
  - alle Reviewer haben geurteilt, das Quorum ist aber nicht erreicht → `changes_requested`
  - sonst `in_review`
- `required("all") = reviewers.length`, `required("majority") = floor(n/2)+1`, `required(k) = k`.
- **Checks** (`approve.checks`) laufen bei Rundenbeginn bzw. beim ersten Urteil. Das Ergebnis gilt pro Version. Ein roter Check macht die Runde `changes_requested` mit der Check-Ausgabe als Befund (gekürzt auf 4 KB, voller Text im Log).
- **Stagnation**: Ein Fingerprint der normalisierten Befunde einer Runde (Schwere + Text, sortiert, gehasht) ist identisch zur Vorrunde. Dann folgt Eskalation (5.4).
- **maxRounds** überschritten → Eskalation.

### 7.3 Phase-Agenten und Reihenfolge

- Ein Aufruf eines Phase-Agenten (über `subagent`, `figr_plan` oder `figr_best_of_n`) ist nur erlaubt, wenn alle `requires` des Gates `passed` oder `skipped` sind.
- Phase-Agenten dürfen das Artefakt erzeugen bzw. ändern. Danach entsteht eine neue Version, siehe 8.
- Reviewer eines Gates dürfen jederzeit laufen, sobald das Gate nicht `blocked` ist und ein Artefakt existiert.

### 7.4 Ende der geführten Session (Stop-Guard)

- Kurz bevor die Orchestrator-Session idle wird, prüft FiGr, ob das `final`-Gate (bzw. alle Gates) erfüllt ist. Wenn nicht, schickt es eine Fortsetzungsnachricht mit offenen Gates und nächstem Schritt (`session.synthetic`, Zustellung `queue`).
- Höchstens `maxNudges` Fortsetzungen pro Nutzernachricht. Danach fragt FiGr den Nutzer und lässt die Session sonst idle werden, mit Hinweis in der TUI.
- Laufen noch Hintergrund-Sub-Agenten (`background` im Idle-Event), schickt FiGr nichts nach (opencode weckt die Session ohnehin).
- Fragt der Orchestrator den Nutzer etwas (letzte Antwort endet mit einer Frage oder nutzt das `question`-Tool), schickt FiGr nichts nach. Heuristik: konfigurierbar, Standard an.

---

## 8. Artefakte und Versionen

| Typ | Version = | Erzeugung | Hinweise |
|---|---|---|---|
| `file` | SHA-256 des Dateiinhalts (normalisierte Zeilenenden) | Planer/Synthesizer schreiben die Datei. `figr_plan` legt sie an. | Pfad relativ zu `workDir/<sid>/`. Absolute Pfade oder Projektpfade sind erlaubt (`{ "path": "docs/plan.md", "root": "project" }`). |
| `diff` | SHA-256 von `git diff --binary <base>` plus untracked Dateien (Pfad und Inhalt) | Implementer im Arbeitsverzeichnis bzw. Best-of-N | `base` = HEAD beim Start der geführten Session. Liegt in `ctx.storage`. Pfade aus `workDir` sind ausgeschlossen. |
| `text` | SHA-256 des eingereichten Texts | `figr_submit(gate, text)` durch den Orchestrator | Für Gates wie „Akzeptanzkriterien“ |

- Die Version wird **beim Start einer Review-Runde** festgehalten und den Reviewern mitgegeben („Prüfe Version p2“). Urteile tragen die Version, mit der sie gestartet wurden. Urteile auf veraltete Versionen werden verworfen und protokolliert.
- Kurz-IDs für die Anzeige: `p1`, `p2` … pro Gate, hochgezählt bei jeder neuen Version.
- Die Version wird lazy berechnet: beim Review-Start, bei der `requires`-Prüfung, beim Stop-Guard und vor `figr_status`. Bei `diff` ist das gecacht, solange sich das letzte Tool-Ergebnis des Typs edit/write/patch/shell nicht geändert hat (Zähler aus `tool.hook("execute.after")`).

---

## 9. Werkzeuge (Tools) von FiGr

Alle Tools werden über `ctx.tool.transform` registriert. Der Kontext-Hook macht sie **nur den passenden Sessions sichtbar** (Spalte „sichtbar für“). Eingaben werden als JSON-Schema beschrieben und intern validiert. Bei Fehlern gibt das Tool eine klare Meldung an das Modell zurück.

| Tool | Sichtbar für | Zweck |
|---|---|---|
| `figr_status` | Orchestrator | Gates, Zustände, Versionen, offene Befunde, nächster empfohlener Schritt (kurz, max. ~40 Zeilen) |
| `figr_plan` | Orchestrator | Muster „multi-plan“ oder „single“ für das Plan-Gate (11.2) |
| `figr_review` | Orchestrator | Startet das Review-Gremium eines Gates für die aktuelle Artefakt-Version (11.1) |
| `figr_best_of_n` | Orchestrator | Best-of-N-Implementierung (11.3) |
| `figr_submit` | Orchestrator | Reicht ein `text`-Artefakt ein bzw. legt die Plan-Datei aus einem Text an |
| `figr_verdict` | Reviewer-Sessions, deren Agent Reviewer eines Gates ist | Strukturiertes Urteil abgeben |
| `figr_report` | Kind-Sessions von FiGr-Fan-outs (Planer, Kandidaten, Richter, Synthesizer) | Strukturiertes Ergebnis abgeben (je nach Rolle) |

### 9.1 `figr_verdict` (Eingabe)

```jsonc
{
  "verdict": "approved" | "changes_requested" | "rejected",
  "summary": "string (1–3 Sätze)",
  "findings": [{ "severity": "blocker" | "major" | "minor" | "nit", "location": "string?", "message": "string", "suggestion": "string?" }]
}
```

- Gate und Version leitet FiGr aus der Session ab: aus der Review-Runde, die diese Kind-Session gestartet hat, bzw. aus dem `subagent`-Aufruf (10.3). Der Reviewer muss sie nicht kennen.
- `approved` mit `blocker`-Befunden wird abgelehnt („Widerspruch: approved mit Blocker“), damit das Modell korrigiert.
- Ohne `figr_verdict` am Ende schickt der Idle-Hook der Reviewer-Session bis zu 2× nach. Danach zählt das Urteil als `missing`, und die Runde wird dem Orchestrator so gemeldet.

### 9.2 `figr_report` (Eingabe je Rolle)

- Planer: `{ "planPath": "string", "summary": "string", "risks": ["string"], "openQuestions": ["string"] }`
- Synthesizer: `{ "planPath": "string", "decisions": [{ "topic", "chosen", "from": ["planner-a"…], "reason" }], "conflicts": ["string"] }`
- Kandidat (Best-of-N): `{ "summary": "string", "testsRun": ["string"], "knownIssues": ["string"] }`
- Richter: `{ "winner": "A" | "B" | …, "ranking": ["B","A","C"], "reasons": "string", "mergeIdeas": "string?" }`

Das Schema pro Rolle setzt der Kontext-Hook dynamisch (`event.tools.figr_report.input`), wie es AiFlow mit `aiflow_handoff` macht.

---

## 10. Durchsetzung über opencode-v2-Hooks

Alle Hooks prüfen zuerst, ob die Session **geführt** ist (Orchestrator) oder eine **Kind-Session einer geführten Session** (über die `parentID`-Kette, gecacht). Andere Sessions bleiben unverändert.

### 10.1 `permission.hook("evaluate")`: harte Sperren

Hier entscheidet opencode, ob eine Aktion erlaubt ist. FiGr setzt `effect = "deny"` und `message` (laut API vorgesehen). Abgedeckt sind:

| Aktion | Regel |
|---|---|
| `subagent`, Ressource = Agent-ID | Phase-Agent eines Gates mit unerfüllten `requires` → deny mit Begründung und nächstem Schritt. Budget `maxTotal` überschritten → deny. |
| `edit` (und `patch`/`write`, siehe Spike S1) in der Orchestrator-Session | `rules.orchestrator.mayEdit == false` → deny |
| `shell` in der Orchestrator-Session | nicht in `rules.orchestrator.shell.allow` → deny |
| `edit` in Reviewer-Sessions | deny. Reviewer prüfen nur. Zusätzlich zur Agent-Datei, falls die das nicht regelt. |

**Fallback**, falls `evaluate` für eine Aktion nicht ausgelöst wird (Spike S1): `tool.hook("execute.before")` mit `throw`. Beide Wege nutzen dieselbe reine Funktion `decide(action, resource, state, config)`.

### 10.2 `tool.hook("execute.before")`: weiche Lenkung und Erkennung

- `subagent`-Aufrufe erkennen: Agent, Beschreibung, Prompt. Ist der Agent Reviewer eines Gates, wird eine **Review-Bindung** vorbereitet: Gate, aktuelle Version, Runde. Sie wird mit der Kind-Session verknüpft, sobald sie entsteht (10.5).
- Erzwungene Muster (`produce.enforce: true`): Direkter Aufruf des Phase-Agenten über `subagent` wird blockiert mit „nutze figr_best_of_n“.
- Prompt-Anreicherung für Reviewer: An den `subagent`-Prompt wird ein Abschnitt angehängt („Du prüfst Gate plan, Version p2, Artefakt: <Pfad>. Gib dein Urteil mit figr_verdict ab.“). `event.input` ist laut API veränderbar.

### 10.3 `tool.hook("execute.after")`: Nachweise und Versionen

- Erfolgreiche `subagent`-Läufe zählen für `evidence.subagents` (Agent in Liste, Status completed).
- Nach edit/write/patch/shell wird der Diff-Cache invalidiert.
- `figr_verdict` und `figr_report` ändern den Zustand direkt in ihrem `execute`.

### 10.4 `session.hook("context")`: Sichtbarkeit und Status

- Für jede Session werden FiGr-Tools ein- oder ausgeblendet (Tabelle in 9).
- Orchestrator: Ein Systemblock mit dem aktuellen Status wird vorangestellt (kompakt, ~15 Zeilen) und mit den Regeln in einem Satz pro Regel. So weiß das Modell jederzeit, was fehlt, ohne `figr_status` aufrufen zu müssen.
- Reviewer-Kind-Sessions: Systemblock mit Gate, Version, Artefakt-Pfad, Rubrik („Bewerte gegen: …“, aus `approve.rubric`, optional) und Pflicht zu `figr_verdict`. Bei `independentReviews` sehen sie keine anderen Urteile.
- Fan-out-Kind-Sessions: Rollenblock (Planer, Kandidat, Richter, Synthesizer) und das passende `figr_report`-Schema.

### 10.5 Kind-Sessions zuordnen

- Über `ctx.event.subscribe({ types: ["session.created"] })`: Liegt `parentID` in einer geführten Session (oder deren Nachfahren), wird die Kind-Session registriert. Eine offene Review-Bindung desselben Agenten aus 10.2 wird ihr zugeordnet (FIFO pro Agent).
- Fallback: `ctx.session.get({ sessionID })`, wenn ein Hook eine unbekannte Session sieht (Kette über `parentID`, gecacht).
- FiGr-eigene Fan-outs legen ihre Kind-Sessions selbst an und kennen die Zuordnung direkt.

### 10.6 `session.hook("experimental.idle")`: Stop-Guard

- Orchestrator: siehe 7.4.
- Reviewer ohne Urteil bzw. Fan-out-Kind ohne Report: bis zu 2 Nachforderungen, dann gilt es als `missing`.

### 10.7 Menschliche Entscheidungen

- `ctx.permission.assert({ … })` zeigt den normalen opencode-Freigabedialog und wartet auf die Antwort (Spike S7). Genutzt für `approve.human`, Eskalationen und das Bestätigen von Overrides, die der Orchestrator per Tool anfragt (`figr_status` kann `requestSkip` anbieten, nur mit Nutzerfreigabe).
- Wird abgelehnt und Text mitgegeben, geht der Text als Befund an den Orchestrator.

---

## 11. Muster

Alle Muster nutzen den gemeinsamen **Fan-out-Runner** (`src/fanout/runner.ts`):

```ts
interface FanoutJob { role: Role; agent: string; title: string; prompt: string; directory?: string; model?: string; reportSchema?: JsonSchema; }
runFanout(parentSessionID, jobs: FanoutJob[], { maxParallel, signal, onProgress }): Promise<FanoutResult[]>
```

Ablauf pro Job:

1. `ctx.session.create({ parentID, agent, title: "FiGr · <Rolle> · <Agent>", location: { directory } })`
2. Zuordnung und Rolle registrieren.
3. `ctx.session.prompt({ sessionID, text })`
4. `ctx.session.wait({ sessionID })` (experimental) bzw. auf das Idle-Event warten.
5. Report bzw. Urteil aus dem Zustand lesen. Fehlt es nach den Nachforderungen, ist der Status `missing`.

Abbruch: Wird das aufrufende Tool abgebrochen (`context.signal`), folgt `ctx.session.interrupt` für alle laufenden Kinder. Fortschritt meldet der Runner über `context.progress({ … })` des aufrufenden Tools, damit es in der TUI sichtbar ist. Die Parallelität begrenzt ein Semaphor (`rules.subagents.maxParallel`). Das Budget `maxTotal` wird vor dem Start geprüft.

> Hinweis: Die Kind-Sessions sind dieselben wie bei opencodes eigenem `subagent`-Tool (`parentID`). Sie erscheinen in der TUI als Sub-Agenten des Orchestrators. Prüfen in Spike S4.

### 11.1 Review-Gremium: `figr_review({ gate, focus? })`

1. Prüfen: Gate nicht `blocked`, Artefakt vorhanden. Version berechnen. Läuft bereits eine Runde für diese Version, gilt das Ergebnis dieser Runde: sofort zurückgeben, falls fertig, sonst die offenen Reviewer nachstarten.
2. Checks des Gates ausführen (parallel zu den Reviewern), über `child_process` im Projekt- bzw. Worktree-Verzeichnis, mit Timeout (Standard 10 min) und gekürzter Ausgabe.
3. Alle Reviewer parallel starten (Fan-out), Prompt mit Gate, Version, Artefakt-Pfad bzw. Diff-Zusammenfassung (`git diff --stat`, voller Diff per Pfad lesbar), optional `focus`.
4. Urteile einsammeln, `evaluateRound` anwenden, Zustand aktualisieren.
5. Rückgabe an den Orchestrator (kompakt): Ergebnis, Zählung, Befunde gruppiert nach Schwere (Blocker zuerst, Duplikate zusammengeführt), Check-Ergebnisse und **nächster Schritt**.

### 11.2 Multi-Plan: `figr_plan({ task, planners?, context? })`

1. Prüfen: Plan-Gate nicht `blocked` (Recherche erfüllt).
2. Jeder Planer schreibt **unabhängig** nach `workDir/<sid>/plans/<agent>.md` und meldet per `figr_report`. Planer sehen einander nicht.
3. Synthesizer (eigener Agent, z. B. `plan-synthesizer`) bekommt alle Pläne, schreibt `plan.md` und meldet Entscheidungen und Konflikte.
4. Bei echten Konflikten (`conflicts` nicht leer) und `produce.askOnConflict: true` (Standard false): Nutzerentscheidung über `permission.assert`.
5. Rückgabe: Pfad, neue Version, Zusammenfassung, Konflikte. Danach `figr_review(gate: "plan")`.

Muster `single`: ein Planer, sonst gleich (ohne Synthese).

### 11.3 Best-of-N: `figr_best_of_n({ task, n?, agent? })`

1. Prüfen: `requires` erfüllt (Plan abgenommen), Budget reicht.
2. **N Worktrees** vom aktuellen Arbeitsstand: `git worktree add --detach <tmp>/figr/<sid>/cand-<X> HEAD`, danach wird der ungespeicherte Arbeitsstand per `git diff --binary | git apply` übertragen. Alternativ `ctx.worktree.create` (Spike S8). Das Verzeichnis liegt außerhalb des Projekts, unter `workDir`-Konfiguration bzw. im System-Temp.
3. N Kandidaten parallel (Agent `produce.agent`), jeweils `location.directory = Worktree`, Prompt mit Auftrag, Plan-Pfad (absolut) und dem Hinweis „nur in deinem Arbeitsverzeichnis arbeiten“.
4. Pro Kandidat die `produce.checks` im Worktree, dazu Diff-Statistik.
5. **Richter** (Agent `produce.judge`) bekommt: Plan, pro Kandidat Diff (vollständig, bei mehr als 200 KB gekürzt mit Pfad), Check-Ergebnisse und Reports. Er liefert per `figr_report` Gewinner und Ranking. Kandidaten mit roten Checks dürfen nur gewinnen, wenn alle rot sind (Regel im Richter-Prompt und harte Prüfung: Ist der Gewinner rot, obwohl es grüne gibt, wird zurückgewiesen und nachgefordert).
6. **Übernahme**: Diff des Gewinners (`git diff --binary` gegen dessen Startstand) per `git apply --3way` in das Projektverzeichnis. Konflikte → Abbruch mit Meldung, nichts halb übernehmen. Danach entsteht eine neue Artefakt-Version, also ein Review nötig.
7. Worktrees aufräumen (auch bei Fehlern). Verlierer-Diffs bleiben als Patch in `workDir/<sid>/candidates/<X>.patch` zum Nachlesen.
8. Rückgabe: Gewinner, Begründung, Ranking, Checks pro Kandidat, Pfade der Patches. Danach `figr_review(gate: "implementation")`.

Option `produce.mode: "merge"` (später, M8+): Der Richter darf einen Synthese-Implementer beauftragen, die besten Teile zu kombinieren.

### 11.4 Weitere Muster (Backlog, nicht Version 1.0)

- `figr_second_opinion`: derselbe Auftrag an zwei verschiedene Modelle, Abgleich.
- `figr_debate`: Pro/Contra-Reviewer und Schiedsrichter.
- `figr_explore`: N Explorer parallel zu Teilfragen, zusammengefasst (Nachweis für `research`).

---

## 12. TUI

Die TUI-Teile nutzen `@opencode/plugin/tui`. Die Muster dafür liefert AiFlow `packages/opencode-plugin/src/v2/tui.tsx`. Der Server-Teil teilt den Zustand mit dem TUI-Teil über `ctx.storage` und Events.

| Element | Inhalt |
|---|---|
| Seitenleiste (`sidebar_content`) | Profil, Gate-Liste mit Symbol (✔ ▶ ○ ⨯ ⏭), Version, Freigaben x/y, Runde. Laufende Fan-outs (Rolle, Agent, Status). Letzte Blockade („Implementer gesperrt: Plan offen“). |
| Prompt-Zeile rechts | `FiGr: plan 1/2 · impl ○` |
| Befehle | `/figr` (Status als Nachricht), `/figr-profile <name>`, `/figr on`/`/figr off` (für die aktuelle Session), `/figr-skip <gate>` (mit Bestätigung), `/figr-reset <gate>`, `/figr-findings` (offene Befunde) |
| Dialoge | Ausschließlich native opencode-Dialoge über `permission.assert` (Eskalation, menschliche Freigabe, Skip-Bestätigung) |
| Toasts | Gate bestanden/verfallen, Eskalation, Konfigurationsfehler |

Befehle registriert der Server-Teil über `ctx.command.transform` (Slash-Befehle mit Argumenten). Die Ausgabe erscheint als Nachricht in der Session (wie bei SkillSmith).

---

## 13. Persistenz, Audit, Wiederaufnahme

- **Zustand pro geführter Session** in `ctx.storage` unter `figr/session/<sid>`: aktives Profil, Basis-Commit, Gate-Zustände, Versionen, Runden mit Urteilen, Zähler (Budget, Nudges), Kind-Zuordnungen, Overrides. Geschrieben nach jeder Änderung (debounced 200 ms, beim Beenden sofort).
- Zustand ist **versioniert** (`stateVersion`) und migrierbar.
- **Audit-Log**: `workDir/<sid>/log.jsonl`, append-only, ein Ereignis pro Zeile, z. B. `gate.passed`, `verdict`, `blocked`, `override`, `fanout.started`. Dazu `workDir/<sid>/report.md`, am Ende bzw. auf `/figr` erzeugt: Gates, Runden, Befunde, Entscheidungen.
- **Wiederaufnahme** nach opencode-Neustart: Zustand laden. Laufende Fan-outs gelten als abgebrochen, Runden bleiben offen. Der Orchestrator sieht im Status-Block „Review-Runde unterbrochen, figr_review erneut aufrufen“.
- `.opencode/figr/` sollte in `.gitignore` stehen. FiGr schlägt das einmalig per Toast vor, schreibt aber nie selbst in `.gitignore`.

---

## 14. Architektur und Code-Struktur

### 14.1 Paket

Einzelnes Paket `plugins/figr` (kein Monorepo):

```
plugins/figr/
  plan.md                  ← dieses Dokument
  AGENTS.md                ← Regeln für Agenten (M0)
  README.md                ← Nutzerdoku (M7)
  package.json             ← name "figr", type module, exports ./server (v2 lädt <pkg>/server), ./tui
  server.ts                ← v2-Einstieg: export default { id: "figr", setup }
  tui.tsx                  ← TUI-Einstieg
  src/
    config/
      schema.ts            ← Zod-Schema (strict), Typen
      load.ts              ← finden, JSONC parsen, extends/merge, Watcher
      validate.ts          ← Querverweise gegen Agentenliste, Zyklen, Warnungen
    core/                  ← REIN, ohne I/O; vollständig getestet
      gates.ts             ← Zustandsautomat, requires, blocked/open/…; Verfall
      round.ts             ← evaluateRound, required(quorum), Stagnation-Fingerprint
      decide.ts            ← decide(action, resource, session, state, config) → allow | deny(+message, nextStep)
      next-step.ts         ← nächster empfohlener Schritt als Text
      status.ts            ← Statusblock und figr_status-Text
      types.ts
    state/
      store.ts             ← Laden/Speichern über StoragePort, Migration, Debounce
      sessions.ts          ← geführte Sessions, Kind-Zuordnung, Bindungen
    artifacts/
      file.ts, diff.ts, text.ts, version.ts
    fanout/
      runner.ts            ← Kind-Sessions anlegen, prompten, warten, einsammeln; Semaphor; Abbruch
      prompts.ts           ← Rollen-Prompts (Planer, Synthesizer, Kandidat, Richter, Reviewer)
    patterns/
      review.ts, plan.ts, best-of-n.ts
    workspace/
      git.ts               ← git-Aufrufe (execFile, Timeout), worktree add/remove, diff/apply
      checks.ts            ← Prüfbefehle ausführen (Timeout, Ausgabe kürzen)
    host/
      ports.ts             ← schmale Schnittstellen: SessionPort, StoragePort, AgentPort, PermissionPort, EventPort
      v2.ts                ← Adapter: setup(ctx) → Hooks, Tools, Befehle; bildet ctx auf Ports ab
      tools.ts             ← Tool-Definitionen (JSON-Schema + execute), nutzen patterns/core
    audit/
      log.ts, report.ts
    util/
      hash.ts, jsonc.ts, semaphore.ts, text.ts
  test/
    core/*.test.ts         ← Gate-Automat, Runden, Quorum, Stagnation, decide
    config/*.test.ts
    patterns/*.test.ts     ← mit FakeHost (Ports in-memory, simulierte Kind-Sessions)
    workspace/*.test.ts    ← echtes git in Temp-Repos
    host/v2.test.ts        ← Adapter gegen gemockten Plugin-Kontext (Hook-Registrierung, Mutationen)
    fixtures/              ← Beispiel-Agenten und figr.jsonc
```

### 14.2 Prinzipien

- `core/` importiert nichts aus `host/`, `state/`, `workspace/` und macht kein I/O. Das prüft dependency-cruiser oder eine ESLint-Regel.
- Der Host-Adapter ist die **einzige** Stelle, die `@opencode/plugin` kennt. Muster und State sprechen nur mit Ports. So lässt sich alles mit einem In-Memory-FakeHost testen, und ein v1-Adapter ist später möglich.
- TypeScript strict, kein `any`, Zod an allen Grenzen (Konfiguration, Tool-Eingaben, gespeicherter Zustand).
- Fehlertexte für das Modell sind kurz und handlungsorientiert: was blockiert, warum, nächster Schritt.
- Sprache: Code und Bezeichner englisch. Nutzer- und Modelltexte deutsch über eine kleine Textsammlung `src/util/text.ts`, später übersetzbar. **Prompts für Agenten auf Englisch**, weil Modelle Anweisungen auf Englisch zuverlässiger befolgen. Die Statusanzeige für den Nutzer ist deutsch.

### 14.3 Ports (Auszug)

```ts
interface SessionPort {
  create(o: { parentID: string; agent: string; title: string; directory?: string }): Promise<string>;
  prompt(sessionID: string, text: string): Promise<void>;
  wait(sessionID: string, signal: AbortSignal): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  get(sessionID: string): Promise<{ id: string; parentID?: string; agent?: string; directory: string }>;
  synthetic(sessionID: string, text: string): Promise<void>;
}
interface PermissionPort { ask(o: { sessionID: string; title: string; detail: string }): Promise<{ approved: boolean; feedback?: string }>; }
interface StoragePort { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; }
interface AgentPort { list(): Promise<{ id: string; mode: "primary" | "subagent" | "all"; hidden?: boolean; permissions?: unknown }[]>; }
```

### 14.4 Abhängigkeiten

- Laufzeit: `zod` (4.x), `jsonc-parser`. Sonst Node/Bun-Standardbibliothek (`node:child_process`, `node:crypto`, `node:fs`).
- Peer: `@opencode/plugin` (≥ 2.2). Entwicklung: TypeScript 5.9, Vitest, ESLint (typescript-eslint strictTypeChecked), dependency-cruiser. Diese Konfiguration aus AiFlow übernehmen.

---

## 15. Teststrategie

| Ebene | Was | Werkzeug |
|---|---|---|
| Kern | Gate-Automat (alle Übergänge aus 7.1), Quorum, Veto, Runden, Verfall, Stagnation, `decide` für jede Regel, nächster Schritt | Vitest, reine Funktionen, Tabellen-Tests |
| Konfiguration | Schema, extends/merge, Validierung (fehlende Agenten, Zyklen, Quorum zu groß), JSONC mit Kommentaren | Vitest |
| Muster | Review-Runde mit 3 Reviewern (approved/changes/missing), Multi-Plan, Best-of-N inkl. roter Checks, Abbruch, Budget | FakeHost: SessionPort simuliert Kind-Sessions, die per Skript `figr_verdict`/`figr_report` aufrufen |
| Workspace | Worktree anlegen, Arbeitsstand übertragen, Gewinner per `apply --3way`, Konfliktfall, Aufräumen | echtes git in Temp-Repos |
| Host-Adapter | Registriert Hooks und Tools, Sichtbarkeit pro Session, `evaluate` setzt deny+message, Idle schickt nach, Befehle | Mock von `Plugin.Context` (typgeprüft gegen `@opencode/plugin` 2.2.x) |
| Szenario | „Orchestrator versucht abzukürzen“ (5.2) als Ende-zu-Ende über FakeHost: blockiert, Status korrekt, Ende erst nach Gates | Vitest |
| Live (manuell, dokumentiert) | Mit echtem opencode v2 und Beispiel-Agenten: Checkliste aus Abschnitt 17 | Protokoll in `docs/live-test.md` |

Ziel: Kern zu 100 % der Zweige, gesamt > 85 %. `pnpm check` (Typecheck, Lint, Paketgrenzen, Tests) muss grün sein.

---

## 16. Meilensteine

Jeder Meilenstein endet mit grünem `pnpm check`, einem Commit und einem Eintrag in `docs/STATUS.md`.

### M0 – Gerüst und Spikes (zuerst!)

- Paketgerüst, Tooling (aus AiFlow übernehmen), `AGENTS.md`, `docs/STATUS.md`.
- Minimal-Plugin `server.ts`, das sich in opencode v2 lädt und ein Tool `figr_ping` registriert.
- **Spikes S1–S10 (Abschnitt 17) mit echtem opencode v2 durchführen.** Ergebnisse in `docs/spikes.md`. Wo eine Annahme nicht hält, Plan anpassen (Abschnitt mit „Änderung nach Spike“ markieren).

### M1 – Konfiguration und Kern

- `config/*` komplett inkl. Validierung gegen die Agentenliste.
- `core/*`: Gate-Automat, Runden, Quorum, Verfall, Stagnation, `decide`, nächster Schritt, Statustext.
- Vollständige Unit-Tests.

### M2 – Durchsetzung ohne Muster

- Host-Adapter: geführte Sessions erkennen, Kind-Sessions zuordnen.
- `permission.hook("evaluate")` (bzw. Fallback): Orchestrator darf nicht editieren, Shell nur laut Liste, Phase-Agenten erst nach `requires`, Budget.
- Kontext-Hook: Statusblock für den Orchestrator, Tool-Sichtbarkeit.
- `figr_verdict` und Erkennung direkter Reviewer-Aufrufe über `subagent` (10.2, 10.5). Damit funktionieren Gates schon mit dem normalen `subagent`-Tool.
- Artefakte `file` und `diff` mit Versionen und Verfall.
- Stop-Guard.
- `figr_status`, `figr_submit`.
- Persistenz in `ctx.storage`, Audit-Log.

**Damit ist das Kernziel des Nutzers erreicht** (Reviewer müssen abnehmen, Reihenfolge erzwungen).

### M3 – Review-Gremium

- Fan-out-Runner, `figr_review` inkl. Checks, unabhängiger Reviews, Befund-Zusammenführung, Eskalation über `permission.assert`.

### M4 – Multi-Plan

- `figr_plan` (multi-plan und single), Planer- und Synthesizer-Prompts, `figr_report`-Schemas, Konfliktbehandlung.

### M5 – Best-of-N

- Workspace-Modul (git), `figr_best_of_n`, Richter, Übernahme, Aufräumen, Patches der Verlierer.

### M6 – TUI und Befehle

- Seitenleiste, Prompt-Zeile, Befehle, Toasts, menschliche Freigabe (`approve.human`), Overrides.

### M7 – Doku, Beispiele, Schema

- README mit Schnellstart, Beispiel-Agenten (Abschnitt 19), Presets `strict`/`quick`/`solo`, generiertes JSON-Schema, `report.md`.
- Live-Test nach Checkliste, Screenshots der TUI.

### M8 – Härtung (optional)

- Wiederaufnahme nach Neustart, Abbruch-Kanten, große Diffs, Performance (Diff-Cache), Muster `merge` für Best-of-N, Backlog-Muster (11.4).

---

## 17. Spikes (vor der Umsetzung prüfen)

Die folgenden Punkte stammen aus Typen bzw. Quellcode von opencode 2.2.6, sind aber **nicht live verifiziert**. Jeder Spike ist ein kleines Test-Plugin mit Protokoll.

| # | Frage | Erwartung laut Quellcode/Typen | Plan B |
|---|---|---|---|
| S1 | Löst `permission.hook("evaluate")` für `edit`/`write`/`patch`, `shell` und `subagent` (Ressource = Agent-ID) aus? Kommt `message` beim Modell an? | `subagent` evaluiert `Permission.evaluate("subagent", agent.id, …)`. Edit/Shell rufen `permission.assert` auf. | `tool.hook("execute.before")` mit `throw` |
| S2 | Bricht ein `throw` in `tool.hook("execute.before")` den Tool-Aufruf ab, und sieht das Modell die Fehlermeldung? | AiFlow nutzt das bereits so (nicht live getestet) | `evaluate` (S1) |
| S3 | Kann ein Plugin Kind-Sessions anlegen (`session.create` mit `parentID`, `agent`, `location.directory`), prompten und mit `session.wait` auf das Ende warten? | Typen: `SessionCreateInput` hat `parentID`, `agent`, `location`; `wait` ist experimental | Auf `session.idle`-Event warten. Notfalls ausschließlich über das `subagent`-Tool arbeiten: der Orchestrator ruft es auf, FiGr nur zuordnen. |
| S4 | Erscheinen plugin-erzeugte Kind-Sessions in der TUI wie normale Sub-Agenten? | gleicher Mechanismus (`parentID`) wie das `subagent`-Tool | Status nur in der Seitenleiste |
| S5 | Kann `session.hook("context")` Tools pro Session ausblenden und das Eingabeschema eines Tools pro Session setzen? | AiFlow v2 nutzt beides | Tools immer sichtbar, Ablehnung im `execute` |
| S6 | Führt `session.synthetic` (delivery `queue`) im Idle-Hook dazu, dass die Session weiterarbeitet? | Doku im Typ: „Input admitted by the hook … runs in the same execution“ | `session.prompt` nach dem Idle-Event |
| S7 | Zeigt `permission.assert` aus einem Tool bzw. Hook einen TUI-Dialog, und wie kommt Freitext-Feedback zurück? | Typ-Doku: „prompts the user and waits“; Ablehnung mit Feedback → `Tool.Error` mit Grund | Eigener TUI-Dialog über das TUI-Plugin |
| S8 | `ctx.worktree.create` nutzbar für Best-of-N, oder lieber eigenes `git worktree`? Arbeiten Kind-Sessions mit `location.directory` im Worktree, inkl. Rechte? | API vorhanden (`projectID` nötig) | eigenes `git worktree add --detach` |
| S9 | Bleibt `ctx.storage` über Neustarts erhalten, und ist es pro Projekt oder global? | Schlüssel/Wert-Speicher des Plugins | Datei unter `workDir` |
| S10 | Sehen TUI-Plugin und Server-Plugin denselben Zustand (Storage/Events)? Welche Slots gibt es in 2.2.x? | AiFlow-TUI nutzt `sidebar_content`, `session_prompt_right` | Status über Befehl `/figr` |
| S11 | Wird eine Kind-Session, die das `subagent`-Tool startet, mit `session.created` (inkl. `parentID`) gemeldet, **bevor** sie ihr erstes Tool aufruft? | Event wird beim Anlegen veröffentlicht | Zuordnung lazy über `session.get` im Hook |

**Live-Checkliste für M7** (alles in echtem opencode v2):

1. Orchestrator kann nicht editieren.
2. Implementer ist vor der Plan-Abnahme gesperrt, mit verständlicher Meldung.
3. Review-Gremium mit 2 Reviewern: approved/changes korrekt gezählt.
4. Plan ändert sich → Freigabe verfällt.
5. Best-of-3 übernimmt den Gewinner.
6. Stop-Guard schickt nach.
7. Eskalationsdialog erscheint.
8. Seitenleiste aktualisiert sich.
9. SkillSmith-Tools bleiben nutzbar.

---

## 18. Risiken und offene Punkte

| Risiko | Gegenmaßnahme |
|---|---|
| Modell ruft `figr_verdict` nicht auf | Rollenblock im Kontext, bis zu 2 Nachforderungen, dann `missing` an den Orchestrator. Dessen Status nennt den nächsten Schritt. |
| Endlosschleifen (Nachforderungen, Runden) | Harte Grenzen: `maxNudges`, `maxRounds`, Budget `maxTotal`, Stagnation. Eskalation an den Nutzer. |
| Orchestrator umgeht Regeln über Shell (`sed -i`) | Shell für den Orchestrator nur per Allowlist (Standard: Lese-Befehle git/ls). Edit-Sperre über `evaluate`. |
| Reviewer ändern Code | deny für `edit` in Reviewer-Sessions plus Hinweis bei der Validierung |
| Diff-Version ändert sich durch Formatter/Build-Artefakte | `.gitignore` wird respektiert. Zusätzlich `artifact.ignore` (Glob-Liste) pro Gate. |
| Best-of-N verbraucht viel Zeit/Token | `n` konfigurierbar, Budget, Profil `quick` |
| API-Details von opencode v2 ändern sich (2.x) | Host-Adapter kapselt alles, Spikes dokumentiert, Mindestversion in `package.json`, Smoke-Test-Plugin |
| Parallele Kandidaten blockieren sich (Ports, DB) | Hinweis in der Doku. Checks sind pro Kandidat sequenziell konfigurierbar (`produce.checksParallel: false`). |
| Nutzer will kurzfristig ohne Regeln arbeiten | `/figr off` pro Session, Profil `solo` |

Offene Entscheidungen (mit Vorschlag; bei Bedarf den Nutzer fragen):

1. **Name des Plugin-Pakets** für npm: `opencode-figr` (Vorschlag). Lokal nutzbar über Pfad.
2. **Standardprofil**, wenn keine Konfiguration existiert: FiGr inaktiv mit einmaligem Hinweis (Vorschlag), statt implizitem `strict`.
3. **Plan-Datei im Projekt** statt in `workDir` (z. B. `docs/plans/<datum>-<slug>.md`)? Vorschlag: konfigurierbar, Standard `workDir`.

---

## 19. Beispiel-Agenten und Presets (M7 liefert sie mit)

`examples/agent/` – Dateien für `.opencode/agent/` (v2-Frontmatter; Felder `description`, `mode`, `model`, `permissions`):

| Datei | mode | Rechte | Zweck |
|---|---|---|---|
| `orchestrator.md` | primary | lesen, `subagent`, kein edit | Leitet an, erklärt FiGr-Tools und den Stil („delegiere, prüfe, fasse zusammen“) |
| `explore.md` | subagent | nur lesen | Recherche |
| `planner.md`, `planner-a.md` (konservativ), `planner-b.md` (ambitioniert), `planner-c.md` (test-first) | subagent | lesen, schreiben nur in `workDir` | Unterschiedliche Planungsperspektiven für Multi-Plan |
| `plan-synthesizer.md` | subagent | lesen, schreiben nur in `workDir` | Pläne abgleichen |
| `implementer.md` | subagent | voll (außer git push) | Umsetzung |
| `code-judge.md` | subagent | nur lesen | Best-of-N-Richter |
| `architect-reviewer.md`, `security-reviewer.md`, `standards-reviewer.md`, `test-reviewer.md` | subagent | nur lesen | Reviews mit Rubrik |

Presets in `examples/figr.jsonc`:

- **strict**: wie in 6.2.
- **quick**: 1 Planer, 1 Reviewer pro Gate, kein Best-of-N.
- **solo**: nur Stop-Guard und „Orchestrator ändert nicht“, keine Gates. Zum sanften Einstieg.

Die Prompts der Beispiel-Agenten enthalten **keine** FiGr-Mechanik. Die kommt dynamisch über den Kontext-Hook. Dadurch funktionieren die Agenten auch ohne FiGr.

---

## 20. Was aus AiFlow wiederverwendet wird

Aus `plugins/aiflow` (gleiches Repo) übernehmen bzw. anpassen, nicht als Abhängigkeit einbinden:

| Quelle | Wofür |
|---|---|
| `packages/opencode-plugin/src/v2/server.ts`, `v2/tui.tsx`, `tsconfig.tui.json` | Muster für v2-Registrierung (Tools, Hooks, Kontext, Idle, Befehle, Slots), gegen echte Typen geprüft |
| `packages/workspace-git/src/git.ts`, `manager.ts` | git-Aufrufe, Worktrees, Diff/Apply, Aufräumen |
| `packages/core/src/handoff.ts` (`majorityVote`), `jsonschema.ts` | Abstimmung, Schema-Validierung von Reports |
| `packages/core/src/permissions.ts` (`matchesPattern`) | Muster für Shell-Allowlist |
| `packages/engine/src/semaphore.ts` | Parallelitätsgrenze |
| Stagnations-Fingerprint aus `engine.ts` (`traverse`) | Idee für 7.2 |
| Tooling: `eslint.config.js`, `vitest.config.ts`, `tsconfig.base.json`, `.dependency-cruiser.cjs` | gleiche Qualitätsmaßstäbe |

---

## 21. Glossar der opencode-v2-API (verifiziert gegen `@opencode/plugin` / `@opencode/client` 2.2.6 und den Quellcode)

- **Einstieg:** `export default { id, setup(ctx) }`. opencode 2 lädt `<paket>/server`. `ctx: Plugin.Context` mit u. a. `location`, `options`, `agent`, `command`, `event`, `permission`, `session`, `storage`, `tool`, `worktree`, `vcs`, `shell`.
- **Tools:** `ctx.tool.transform(editor => editor.add({ name, description, input /* JSON-Schema */, execute(input, context) }))`. `context` hat u. a. `sessionID`, `agent`, `signal`, `progress(meta)`. Rückgabe `{ content }` bzw. Tool-Ergebnis.
- **Tool-Hooks:** `ctx.tool.hook("execute.before", e => …)` mit veränderbarem `e.input`. `ctx.tool.hook("execute.after", e => …)` mit `status` und `result`/`error`.
- **Rechte:** `ctx.permission.hook("evaluate", e => { e.effect = "deny"; e.message = "…" })`. Felder: `sessionID`, `agent`, `action`, `resources`, `effect`. `ctx.permission.assert(input)` fragt den Nutzer und wartet.
- **Sessions:** `ctx.session.create({ parentID, agent, title, location: { directory }, model?, metadata? })`, `prompt({ sessionID, text })`, `synthetic({ sessionID, text, delivery: "queue" | "steer", resume? })`, `wait({ sessionID })` (experimental), `interrupt`, `get`, `list`.
- **Session-Hooks:** `"context"` (veränderbar: `system`, `messages`, `tools[name].description/input`, `options`; `agent` lesbar), `"prompt"`, `"compaction"`, `"experimental.idle"` (`sessionID`, `background[]`; Eingaben, die der Hook zulässt, laufen in derselben Ausführung weiter).
- **Sub-Agent-Tool:** Name `subagent`. Eingabe `{ agent, description, prompt, model?, sessionID?, background? }`. Legt die Kind-Session mit `parentID` an. Ergebnistext in `<subagent sessionID=… state="completed">…</subagent>`. Sichtbare Sub-Agenten: `mode !== "primary"`, nicht `hidden`, und `Permission.evaluate("subagent", agent.id, …)` nicht deny.
- **Agent-Dateien:** gesucht unter `{agent,agents}/**/*.md` (Sub-Agenten) und `{mode,modes}/*.md` (primär) in den Konfig-Verzeichnissen, u. a. `.opencode/`. v2-Felder u. a. `permissions`, `system`, `request`, `disabled`.
- **Rechte-Auswertung:** Regeln `{ action, resource, effect }`, letzte passende gewinnt, Muster in Aktion und Ressource. Ohne Treffer gilt `ask`. Kind-Sessions des `subagent`-Tools erben **keine** Rechte der Eltern-Session, sondern nutzen die Rechte ihres Agenten.
- **Events:** `ctx.event.subscribe({ types: ["session.created", …] })`. `session.created.data` enthält `sessionID`, `parentID?`.
- **Storage:** `ctx.storage.get/set/remove/scan` (JSON-Werte).
