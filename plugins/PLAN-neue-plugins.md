# Plan: sechs neue opencode-Plugins

> Übersichtsplan für sechs Plugins neben AiFlow und FiGr. Er beschreibt, was jedes Plugin kann und wie es funktioniert. Vor der Umsetzung bekommt jedes Plugin einen eigenen Detailplan (`plugins/<name>/plan.md`, wie bei FiGr).
>
> **Stand der Prüfung:** Alle genannten opencode-Schnittstellen sind gegen die Typen von `@opencode/plugin` / `@opencode/client` 2.2.6 geprüft. Live getestet ist nichts, weil in der Entwicklungsumgebung kein opencode v2 mit Modellzugang läuft (wie bei FiGr). Unsichere Annahmen stehen pro Plugin unter „Spikes“.

| # | Arbeitsname | Idee | Teile |
|---|---|---|---|
| 1 | **Recall** | Session-Suche (Volltext + semantisch) | Server + TUI |
| 2 | **Regelwerk** | Auto-AGENTS.md aus wiederholten Korrekturen | Server + TUI |
| 3 | **Cockpit** | Live-Seitenleiste | TUI (kleiner Server-Teil) |
| 4 | **Fokus** | Fokus-Modus ohne Tool-Rauschen | TUI |
| 5 | **Blueprint** | Interview-Modus + Plan-Kritiker | Server + TUI |
| 6 | **Pimp** | Prompt-Verbesserer, Befehl `/pimp` | Server + TUI |

---

## 0. Gemeinsame Grundlage

### 0.1 Rahmenbedingungen
- opencode **v2**, Token-Verbrauch spielt keine Rolle. Wo ein zusätzlicher Modellaufruf die Qualität hebt, wird er gemacht.
- Jedes Plugin ist ein eigenes Paket unter `plugins/<name>` mit `server.ts` und/oder `tui.tsx`, einzeln installier- und abschaltbar.
- Aufbau und Tooling wie FiGr: TypeScript strikt, Zod an allen Grenzen, Ports/Adapter (nur `src/host/` kennt `@opencode/plugin`), reiner Kern ohne I/O, Vitest mit Fake-Host, ESLint strictTypeChecked, dependency-cruiser, `pnpm check`.
- Nutzertexte deutsch, Prompts für Modelle englisch.

### 0.2 Gemeinsames Paket `plugins/kit`
FiGr hat sein Tooling aus AiFlow kopiert. Bei sechs weiteren Plugins lohnt ein gemeinsames Paket:

- **Host-Ports + Fake-Host** (Sessions, Storage, Events, Permission) für Tests
- **LLM-Helfer**: `generate(model, prompt, jsonSchema)` über `ctx.experimental.generate` mit Schema-Validierung und Wiederholung; Alternative „Kind-Session mit Agent“, wenn das Modell Tools braucht
- **Transkript-Leser**: Session-Nachrichten in eine einheitliche Form bringen (Nutzertext, Assistententext, Tool-Aufruf mit Kurzfassung, Fehler). Brauchen Recall, Regelwerk, Fokus und Cockpit.
- **Konfiguration**: JSONC laden, global + Projekt zusammenführen, Watcher (aus FiGr)
- **Schwärzung** von Geheimnissen (Token, Schlüssel, `.env`-Werte), bevor Text in einen Index oder an ein Hilfsmodell geht
- **TUI↔Server-Brücke** über `ctx.rpc.register` (Server) und den Client der TUI; Rückfall auf Statusdatei wie bei FiGr

### 0.3 Verwendete opencode-Schnittstellen (geprüft)
- **Server:** `ctx.session.{list,get,context,create,prompt,synthetic,generate,wait,interrupt}`, Hooks `prompt`, `context`, `compaction`, `experimental.idle`; `ctx.tool.transform` + `tool.hook("execute.before"|"execute.after")`; `ctx.permission.hook("evaluate")` + `permission.assert`; `ctx.command.transform`; `ctx.event.subscribe`; `ctx.storage`; `ctx.experimental.generate` (Modellaufruf ohne Session); `ctx.rpc.register`.
- **TUI:** Slots `sidebar.content`, `sidebar.footer`, `session.panel` (auch Vollbild), `session.composer.top`, `prompt.footer.*`; `ui.dialog.{select,prompt,confirm,show}`; `ui.panel.open`; `ui.router` (eigene Seiten, Sprung zu Sessions); `ui.tabs`; `ui.toast`; `attention.notify`; `keymap.layer` mit Tastenbindung, Palette und Slash-Befehl (inkl. Argumenten); `data.session.{list,family,status,cost,message.list,permission.list,form.list}`; `data.shell.list`; `storage.store` (dauerhaft, zwischen TUI-Instanzen synchron).
- **Nicht vorhanden:** ein Slot für die Nachrichtenliste, eine Embedding-Schnittstelle. Das prägt Fokus (Abschnitt 4) und Recall (Abschnitt 1).

---

## 1. Recall – Session-Suche

**Zweck:** „Wie haben wir das damals gelöst?“ Sucht über alle alten Sessions, projektübergreifend, per Volltext und nach Bedeutung. Nutzbar von dir (Dialog, Befehl) und vom Agenten (Tool).

### Was es kann
- **Suchdialog** (Tastenkürzel, Palette, `/recall`): Tippen liefert sofort Treffer mit Titel, Projekt, Datum und Textausschnitt. Enter springt in die Session an die Fundstelle. Weitere Aktionen: Zusammenfassung in den Prompt einfügen, Session forken, nur aktuelles Projekt.
- **Frage-Modus** `/recall <frage>`: Antwort in Prosa mit Quellen („In Session X vom 3.10. haben wir … gelöst, indem …“), zusammengestellt aus den besten Treffern.
- **Agenten-Tools:** `recall_search(query, project?, since?, limit?)` und `recall_read(sessionID, around?)`. Der Agent kann selbst nachschlagen, bevor er ein Problem neu löst.
- **Automatischer Hinweis** (abschaltbar): Beim ersten Prompt einer Session sucht Recall ähnliche frühere Sessions und hängt die zwei, drei besten als kurzen Hinweis in den Kontext.
- **Filter:** Projekt, Zeitraum, Agent, „nur Sessions mit Dateiänderungen“, Datei- oder Symbolname.

### Wie es funktioniert
1. **Indexieren.** Beim Start einmal alle Sessions nachziehen (`ctx.session.list` + Nachrichten), danach laufend: Wird eine Session ruhig (`experimental.idle`), wird sie neu indexiert, wenn sich ihr Inhalt geändert hat (Hash).
2. **Was in den Index kommt.** Pro Session
   - Textstücke: Nutzer-Prompts, Assistententexte, verdichtete Tool-Aufrufe (Befehl, Datei, Fehlermeldung, keine vollen Ausgaben)
   - eine **Session-Karte**, die ein Modell schreibt: Problem, Lösung, verworfene Ansätze, wichtige Dateien und Befehle, Stichworte. Die Karte ist der wichtigste Baustein für die Bedeutungssuche.
3. **Volltext.** SQLite FTS5 (BM25) in einer Datei im opencode-Datenverzeichnis, nicht im Repo. Rückfall ohne SQLite: MiniSearch mit JSON-Datei.
4. **Semantisch.** opencode bietet keine Embeddings. Drei Stufen, per Konfiguration:
   - **Standard, ohne Zusatz-Infrastruktur:** Ein Modell erweitert die Anfrage (Synonyme, Fachbegriffe, englisch/deutsch), FTS liefert ~50 Kandidaten über Karten und Textstücke, ein Modell sortiert sie nach Relevanz.
   - **Optional Embeddings** über einen OpenAI-kompatiblen `/embeddings`-Endpunkt eures Anbieters; Vektoren in derselben SQLite-Datei, Ergebnis mit FTS verschmolzen.
   - **Optional lokal** (transformers.js), falls nichts das Haus verlassen darf.
5. **Schwärzung** vor dem Indexieren; einzelne Sessions oder Projekte lassen sich ausschließen (`/recall-forget`).

### Ablage und Konfiguration
`recall.jsonc`: Modell für Karten und Sortierung, Embedding-Endpunkt, automatische Hinweise an/aus, ausgeschlossene Projekte.

### Spikes
- Welche SQLite-Anbindung steht im Plugin-Prozess zur Verfügung (`bun:sqlite` oder `node:sqlite`)?
- Liefert `ctx.session.list` Sessions aller Projekte oder nur des aktuellen? Sonst über den Client mit Location.
- Sprung an eine bestimmte Nachricht einer Session (sonst nur zur Session).

---

## 2. Regelwerk – Auto-AGENTS.md

**Zweck:** Erkennt, wenn du den Agenten wiederholt für dasselbe korrigierst, und schlägt eine passende Regel für `AGENTS.md` vor. Geschrieben wird erst nach deiner Bestätigung.

### Was es kann
- **Korrekturen erkennen** aus:
  - deinen Nachrichten nach einer Agenten-Antwort („nein, nimm pnpm“, „nicht so, sondern …“, „hab ich doch gesagt“)
  - Abbrüchen mitten im Lauf, gefolgt von einer Richtungsänderung
  - Rücknahmen (Revert)
  - abgelehnten Freigaben mit Begründungstext
  - ausdrücklichen Ansagen („ab jetzt immer …“, „merk dir …“), die sofort zum Vorschlag werden
- **Bündeln:** Gleichartige Korrekturen aus verschiedenen Sessions landen beim selben Regel-Kandidaten. Ab einer Schwelle (Standard: 2 Sessions) wird daraus ein Vorschlag.
- **Vorschläge prüfen** mit `/rules`: Liste mit Regeltext, Belegen (Zitat + Session) und Ziel. Aktionen: annehmen, bearbeiten, ablehnen („nie wieder vorschlagen“), zurückstellen.
- **Zielwahl:** Projekt-`AGENTS.md`, `AGENTS.md` eines Unterordners (wenn die Korrekturen nur dort auftraten) oder globale Datei.
- **Sauber einarbeiten:** Die Regel wird in den passenden Abschnitt eingefügt, gegen vorhandene Regeln auf Dopplung und Widerspruch geprüft und als Diff gezeigt.
- **Wirkungskontrolle:** Tritt dieselbe Korrektur nach Annahme der Regel wieder auf, meldet Regelwerk „Regel wirkt nicht“ und schlägt eine schärfere Formulierung vor oder eine harte Durchsetzung (z. B. als FiGr-Regel).
- **Aufräumen** mit `/rules audit`: findet doppelte, widersprüchliche und veraltete Regeln (z. B. Verweise auf Dateien, die es nicht mehr gibt).

### Wie es funktioniert
1. **Sammeln.** `session.hook("prompt")` liefert jede Nutzernachricht; Ereignisse liefern Abbrüche und Reverts. Nichts davon bremst die Session.
2. **Auswerten** im Idle-Hook: Ein Modell bekommt den jüngsten Abschnitt der Session und liefert strukturiert pro Korrektur: beobachtetes Verhalten, gewünschtes Verhalten, Geltungsbereich, verallgemeinerte Regel, Zitat. Einmalige, aufgabenspezifische Korrekturen („die Variable soll `x` heißen“) werden aussortiert.
3. **Zuordnen.** Ein zweiter Modellaufruf ordnet jede Korrektur einem vorhandenen Kandidaten zu oder legt einen neuen an. Zustand in `ctx.storage` (`regelwerk/…`).
4. **Melden.** Toast und Zähler in `sidebar.footer` („2 Regelvorschläge“), kein Dialog mitten in der Arbeit.
5. **Schreiben** nur über `/rules` mit Diff-Vorschau. Optional wirkt die Regel sofort in der laufenden Session (Session-Instructions-API), ohne Neustart.

### Spikes
- Erkennt opencode Änderungen an `AGENTS.md` in laufenden Sessions von selbst?
- Zuverlässigkeit der Korrektur-Erkennung: Testsatz aus echten alten Sessions (über Recall-Index), bevor die Schwelle festgelegt wird.

---

## 3. Cockpit – Live-Seitenleiste

**Zweck:** Dauerhaft sichtbar neben dem Chat, ohne Scrollen: wo steht die Arbeit, was wurde angefasst, wer läuft gerade.

### Was es zeigt
| Abschnitt | Inhalt | Quelle |
|---|---|---|
| **Plan** | Ziel und Schritte mit Haken, aktueller Schritt hervorgehoben | Plan-Datei von Blueprint bzw. FiGr; sonst das Session-Ziel |
| **Todos** | offene, laufende, erledigte Punkte | letzter `todowrite`-Aufruf der Session (experimentelles opencode-Tool) |
| **Geänderte Dateien** | Pfad, +/− Zeilen, neu/gelöscht, zuletzt geändert zuerst | Session-Diff, aufgefrischt nach jedem Edit-Tool |
| **Subagents** | Baum der Kind-Sessions: Agent, Auftrag, läuft/fertig/Fehler, letzter Tool-Aufruf, Kosten, Laufzeit | `data.session.family`, `status`, `cost`, Nachrichten |
| **Hintergrund** | laufende Shells | `data.shell.list` |
| **Wartet auf dich** | offene Freigaben und Rückfragen, auch von Subagents | `data.session.permission.list`, `form.list` |

### Bedienung
- Abschnitte ein- und ausklappbar, Reihenfolge und Sichtbarkeit pro Nutzer gespeichert (`storage.store`).
- Enter auf einer Datei öffnet den Diff im Seitenpanel (`session.panel`); Enter auf einem Subagent springt in dessen Session.
- Tastenkürzel zum Fokussieren der Leiste und ein Vollbild-Detailpanel (z. B. alle Subagents mit Live-Ausgabe).
- Kompakte Einzeile in `prompt.footer.status` für schmale Terminals („Plan 3/7 · 5 Dateien · 2 Agents“).

### Wie es funktioniert
- Fast reines TUI-Plugin: Es hängt sich an `sidebar.content` an (`append`, ersetzt nichts) und liest reaktiv aus `context.data`. Ereignisse (`session.tool.success`, `session.created`, Status) stoßen das Auffrischen an, es gibt kein Polling.
- Ein kleiner Server-Teil stellt per RPC bereit, was die TUI nicht direkt lesen kann (Plan-Dateien, Diff-Statistik).
- FiGr und AiFlow hängen ebenfalls an `sidebar.content`; die Abschnitte stehen dann untereinander. Cockpit kann den FiGr-Status als eigenen Abschnitt einbinden (liest dessen `status.json`).

### Spikes
- Was zeigt die eingebaute Seitenleiste von opencode v2 schon (Dopplungen vermeiden)?
- Ist `todowrite` bei euch aktiv (`experimental.todo`)? Sonst liefert Cockpit ein eigenes kleines Todo-Tool mit.
- Maus/Fokus innerhalb eines Slots (Auswählen von Zeilen).

---

## 4. Fokus – Fokus-Modus

**Zweck:** Zeigt von einer Session nur, was dich betrifft: deine Nachrichten, Entscheidungen des Agenten, Rückfragen, Fehler und Ergebnisse. Tool-Aufrufe und Zwischengerede verschwinden.

### Wichtige Einschränkung
opencode bietet keinen Slot für die Nachrichtenliste. Ein Plugin kann die eingebaute Ansicht nicht filtern. Fokus bringt deshalb eine **eigene Ansicht** mit: ein Vollbild-Panel (`session.panel`, `presentation: "fullscreen"`), das die Session gefiltert neu darstellt. Die Eingabezeile bleibt die von opencode.

### Was es kann
- **Drei Stufen**, umschaltbar per Taste oder `/focus [0-2]`:
  - **0** normale opencode-Ansicht
  - **1 Kompakt:** Text vollständig, Tool-Aufrufe je Schritt auf eine Zeile verdichtet („14 Aufrufe · 3 Dateien geändert · Tests grün“), aufklappbar
  - **2 Nur Entscheidungen:** deine Nachrichten, Rückfragen, Fehler, Schlussantworten und je Runde eine Entscheidungsliste
- **Entscheidungsliste:** Ein Modell fasst pro Runde Zwischentexte und Reasoning zu wenigen Punkten zusammen („Ansatz B gewählt, weil …“, „Annahme: API bleibt stabil“). Jeder Punkt lässt sich zur Originalstelle aufklappen.
- **Nichts geht verloren:** Fehler, Rückfragen, Freigaben und abgelehnte Tools werden immer gezeigt, egal auf welcher Stufe.
- **Benachrichtigung** (Ton/Desktop über `attention.notify`), wenn der Agent wartet oder fertig ist.
- **Subagents** erscheinen als eine Zeile mit Ergebnis statt als eigener Strom.

### Wie es funktioniert
1. Die TUI liest `data.session.message.list(sessionID)` reaktiv, der gemeinsame Transkript-Leser zerlegt in Teile.
2. **Einordnung ohne Modell:** Text vor einem Tool-Aufruf gilt als Zwischentext, der letzte Text einer Runde als Ergebnis, Rückfrage-Tools und Fehler als „wichtig“.
3. **Verdichtung mit Modell** (Stufe 2): Nach jeder Runde erzeugt der Server-Teil die Entscheidungsliste und legt sie pro Nachricht in `ctx.storage` ab, die TUI holt sie per RPC.
4. Die gewählte Stufe wird pro Session gemerkt.

### Spikes (entscheiden über die Machbarkeit)
- Bleibt die Eingabezeile im Vollbild-Panel bedienbar? Sonst eigene Seite über `ui.router` mit eigener Eingabe.
- Steht Plugins eine Markdown-Komponente zur Verfügung, oder muss Fokus selbst rendern?
- Verhalten beim Streamen (flüssiges Nachführen der letzten Nachricht).

Wegen dieser Punkte ist Fokus das Plugin mit dem höchsten Risiko und kommt zuletzt.

---

## 5. Blueprint – Interview-Modus + Plan-Kritiker

**Zweck:** Bevor Code entsteht: erst gezielt nachfragen, daraus eine Spezifikation schreiben, dann einen Plan erstellen und von einem zweiten Modell zerlegen lassen. Bis zur Freigabe ist Ändern gesperrt.

### Ablauf
```
/spec <Aufgabe>
 1 Erkunden     Repo lesen, damit die Fragen konkret sind
 2 Interview    Fragen in Runden, mit Vorschlägen zum Anklicken
 3 Spezifikation  spec.md → deine Freigabe
 4 Plan         plan.md
 5 Kritik       zweites Modell prüft, Planer bessert nach (Schleife)
 6 Freigabe     deine Entscheidung → Sperre fällt, Umsetzung beginnt
```

### Interview
- **Fragen mit Substanz:** Vor der ersten Frage erkundet ein Sub-Agent den Code. Gefragt wird nur, was sich nicht aus dem Repo beantworten lässt.
- **Form:** Fragen kommen als natives Rückfrage-Formular, jeweils mit 2–4 Antwortvorschlägen, einer Empfehlung und Freitext. Gebündelt nach Thema: Umfang, Verhalten, Randfälle, Nicht-Ziele, Abnahmekriterien, Randbedingungen.
- **Ende:** Nach jeder Runde bewertet das Modell, welche entscheidungsrelevanten Lücken bleiben. Sind keine mehr offen (oder nach `maxRounds`), ist Schluss. Du kannst jederzeit mit „reicht“ abkürzen; offene Punkte landen dann als ausgewiesene Annahmen in der Spezifikation.
- **Tiefe wählbar:** `/spec kurz` (eine Runde), Standard, `/spec gründlich`.

### Spezifikation
`.opencode/blueprint/<slug>/spec.md` mit Ziel, Kontext, Anforderungen, Nicht-Zielen, prüfbaren Abnahmekriterien, Annahmen, betroffenen Stellen. Freigabe über den normalen Dialog; Ablehnen mit Text gilt als Korrektur.

### Plan-Kritiker
- **Zweites Modell:** Der Kritiker läuft als eigene Kind-Session mit eigenem, konfigurierbarem Modell (am besten ein anderer Anbieter als der Planer) und nur lesenden Rechten.
- **Mehrere Blickwinkel parallel:** Deckung der Spezifikation, Risiken und Randfälle, Einfachheit (Über-Engineering), Testbarkeit, fehlende Schritte und falsche Annahmen über den Code. Der Kritiker liest den Code und prüft Behauptungen des Plans nach.
- **Strukturiertes Urteil** über das Tool `blueprint_critique`: `blocking`, `major`, `minor`, `questions`, jeweils mit Beleg. Freitext zählt nicht.
- **Schleife:** Der Planer muss jeden Befund beheben oder begründet zurückweisen. Wiederholung bis kein `blocking` mehr offen ist oder `maxRounds` erreicht sind; bleibt Streit, entscheidest du.
- **Protokoll** `critique.md`: Befund → Reaktion → Stand.

### Durchsetzung
- Solange Spezifikation und Plan nicht freigegeben sind, lehnt `permission.hook("evaluate")` Ändern (`edit`/`write`/`patch`) und verändernde Shell-Befehle ab, mit Begründung und nächstem Schritt (Technik aus FiGr).
- Nach der Freigabe liegen Spezifikation und Plan im Kontext und überleben die Kompaktierung (`compaction`-Hook). Cockpit zeigt den Plan.
- `/spec off` hebt die Führung für die Session auf (protokolliert).

### Verhältnis zu FiGr
FiGr kennt bereits ein Plan-Gate mit Reviewern. Blueprint ergänzt das, was dort fehlt (Interview, Spezifikation), und funktioniert auch in normalen Sessions ohne Orchestrator. In FiGr-geführten Sessions übergibt Blueprint die Kritik an `figr_review` und liefert `spec.md` als Nachweis für ein Gate `spec`, damit nicht zwei Review-Schleifen nebeneinander laufen.

### Spikes
- Formular aus dem Plugin anlegen (`session.form.create` über den Client) oder das eingebaute Rückfrage-Tool des Agenten nutzen?
- Modell pro Kind-Session setzen (`session.create({ model })`).

---

## 6. Pimp – Prompt-Verbesserer (`/pimp`)

**Zweck:** Aus einem knappen Prompt einen präzisen machen: mit echtem Repo-Kontext und Abnahmekriterien. Du siehst eine Vorschau und entscheidest.

### Was es kann
- **`/pimp <kurzer prompt>`** öffnet eine Vorschau mit dem verbesserten Prompt:
  - **Ziel** in einem Satz
  - **Kontext:** konkrete Dateien, Funktionen, vorhandene Muster, die der Agent sonst erst suchen müsste
  - **Anforderungen** und **Nicht-Ziele**
  - **Abnahmekriterien**, prüfbar formuliert
  - **Verifikation:** die passenden Befehle des Projekts (Test, Lint, Build)
- **Getroffene Annahmen** stehen getrennt darunter. Mehrdeutiges wird als Schnellfrage angeboten (Auswahl), die Antwort fließt in den Prompt ein.
- **Aktionen in der Vorschau:** senden, in die Eingabezeile übernehmen und bearbeiten, mit Hinweis neu erzeugen („kürzer“, „Fokus auf Tests“), Original/Verbessert vergleichen, abbrechen. Gesendet wird nie ohne deine Bestätigung.
- **Varianten:** `/pimp` (schnell, ein Modellaufruf), `/pimp deep` (ein Erkundungs-Agent liest vorher gezielt im Repo), `/pimp kurz` (nur schärfen, nicht verlängern).
- **Vorlagen** pro Projekt (Aufbau, Sprache, Pflichtabschnitte) in `pimp.jsonc`.

### Wie es funktioniert
1. **TUI:** Slash-Befehl über `keymap.layer` mit `slash: { name: "pimp", arguments: true }`; der Rohtext hinter `/pimp` geht per RPC an den Server-Teil.
2. **Kontext sammeln (Server):**
   - `AGENTS.md`, Verzeichnisbaum, Skripte aus `package.json`/Makefile, Branch und geänderte Dateien
   - Suche nach im Prompt genannten Begriffen (Dateinamen, Symbole)
   - bisheriger Verlauf der aktuellen Session
   - Treffer aus Recall, wenn installiert („ähnliche Aufgabe am …“)
3. **Erzeugen:** `ctx.experimental.generate` mit festem Ausgabeschema (Abschnitte, Annahmen, Fragen). Bei `deep` stattdessen eine Kind-Session mit lesendem Erkundungs-Agenten.
4. **Vorschau:** großer Dialog (`ui.dialog.show`, Größe `xlarge`) mit eigenen Tastenaktionen.
5. **Übergabe:** Senden über `session.prompt`, Übernehmen in die Eingabezeile über das Ereignis `tui.prompt.append`.
6. **Rückfall ohne TUI** (Web/Desktop): Server-Befehl `/pimp`, der den verbesserten Prompt als Nachricht ohne Ausführung in die Session stellt.

### Spikes
- Kann die TUI den aktuellen Inhalt der Eingabezeile lesen und ersetzen (dann ginge `/pimp` auch ohne Argument auf den schon getippten Text)? Geprüft ist nur „anhängen“.
- Verhalten von Slash-Befehlen mit Argumenten bei mehrzeiligem Text.

---

## 7. Zusammenspiel

```
Pimp ──nutzt──▶ Recall ◀──nutzt── Regelwerk (Testdaten, Belege)
Blueprint ──Plan──▶ Cockpit ◀──Status── FiGr
Fokus ──teilt Transkript-Leser──▶ Cockpit, Recall, Regelwerk
```
Jedes Plugin läuft allein. Ist ein anderes installiert, wird es erkannt (`ctx.plugin.list`) und genutzt.

## 8. Reihenfolge

| Schritt | Inhalt | Grund |
|---|---|---|
| 0 | `plugins/kit` + Live-Spikes aller Plugins in einem Wegwerf-Plugin | klärt die offenen API-Fragen einmal für alle |
| 1 | **Pimp** | klein, sofort nützlich, erprobt RPC + Dialog + generate |
| 2 | **Cockpit** | erprobt Slots und reaktive Daten, liefert den Transkript-Leser |
| 3 | **Recall** | Index ist Grundlage für Pimp-Kontext und Regelwerk-Tests |
| 4 | **Blueprint** | größter Brocken, baut auf FiGr-Technik auf |
| 5 | **Regelwerk** | braucht echte Session-Daten zum Kalibrieren |
| 6 | **Fokus** | höchstes Risiko, hängt an den TUI-Spikes |

## 9. Offene Entscheidungen
1. **Recall semantisch:** reicht „Modell erweitert Anfrage + sortiert Treffer“, oder gibt es bei euch einen Embedding-Endpunkt?
2. **Blueprint und FiGr:** eigenständig mit Übergabe an FiGr (so geplant) oder Interview/Spezifikation direkt als Erweiterung in FiGr?
3. **Kritiker-Modell:** welches zweite Modell bzw. welcher Anbieter steht zur Verfügung?
4. **Regelwerk-Ziel:** nur Projekt-`AGENTS.md` oder auch die globale Datei?
5. **Namen:** Recall, Regelwerk, Cockpit, Fokus, Blueprint, Pimp sind Arbeitsnamen.
