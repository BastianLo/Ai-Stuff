# AiFlow – Implementierungsplan

> **Status:** Entwurf, Revision 2 (Kompatibilität mit opencode v1 und v2) · **Stand:** 2026-11-07
> **Ziel-Integration:** opencode **v1** (≥ 1.18.29) **und v2** (≥ 2.2). Geprüft gegen die Typen von `@opencode-ai/plugin` / `@opencode-ai/sdk` 1.19.5 und `@opencode/plugin` / `@opencode/client` 2.2.6 sowie die offizielle v2-Dokumentation (Migrationsleitfaden, Plugin-Doku, Tag `v2.2.6`)
> **Sprache der Umsetzung:** TypeScript

---

## Inhaltsverzeichnis

0. [Kurzfassung](#0-kurzfassung)
1. [Ziele, Nicht-Ziele, Leitprinzipien](#1-ziele-nicht-ziele-leitprinzipien)
2. [Glossar](#2-glossar)
3. [Ergänzungen gegenüber den Ausgangsideen](#3-ergänzungen-gegenüber-den-ausgangsideen)
4. [Nutzerreise von Anfang bis Ende](#4-nutzerreise-von-anfang-bis-ende)
5. [Architektur](#5-architektur)
6. [Repository-Struktur und Tech-Stack](#6-repository-struktur-und-tech-stack)
7. [Domänenmodell](#7-domänenmodell)
8. [Ausführungs-Engine](#8-ausführungs-engine)
9. [opencode-Runtime-Adapter und Worker-Rolle](#9-opencode-runtime-adapter-und-worker-rolle)
10. [opencode-Plugin: Bridge-Rolle](#10-opencode-plugin-bridge-rolle)
11. [Web-UI](#11-web-ui)
12. [API und Sicherheit](#12-api-und-sicherheit)
13. [CLI](#13-cli)
14. [Qualitätssicherung und Engineering-Standards](#14-qualitätssicherung-und-engineering-standards)
15. [Roadmap: Phasen, Aufgaben, Akzeptanzkriterien](#15-roadmap-phasen-aufgaben-akzeptanzkriterien)
16. [Beispiel-Workflows](#16-beispiel-workflows)
17. [Risiken und Spikes](#17-risiken-und-spikes)
18. [Offene Entscheidungen](#18-offene-entscheidungen)
19. [Backlog / spätere Ideen](#19-backlog--spätere-ideen)

---

## 0. Kurzfassung

**AiFlow** ist eine eigenständige, lokal laufende TypeScript-Anwendung. Mit ihr baut man feste Umsetzungs-Workflows aus selbst definierten KI-Agenten und führt sie aus. opencode ist die erste Integration, aber keine harte Abhängigkeit.

| Baustein | Aufgabe |
|---|---|
| **AiFlow-Daemon** (`127.0.0.1:5739`) | Web-UI, REST/SSE-API, Workflow-Engine, Run-Historie, Definitionen |
| **Runtime-Adapter** | Führt Agenten-Schritte aus. Erste Implementierung: ein von AiFlow gestarteter, headless `opencode serve` als „Agent-Worker“, wahlweise opencode v1 oder v2 über je einen eigenen Treiber. Dadurch werden Provider, Modelle, Tools, MCP-Server und das Berechtigungssystem von opencode wiederverwendet. |
| **Git-Workspace-Manager** | Isolierte Arbeitsverzeichnisse (git worktrees), Checkpoint je Schritt, Review- und Übernahme-Mechanik |
| **opencode-Plugin** (ein Paket für v1 und v2) | **Bridge-Rolle** in der TUI des Nutzers: `/aiflow-configure`, `/aiflow-wf-<name>`, Live-Status, Freigabe- und Review-Dialoge. **Worker-Rolle** in den Agenten-Sessions: Durchsetzung von Rechten, strukturierte Übergabe, Hilfs-Tools. |

Das Ausführungsmodell ruht auf vier Ideen:

1. **Frischer, gezielter Kontext:** Jeder Agent-Schritt läuft in einer eigenen Session mit einem genau definierten Übergabe-Paket. Es gibt keinen über den ganzen Workflow wachsenden Kontext.
2. **Strukturierte Übergabe:** Jeder Schritt endet mit einer JSON-Schema-validierten Übergabe. Daraus werden Zweig-Entscheidungen, Abstimmungen und Bedingungen deterministisch ausgewertet.
3. **Eine Regel für alle Verbindungsarten:** Pro Ausführung feuert genau **ein Ausgangsport** eines Knotens. Hängen an diesem Port mehrere Kanten, laufen sie **parallel**. Sequenz, Verzweigung, Bedingung, Parallelisierung, Schleife und Fehlerpfad folgen alle aus dieser einen Regel.
4. **Volle Nachvollziehbarkeit:** Jeder Run wird per Event-Sourcing aufgezeichnet. Pro Schritt gibt es einen Git-Checkpoint, und der exakte Prompt jedes Agenten ist einsehbar.

**Kompatibilität:** AiFlow unterstützt opencode v1 und v2 parallel. Agenten, Rechte, Übergaben und Events sind in AiFlow versionsneutral modelliert; versionsspezifische Treiber und Plugin-Shells übersetzen in die jeweilige API (Kapitel 5.5).

---

## 1. Ziele, Nicht-Ziele, Leitprinzipien

### Ziele

- **Frei definierbare Agenten**: Identität, Modell, Tool- und MCP-Rechte, Dokumentzugriffe, Ausgabe-Vertrag. Es gibt keine fest vorgegebenen Rollen.
- **Visueller Workflow-Editor** per Drag & Drop mit unterschiedlichen Verbindungsarten.
- **Hohe Ergebnisqualität durch Struktur**: Planung, harte Gates (Tests, Lint, Typecheck), mehrere spezialisierte Reviewer, Best-of-N, Feedback-Schleifen. Die Qualität soll nicht davon abhängen, dass ein einzelner Modellaufruf gut ausfällt.
- **Reproduzierbare, nachvollziehbare Runs** mit History, Diffs pro Schritt und Review vor der Übernahme.
- **Unabhängigkeit**: Die Engine kennt nur ein Runtime-Interface. opencode ist der erste Adapter, die TUI-Integration nur eine Bridge.
- **Kompatibel mit opencode v1 und v2**: v1 ab 1.18.29, v2 ab 2.2, aus einem Plugin-Paket und einem Runtime-Adapter.
- **Bedienbar aus der opencode-TUI, der Web-UI und der CLI** (CLI auch headless, z. B. in CI).

### Nicht-Ziele (vorerst)

- Kein Multi-User- oder Team-Server, keine Cloud. AiFlow läuft lokal für einen Nutzer.
- Kein eigener Agent-Loop und keine eigenen Datei- oder Shell-Tools in v1. Das liefert opencode.
- Kein Ersatz für CI/CD.
- Windows nur „best effort“. Linux und macOS haben Priorität.
- Projekte ohne git werden in v1 nicht unterstützt.

### Leitprinzipien

1. **Deterministische Orchestrierung, nicht-deterministische Agenten.** Die Engine trifft keine „weichen“ Entscheidungen. Sie wertet nur strukturierte Ausgaben, Regeln, Exit-Codes und Nutzerantworten aus.
2. **Explizit statt implizit.** Jede Schleife hat ein Limit, jedes Dokument hat Zugriffsrechte, und jeder parallele Zweig hat einen definierten Workspace.
3. **Sicher per Default.** Agenten arbeiten nie direkt im Arbeitsverzeichnis des Nutzers. Neue Agenten dürfen nur lesen. `git push` und Netzwerkzugriff sind standardmäßig aus.
4. **Tokens sind billig, Fehler sind teuer.** Weil der Tokenverbrauch keine Rolle spielt, setzt AiFlow bewusst auf Muster, die mehr Rechenaufwand gegen höhere Qualität tauschen: Verifikation, mehrere Reviewer, Best-of-N, mehrfache Abstimmung bei Entscheidungen.
5. **Alles ist inspizierbar.** Prompt, Kontext, Entscheidungen, Diffs und Dokumentversionen sind für jeden Schritt sichtbar.

---

## 2. Glossar

| Begriff | Bedeutung |
|---|---|
| **Agent (Definition)** | Wiederverwendbare Konfiguration: Identität, Modell, Rechte, Ausgabe-Vertrag. Liegt in der Agenten-Bibliothek. |
| **Baustein** | Wiederverwendbarer Instruktionstext, z. B. „Coding-Standards“ oder „Security-Checkliste“, den mehrere Agenten einbinden. |
| **Workflow** | Gerichteter Graph aus Knoten und Kanten plus Einstellungen, Dokumenten und Variablen. |
| **Knoten** | Element im Workflow: Start, Agent, Bedingung, Skript, Zusammenführung, Für-jedes, Mensch, Sub-Workflow, Ende, Notiz. |
| **Port** | Benannter Ausgang eines Knotens. Pro Ausführung feuert genau ein Port. |
| **Kante (Verbindung)** | Verbindet einen Port mit einem Knoten. Trägt die Übergabe-Konfiguration. |
| **Run** | Eine Ausführung eines Workflows mit konkreter Eingabe. |
| **Token** | Ein Ausführungsfaden im Run. Er trägt Position, Workspace-Referenz, Schleifenzähler und Parallel-Zuordnung. Parallele Zweige bedeuten mehrere Tokens. |
| **Schritt (Step)** | Eine Ausführung eines Knotens durch ein Token. Schritte sind die Einheit für History, Checkpoints und Retries. |
| **Übergabe (Handoff)** | Strukturiertes Ergebnis eines Schritts: Zusammenfassung, gewählter Zweig, Ausgabe, Hinweise für den Nächsten. |
| **Kontext-Paket** | Was ein Agent zu Beginn seines Schritts bekommt. Wird deterministisch aus Auftrag, Übergaben, Dokumenten, Diff und Journal zusammengesetzt. |
| **Workspace** | Arbeitsverzeichnis eines Tokens, in der Regel ein git worktree. |
| **Workflow-Dokument** | Vom Workflow definierte Datei, z. B. `plan.md`, mit Zugriffsrechten pro Knoten. |
| **Daemon** | Der AiFlow-Hauptprozess (API, Engine, UI). |
| **Worker** | Der von AiFlow gestartete `opencode serve`-Prozess (v1 oder v2), in dem die Agenten-Sessions laufen. |
| **opencode-Plugin** | Das AiFlow-Paket für opencode v1 und v2. Bridge-Rolle in der opencode-Instanz des Nutzers, Worker-Rolle im Worker. |
| **Treiber** | Versionsspezifischer Teil des Runtime-Adapters (v1 oder v2), der das versionsneutrale AiFlow-Modell in die jeweilige opencode-API übersetzt. |
| **Sub-Agent** | Agent, den ein Agent-Knoten zur Laufzeit startet, um Teilaufgaben zu delegieren (7.16). Läuft als Unter-Schritt dieses Knotens. |

---

## 3. Ergänzungen gegenüber den Ausgangsideen

Diese Punkte sind gegenüber den ursprünglichen Ideen hinzugekommen oder präzisiert worden. Sie sind an den jeweiligen Stellen im Dokument ausgearbeitet.

| Ergänzung | Warum |
|---|---|
| **Kompatibilität mit opencode v1 und v2** | v2 bricht Plugin- und Server-API, v1 aktualisiert sich seit 1.19 nicht mehr selbst. Ein versionsneutrales Modell mit zwei Treibern und einem Plugin-Paket deckt beide ab. |
| **Port-Semantik** als einheitliches Verbindungsmodell | Eine einfache, eindeutige Regel statt vieler Sonderfälle. Leicht zu validieren und zu visualisieren. |
| **Bedingungs-Knoten** (regelbasiert) zusätzlich zur Agent-Entscheidung | Wenn eine Entscheidung objektiv prüfbar ist, ist sie deterministisch und braucht kein LLM. |
| **Skript-Knoten** (Tests, Lint, Typecheck, Build) | Harte Qualitäts-Gates sind zuverlässiger als LLM-Urteile. Das ist der wichtigste Hebel für Codequalität. |
| **Für-jedes-Knoten** (dynamische Parallelisierung) | Der Planner erzeugt eine Aufgabenliste, und für jede Aufgabe läuft ein Implementierungs-Zweig. |
| **Sub-Agenten** (dynamische Delegation in Wellen) | Für Recherche- und Prüfaufgaben, deren Umfang erst zur Laufzeit klar wird. Ein Orchestrator bestimmt Anzahl und Art der Helfer selbst, innerhalb fester Limits. |
| **Join-Strategien**: alle, erster (Race), n von m; Abstimmung mit Mehrheit, einstimmig oder Veto | Deckt „3 Reviewer → gemeinsame Entscheidung“ deterministisch ab. |
| **Schleifen-Limits mit Eskalationsziel**, **Fehler-Ports** | Verhindert Endlosschleifen. Fehler werden zu modellierbaren Pfaden. |
| **Mensch-Knoten** sowie Weiterleitung von Agent-Rückfragen und Rechte-Anfragen | Human-in-the-Loop in TUI und Web-UI. |
| **Sub-Workflows** | Wiederverwendung, z. B. ein „Review-Paket“ als Baustein. |
| **Ausgabe-Verträge** (JSON-Schema) je Agent | Reviewer liefern z. B. `approved` und `findings[]` als auswertbare Daten. |
| **Kontext-Modi**: frisch, fortsetzen, fork | Steuert, ob ein Agent in einer Schleife sein Gedächtnis behält. |
| **Robuste Entscheidungen** (mehrere Stimmen, Mehrheit) | Reduziert Fehlentscheidungen schneller Modelle. Sinnvoll, weil Tokens nicht limitiert sind. |
| **Bausteine** und optionale **Rollen-Vorlagen** | Wiederverwendung ohne vorgegebene Agenten. |
| **Eingabe-Parameter** und **Variablen** je Workflow | z. B. Prüfbefehl einmal definieren, überall nutzen. |
| **Dokument-Features**: Vorlagen, Pflichtdokumente, Modus „anhängen“, Versionierung, Export ins Repo, **Zugriffs-Matrix** | Präzise Steuerung, wer was liest und schreibt. |
| **Git-Checkpoints je Schritt**, Zurückspulen, Wiederaufnahme nach Absturz | Nachvollziehbarkeit und Robustheit. |
| **Review**: Teil-Übernahme und „Änderungen anfordern“ zurück in den Workflow | Das Review wird zu einer echten Feedback-Schleife und ist nicht nur eine Ja/Nein-Entscheidung. |
| **Abschluss-Modi**: direkt, Review, Branch, Patch, nur Bericht | Passt sich an den jeweiligen Einsatzzweck an. |
| **Inbox** für offene Freigaben, Rückfragen und Reviews | Ein zentraler Ort für alles, was auf den Nutzer wartet. |
| **Simulation / Testlauf ohne LLM** und **Agent-Playground** | Workflows und Agenten testen, bevor sie teuer und langsam laufen. |
| **Globale und projektbezogene Definitionen** (`.aiflow/` im Repo) | Workflows können mit dem Team per git geteilt und versioniert werden. |
| **Workspace-Trust** | Workflows aus fremden Repos können Befehle ausführen. Sie laufen deshalb erst nach Bestätigung. |
| **CLI** (headless, CI-fähig) | Unabhängig von opencode und Web-UI nutzbar. |
| **Sicherheitskonzept** für den lokalen Daemon | Ein lokaler HTTP-Server, der Code ausführen lässt, ist ein Angriffsziel (CSRF, DNS-Rebinding). |
| **Analytics** | Workflows anhand von Daten verbessern: Schleifenquote, Fehlerknoten, Dauer. |

---

## 4. Nutzerreise von Anfang bis Ende

1. **Installation**: AiFlow installieren (`npm i -g aiflow` o. ä.) und `aiflow setup opencode` ausführen. Der Befehl erkennt die opencode-Version (v1 oder v2) und trägt das Plugin nach Bestätigung in der passenden Form in die globale opencode-Konfiguration ein.
2. **Konfigurieren**: In opencode `/aiflow-configure` ausführen. Läuft der Daemon noch nicht, wird er gestartet. Danach öffnet sich der Browser auf `http://localhost:5739` mit dem aktuellen Projekt als Kontext (Login über einen Einmal-Link).
3. **Agenten anlegen**: von Grund auf oder aus einer Vorlage. Zum Beispiel ein Planner, ein Implementer, ein Security-Reviewer, ein Standards-Reviewer und ein Documenter. Jeder bekommt Identität, Modell, Rechte, MCP-Zugriff und Ausgabe-Vertrag. Im Playground lässt sich ein Agent direkt ausprobieren.
4. **Workflow bauen**: Agenten-Kacheln aufs Canvas ziehen und Bausteine (Start, Skript, Zusammenführung, Ende …) ergänzen. Dann Ports verbinden, Zweige beschreiben, Dokumente definieren und Zugriffe in der Matrix setzen. Die Live-Validierung zeigt Probleme sofort. Ein Testlauf ohne LLM prüft die Logik.
5. **Speichern**: Der Command `/aiflow-wf-<name>` erscheint in opencode.
6. **Starten**: `/aiflow-wf-feature Passwort-Reset per E-Mail hinzufügen`. Der Prompt geht unverändert an AiFlow. Die Seitenleiste zeigt den Fortschritt: welcher Agent läuft, welche Entscheidungen fielen, welcher Schleifendurchlauf gerade aktiv ist.
7. **Mitwirken**: Wartet ein Mensch-Knoten oder hat ein Agent eine Rückfrage, erscheint ein Dialog in der TUI und eine Desktop-Benachrichtigung. Alternativ antwortet man über die Inbox im Browser.
8. **Abschluss**: Je nach Einstellung wird das Ergebnis direkt übernommen oder es erscheint ein Review. Der Review-Dialog in der TUI zeigt Kurzfassung und Dateiliste mit Änderungszählern und bietet „Übernehmen“, „Im Browser reviewen“, „Als Branch behalten“ und „Verwerfen“. Im Browser gibt es die vollständige PR-Ansicht mit Teil-Übernahme und „Änderungen anfordern“.
9. **Nachvollziehen**: In der History lässt sich jeder Run nachspielen: Graph, Zeitleiste, exakte Prompts, Entscheidungen, Diffs pro Schritt, Dokumentversionen.

---

## 5. Architektur

### 5.1 Überblick

```mermaid
flowchart LR
  subgraph Rechner["Rechner des Nutzers"]
    TUI["opencode TUI · v1 oder v2<br/>+ AiFlow-Plugin: Bridge-Rolle"]
    Browser["Browser<br/>AiFlow Web-UI"]
    CLI["aiflow CLI"]
    subgraph Daemon["AiFlow-Daemon · Node · 127.0.0.1:5739"]
      API["HTTP-API<br/>REST + SSE"]
      Engine["Workflow-Engine"]
      Store[("SQLite<br/>Event-Store")]
      Defs["Definitionen<br/>YAML global + Projekt"]
      WSM["Workspace-Manager<br/>git worktrees"]
      RT["Runtime-Adapter<br/>opencode-Treiber v1 / v2"]
    end
    Worker["opencode serve · headless · v1 oder v2<br/>Agent-Worker<br/>+ AiFlow-Plugin: Worker-Rolle"]
    Repo["Projekt-Repo<br/>+ Worktrees"]
  end
  LLM["LLM-Provider<br/>z. B. DeepSeek"]
  MCP["MCP-Server"]

  TUI -- "HTTP/SSE" --> API
  Browser -- "HTTP/SSE" --> API
  CLI -- "HTTP/SSE" --> API
  API --> Engine
  Engine --> Store
  Engine --> Defs
  Engine --> WSM
  Engine --> RT
  RT -- "v1: @opencode-ai/sdk<br/>v2: @opencode/client" --> Worker
  Worker --> LLM
  Worker --> MCP
  Worker --> Repo
  WSM --> Repo
```

### 5.2 Komponenten

| Komponente | Verantwortung | Kennt |
|---|---|---|
| **core** | Domänenmodell, Schemas, Graph-Validierung, Templates, Bedingungen, Run-Reducer. Kein I/O. | nichts |
| **engine** | Scheduler, Token-Logik, Kontext-Assembler, Abschluss-Phase, Joins, Limits | nur Interfaces (Ports) |
| **store** | Event-Store, Projektionen, Datei-Ablage großer Inhalte, Definitions-Repository (YAML) | core |
| **workspace-git** | Basis-Snapshots, Worktrees, Checkpoints, Diffs, Übernahme | core |
| **runtime-opencode** | Worker-Prozess, Versionserkennung, Treiber für die v1- und die v2-API, Event- und Rechte-Mapping | core, `@opencode-ai/sdk` (v1), `@opencode/client` (v2) |
| **server** | HTTP, Auth, SSE, Composition Root (verdrahtet alles) | alles |
| **web** | Web-UI | client |
| **cli** | Kommandozeile | client |
| **opencode-plugin** | Ein Paket für opencode v1 und v2: Bridge-Rolle (Commands, TUI-Ansicht, Dialoge) und Worker-Rolle (Guards, Übergabe, Hilfs-Tools) über einem gemeinsamen Kern | client, Plugin-APIs von v1 und v2 |

### 5.3 Prozessmodell

- **Daemon**: ein Prozess pro Rechner, global für alle Projekte. Start per `aiflow serve` oder automatisch durch die Bridge. Eine Lock-Datei verhindert Doppelstarts.
- **Agent-Worker**: Der Daemon startet und überwacht einen `opencode serve` (v1 oder v2, siehe 5.5) auf einem zufälligen freien Port, nur auf `127.0.0.1` und mit zufälligem Passwort. Bei einem Absturz startet er ihn mit Backoff neu. Laufende Schritte werden dann wiederholt.
  - Der Worker nutzt die normale opencode-Konfiguration des Nutzers (Provider, Auth, MCP-Server). Dort ist das AiFlow-Plugin global eingetragen. Der Daemon startet den Worker mit der Umgebungsvariable `AIFLOW_WORKER=1`; nur dann aktiviert das Plugin seine Worker-Rolle (9.3). Beim Start prüft der Daemon über die Plugin-Liste des Workers, ob das Plugin aktiv ist.
  - Sessions werden auf das jeweilige Worktree gerichtet (v1: Query-Parameter `directory`, v2: `location.directory`). So bedient **ein** Worker beliebig viele Projekte und Worktrees parallel.
- **Warum ein eigener Worker statt der laufenden TUI-Instanz?**
  - Runs überleben das Schließen der TUI.
  - Runs, die aus der Web-UI oder CLI gestartet werden, brauchen keine TUI.
  - Die Session-Liste des Nutzers bleibt sauber.
  - Rechte und Plugins für Agenten-Sessions sind getrennt steuerbar.
  - *Später optional:* ein „Attached Mode“, in dem Agenten-Sessions als Child-Sessions in der TUI sichtbar sind. In v1 liefert `PluginInput.serverUrl` die Adresse der TUI-Instanz. In v2 bietet sich der gemeinsame Hintergrunddienst an (`opencode serve --service`, `Service.ensure()` aus `@opencode/client/service`); Agenten-Sessions lassen sich dort als Kind-Sessions anlegen und in der TUI als Tab öffnen.

### 5.4 Runtime-Abstraktion

Die Engine spricht nur mit diesem Interface. Die Skizze wird in Phase 2 finalisiert.

```ts
export interface AgentRuntime {
  readonly id: string; // "opencode"
  capabilities(): RuntimeCapabilities; // structuredOutput, sessionFork, permissionRules, mcp, questions …
  listModels(): Promise<ModelInfo[]>;
  listTools(): Promise<ToolInfo[]>; // inkl. MCP-Tools, für den Agenten-Editor
  startSession(spec: SessionSpec): Promise<SessionHandle>; // Verzeichnis, Rechte, Metadaten
  run(session: SessionHandle, input: PromptInput, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  finalize<T>(session: SessionHandle, req: FinalizeRequest<T>, signal: AbortSignal): Promise<FinalizeResult<T>>;
  fork(session: SessionHandle): Promise<SessionHandle>;
  answer(request: PendingRequestRef, answer: UserAnswer): Promise<void>; // Rückfragen / Rechte-Anfragen
  abort(session: SessionHandle): Promise<void>;
}
```

Der opencode-Adapter hat zwei **Treiber** (v1, v2) hinter diesem Interface. Unterschiede meldet `capabilities()`, z. B. `structuredOutput: "format" | "tool"`, `userQuestions: "question" | "form"` oder `lsp: boolean`. Die Engine richtet sich nur nach diesen Fähigkeiten, nie nach Versionsnummern.

Spätere Adapter:

- **Direct-LLM**: OpenAI-kompatible API für reine Text-Agenten ohne Dateizugriff, z. B. Evaluator oder Decider. Schneller, weil ohne Worker-Overhead.
- **Claude Code / andere Agent-CLIs**
- **Remote-Worker**

### 5.5 opencode-Kompatibilität (v1 und v2)

opencode 2 ist seit Oktober 2026 verfügbar. Laut offiziellem Migrationsleitfaden bricht v2 bewusst an drei Stellen mit v1: **Plugin-API**, **Server-API mit Clients** und **TUI-Konfiguration**. Konfiguration sowie Agenten-, Command- und Skill-Dateien bleiben weitgehend kompatibel. AiFlow hängt genau an den ersten beiden Bruchstellen und braucht deshalb eine bewusste Doppelstrategie.

Quellen: offizieller Migrationsleitfaden und Plugin-Doku im opencode-Repository (Tag `v2.2.6`, `services/site/src/docs/content/`) sowie die Typen der npm-Pakete beider Linien. Was sich nur am laufenden System klären lässt, ist als Spike markiert (Kapitel 17).

#### 5.5.1 Unterstützte Versionen

| Linie | Unterstützt | Pakete | Bemerkung |
|---|---|---|---|
| v1 | ≥ 1.18.29, getestet mit 1.19.x | `@opencode-ai/plugin`, `@opencode-ai/sdk` | Ab 1.18.29 lädt v1 Plugins mit kombiniertem Einstiegspunkt (5.5.4). Seit 1.19 installiert v1 keine Updates mehr selbst und bietet das Upgrade auf v2 an. |
| v2 | ≥ 2.2, getestet mit 2.2.6 | `@opencode/plugin`, `@opencode/client` (optional `@opencode/sdk`) | Neue Plugin- und Server-API. Referenz für neue Funktionen. |

Wie lange v1 unterstützt wird, legt ein ADR fest. Empfehlung: so lange, wie es im Team genutzt wird.

#### 5.5.2 Strategie

1. **Versionsneutrales Modell in AiFlow:** Agenten, Rechte, Modelle, Übergaben und Events sind in `core` unabhängig von opencode definiert. Das Rechte-Modell übernimmt die ausdrucksstärkere v2-Form: geordnete Regeln `{ action, resource, effect }`, die letzte passende Regel gewinnt.
2. **Zwei Treiber im Runtime-Adapter** (`runtime-opencode/src/v1`, `…/v2`) übersetzen das Modell in die jeweilige Server-API. Unterschiede meldet `capabilities()` (5.4).
3. **Ein Plugin-Paket mit zwei dünnen Shells** (`opencode-plugin/src/v1`, `…/v2`) über einem gemeinsamen Kern: Pfad- und Rechteprüfung, Übergabe-Validierung, Command-Logik, Status-Darstellung, AiFlow-Client. Die Shells binden nur an die API und enthalten keine Logik.
4. **Versionserkennung** beim Start des Workers und beim Laden des Plugins. Konfiguration: `opencode.api: auto | v1 | v2`, optional `opencode.binary`.
5. **Tests gegen beide Linien** als Matrix in CI (14.2).

#### 5.5.3 Gegenüberstellung

| Bedarf in AiFlow | opencode v1 | opencode v2 |
|---|---|---|
| Plugin-Einstieg | Export mit `server(input, options)`, der ein Hooks-Objekt liefert | `Plugin.define({ id, setup(ctx) })`; Registrierungen über die Domänen von `ctx` |
| Plugin-Konfiguration | `"plugin": ["pkg", ["pkg", { … }]]`; lokal als Datei `.opencode/plugin/x.ts` | `"plugins": ["pkg", { "package": "pkg", "options": { … } }]` (die v1-Form wird normalisiert); lokal als Verzeichnis `.opencode/plugins/x/index.ts` |
| TUI-Teil | `@opencode-ai/plugin/tui`, Modul `{ id, tui(api) }`; Laden vermutlich über `tui.json` (Spike S6) | `./tui`-Export mit `Plugin.define` aus `@opencode/plugin/tui`; wird mit dem Server-Teil geladen |
| Slash-Command ohne LLM | TUI-Keymap-Command mit `slash`; Fallback: `command`-Eintrag per `config`-Hook, abgefangen mit `command.execute.before` | Server: `ctx.command.transform(e => e.add({ name, execute }))`, `execute` erhält den rohen Prompt; TUI: `keymap.layer` mit `slash: { name, arguments: true }` |
| Command-Liste aktualisieren | TUI-Layer neu registrieren; Server-Commands erst nach Neustart | `ctx.command.reload()`; Keymap-Layer sind reaktiv |
| Server-Client | `@opencode-ai/sdk` (`createOpencodeClient`) | `@opencode/client` (`OpenCode.make`); optional `@opencode/client/service` für den Hintergrunddienst |
| Server-Authentifizierung | Basic Auth, `OPENCODE_SERVER_PASSWORD` (Benutzername per `OPENCODE_SERVER_USERNAME`) | Basic Auth, `OPENCODE_PASSWORD`, Benutzer immer `opencode` |
| Session im Worktree | `session.create({ query: { directory } })` | `session.create({ location: { directory } })` |
| Rechte pro Session | `permission: [{ permission, pattern, action }]` | `permissions: [{ action, resource, effect }]`, geordnet; änderbar per `session.update` |
| Aktionsnamen | `bash`, `task`, `edit` / `write` / `patch` | `shell`, `subagent`, `edit` |
| `external_directory` | Standard: nachfragen | Standard: **erlaubt** |
| Agent und Modell | Pro Prompt `agent`, `system`, `tools`, `model`, `variant` | Agenten per `ctx.agent.transform` (Feld `system`); Session mit `agent` und `model`, Wechsel per `switchAgent` / `switchModel`; Modell als `provider/model#variant` |
| Temperatur, top_p | Hook `chat.params` | `ctx.session.hook("context")` → `event.options`, oder Modell-Variante |
| Zusätzlicher Kontext | Prompt-Text bzw. `system` | Instruktions-Einträge `session.instructions.entry.put` (eigene `<context>`-Blöcke, ohne zusätzlichen Turn) |
| Strukturierte Ausgabe | `format: { type: "json_schema", schema, retryCount }` | Kein `format`; Tool mit JSON-Schema-Eingabe, Schema pro Session über den `context`-Hook anpassbar |
| Ende der Arbeit erkennen | Event `session.idle` | `session.wait`; Events `session.execution.succeeded` / `failed` / `interrupted` |
| Fork, Abbruch | `session.fork`, `session.abort` | `session.fork`, `session.interrupt` |
| Events | `event.subscribe()`: `message.part.*`, `session.status` / `idle` / `error` / `diff`, `permission.asked`, `question.asked` | `client.event.subscribe({ types })`, nur live ohne Replay: `session.text.*`, `session.tool.*`, `session.step.*`, `session.execution.*`, `session.usage.*`, `permission.asked`, `form.*` |
| Tool-Aufrufe prüfen | `tool.execute.before` (Fehler werfen) | `ctx.tool.hook("execute.before")` (Fehler werfen), `ctx.permission.hook("evaluate")` |
| Shell-Umgebung | `shell.env` | `ctx.shell.hook("create.before")` |
| Eigene Tools | `tool` mit Helper `tool()` und Zod | `ctx.tool.transform` mit JSON Schema; Fortschritt über `context.progress` |
| Kompaktierung | `experimental.session.compacting` | `ctx.session.hook("compaction")` |
| Rückfragen an den Nutzer | `question`-Tool, `question.reply` | Forms (`form.created`, Form-API) |
| Plugin-Zustand | eigene Datei | `ctx.storage` |
| Kanal zwischen Plugin-Teilen und Clients | – | Plugin-RPC (`ctx.rpc.register`, `client.rpc(Vertrag)`, eigene Events) |
| TUI-Erweiterungen | Slots `sidebar_content`, `session_prompt_right`, `app_bottom`; Routen; Dialoge | Slots `sidebar.content`, `prompt.footer.status`, `home.footer.status`, **`session.panel`**; Router; Promise-Dialoge |
| Desktop-App | – | GUI-Teil `./gui-experimental` (experimentell) |
| Language-Server | vorhanden | nicht vorhanden |

#### 5.5.4 Ein Paket für beide Versionen

v2 liest aus dem Default-Export `id` und `setup()`, v1 (ab 1.18.29) ruft `server()` auf. Ein kombinierter Default-Export bedient beide; der offizielle Migrationsleitfaden beschreibt genau diese Form.

```ts
// packages/opencode-plugin/src/index.ts – kombinierter Einstiegspunkt
// Keine statischen Imports versionsspezifischer Laufzeitpakete:
// Jede Shell wird erst im passenden Pfad per dynamischem import() geladen.
export default {
  id: "aiflow",
  async setup(ctx: unknown) {
    // opencode v2
    const { setupV2 } = await import("./v2/server.js")
    return setupV2(ctx)
  },
  async server(input: unknown, options?: unknown) {
    // opencode v1
    const { serverV1 } = await import("./v1/server.js")
    return serverV1(input, options)
  },
}
```

`Plugin.define` aus `@opencode/plugin` gibt sein Argument unverändert zurück. Das Objekt-Literal ist deshalb gleichwertig und vermeidet, dass v1 ein v2-Paket laden muss.

```jsonc
// packages/opencode-plugin/package.json (Auszug)
{
  "name": "opencode-aiflow",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",   // Server-Teil: v2 setup() + v1 server()
    "./tui": "./dist/tui.js", // TUI-Teil (v2; v1 siehe unten)
    "./rpc": "./dist/rpc.js"  // RPC-Vertrag (v2) für TUI-Teil und Clients
  },
  "peerDependencies": {
    "effect": "^4.0.0",
    "@opentui/core": ">=0.6.6",
    "@opentui/solid": ">=0.6.6",
    "solid-js": ">=1.9.0"
  }
}
```

- v2 stellt `effect` und `@opencode/plugin` zur Laufzeit selbst bereit. `effect` wird nicht gebündelt.
- Der TUI-Teil wird nach demselben Muster kombiniert (`{ id, setup, tui }`), sofern v1 das unterstützt. Andernfalls bekommt v1 einen eigenen Einstiegspunkt `./tui-v1` (Spike S6).
- Ein GUI-Teil für OpenCode Desktop (`./gui-experimental`) folgt später (Phase 9).

#### 5.5.5 Auswirkungen auf das Design

- **Strukturierte Übergabe:** v1 nutzt `format: json_schema`, v2 ein Übergabe-Tool (8.4). Die Engine sieht in beiden Fällen dasselbe validierte Ergebnis.
- **Rechte:** v2 erlaubt `external_directory` standardmäßig. AiFlow setzt deshalb in jeder Session vollständige, explizite Regeln und verlässt sich nie auf Standardwerte.
- **Sampling:** v2 setzt Temperatur und Co. pro Session über den `context`-Hook oder über Modell-Varianten. DeepSeek wendet `temperature` nur bei ausgeschaltetem Thinking an; der Agenten-Editor weist darauf hin.
- **Modellreferenz:** AiFlow speichert `{ providerID, modelID, variant }`. Der v2-Treiber bildet daraus `provider/model#variant`, der v1-Treiber getrennte Felder.
- **Rückfragen:** Fragen über das v1-`question`-Tool und über v2-Forms landen in derselben Inbox.
- **LSP:** v2 startet keine Language-Server; das LSP-Lastproblem bei vielen Worktrees betrifft nur v1. Für beide Linien gilt: Prüfungen gehören in Skript-Knoten (Typecheck, Lint, Tests).
- **Todos:** in v2 standardmäßig aus; AiFlow braucht sie nicht.

---

## 6. Repository-Struktur und Tech-Stack

### 6.1 Struktur

```
plugins/aiflow/
├── PLAN.md                       # dieses Dokument
├── AGENTS.md                     # Regeln für KI-Agenten, die an AiFlow arbeiten (Phase 0)
├── README.md
├── package.json                  # pnpm-Workspace-Root: check, test, build, dev
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
├── .dependency-cruiser.cjs       # erzwingt Paketgrenzen
├── docs/
│   ├── adr/                      # Architecture Decision Records
│   └── architecture.md
├── examples/
│   ├── agents/  workflows/  snippets/   # Beispiel-Definitionen = Test-Fixtures
│   └── demo-repo/                # kleines Repo für Integrations- und E2E-Tests
└── packages/
    ├── core/                     # Domänenmodell (Zod), Validierung, Templates, Bedingungen, Reducer
    ├── engine/                   # Orchestrierung gegen Interfaces
    ├── store/                    # SQLite-Event-Store, Projektionen, YAML-Repository
    ├── workspace-git/            # Worktrees, Snapshots, Checkpoints, Diffs, Übernahme
    ├── runtime-opencode/         # AgentRuntime für opencode: Worker-Prozess, Versionserkennung
    │   └── src/{common,v1,v2}/   #   Treiber für die v1-API (@opencode-ai/sdk) und die v2-API (@opencode/client)
    ├── server/                   # Hono-App, Auth, SSE, statische Web-UI, Composition Root
    ├── client/                   # typisierter API-Client (web, cli, bridge)
    ├── cli/                      # `aiflow`
    ├── web/                      # React-Web-UI
    ├── opencode-plugin/          # npm-Paket „opencode-aiflow“ für opencode v1 und v2
    │   └── src/{core,v1,v2}/     #   gemeinsamer Kern + dünne Shells (Server-Teil, TUI-Teil, v2-RPC)
    └── testkit/                  # FakeRuntime, In-Memory-Store, Temp-Git-Repos, Fixtures
```

**Abhängigkeitsregeln** (in CI per dependency-cruiser erzwungen):

- `core` hängt von keinem anderen Paket ab, nur von `zod` und kleinen Pure-Libs.
- `engine` hängt nur von `core` und eigenen Interfaces ab. Es kennt weder SQLite noch git noch opencode.
- `store`, `workspace-git` und `runtime-opencode` hängen von `core` ab und implementieren die Ports der Engine.
- In `runtime-opencode` importieren die Treiber `v1/` und `v2/` nur `common/` und `core`, nie einander.
- `server` ist die einzige Stelle, die alles zusammensteckt.
- `client` hängt nur von `core` ab (Typen und Schemas). `web`, `cli` und `opencode-plugin` nutzen ausschließlich `client`.
- `opencode-plugin` darf keine Node-only-Abhängigkeiten haben, weil es in der Bun-Runtime von opencode läuft. `effect` wird nicht gebündelt, sondern als `peerDependency` deklariert (Vorgabe von v2). Die Shells `v1/` und `v2/` importieren nur den Plugin-Kern `core/`, nie einander.

### 6.2 Tech-Stack

| Bereich | Wahl | Begründung |
|---|---|---|
| Sprache | TypeScript 5.x, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` | Maximale Typsicherheit |
| Runtime Daemon/CLI | Node.js 24 LTS (Code bleibt Bun-kompatibel) | Verbreitet und stabil. opencode-Plugins laufen ohnehin in Bun, der Daemon soll aber nicht davon abhängen. |
| Paketmanager | pnpm Workspaces | Schnell, strikt, gut für Monorepos |
| Build | tsdown (Pakete), Vite (Web) | Einfach und schnell |
| HTTP | Hono + `@hono/node-server`, `@hono/zod-openapi` | Läuft auf Node und Bun. OpenAPI wird aus denselben Schemas erzeugt. |
| Echtzeit | Server-Sent Events mit `Last-Event-ID`-Resume | Einfacher als WebSockets, reicht für Server-zu-Client-Streams |
| Validierung | Zod 4 an allen Grenzen; JSON-Schema-Export für Ausgabe-Verträge | Dieselben Schemas in API, Dateien, Formularen und Runtime |
| Persistenz | SQLite (`better-sqlite3`) + Drizzle ORM + drizzle-kit-Migrationen | Lokal, transaktional, ohne Server |
| Definitionen | YAML (`yaml` von eemeli, erhält Kommentare) | Gut lesbar, git-freundlich, reviewbar |
| Git | System-`git` über `execa`, typisierte Wrapper | Volle Funktionalität (worktrees, merge-tree). Keine native Abhängigkeit. |
| Bedingungen | JSON Logic | Serialisierbar und sicher (kein `eval`), im UI per Regel-Builder erzeugbar |
| Templates | Logikloses Mustache-artiges Rendering, strikt | Unbekannte Variablen sind Validierungsfehler. Keine Code-Ausführung. |
| Web-UI | React 19, Vite, TanStack Router + Query, `@xyflow/react` (Canvas), elkjs (Auto-Layout), Zustand + zundo (Undo/Redo), shadcn/ui + Tailwind, Monaco (Prompts, Schemas, YAML, Diffs), react-hook-form + Zod, i18next (de/en) | Bewährte Bausteine für node-basierte Editoren |
| opencode-Anbindung | v1: `@opencode-ai/sdk`, `@opencode-ai/plugin` · v2: `@opencode/client`, `@opencode/plugin` | Offizielle Pakete der jeweiligen Linie |
| TUI-Plugin | v1: `@opencode-ai/plugin/tui` · v2: `@opencode/plugin/tui`, jeweils mit `@opentui/solid` | Offizielle TUI-Plugin-APIs |
| Logging | pino (JSON), eigene Logdatei pro Run | Strukturierte Logs mit Korrelations-IDs |
| Tests | Vitest, Playwright | Schnell, TS-nativ |
| Codequalität | ESLint (`typescript-eslint` strictTypeChecked), Prettier, dependency-cruiser, knip, lefthook | Automatisch durchgesetzte Standards |
| Pfade | `env-paths` | XDG- und macOS-konforme Daten- und Konfigurationsordner |

---

## 7. Domänenmodell

### 7.1 Überblick

```mermaid
classDiagram
  class AgentDefinition
  class Snippet
  class Workflow
  class Node
  class Port
  class Edge
  class DocumentSpec
  class Run
  class Token
  class Step
  Workflow "1" *-- "many" Node
  Workflow "1" *-- "many" Edge
  Workflow "1" *-- "many" DocumentSpec
  Node "1" *-- "1..*" Port
  Edge --> Port : von
  Edge --> Node : nach
  Node --> AgentDefinition : Agent-Knoten referenziert
  AgentDefinition --> Snippet : bindet ein
  Run --> Workflow : Snapshot einer Version
  Run "1" *-- "many" Token
  Run "1" *-- "many" Step
```

### 7.2 Agent-Definition

| Gruppe | Feld | Beschreibung |
|---|---|---|
| **Identität** | Name, ID (Slug) | ID ist eindeutig im Scope (global oder Projekt) |
| | Beschreibung | Kurztext. Erscheint in der Palette und wird anderen Agenten gezeigt, z. B. bei Übergaben. |
| | Tags / Rolle | Frei wählbar (planner, review, security …), nur zur Organisation |
| | Icon und Farbe | Darstellung der Kachel |
| | Identität (System-Prompt) | Markdown mit Template-Variablen: Rolle, Haltung, Arbeitsweise, Qualitätsmaßstäbe, Verbote |
| | Bausteine | Eingebundene wiederverwendbare Instruktionen, z. B. Coding-Standards |
| | Projekt-Instruktionen | `AGENTS.md` und Projektregeln einbeziehen (Standard: an) |
| **Modell** | Modell | Provider und Modell aus opencode (`provider.list`). Leer bedeutet Workflow- oder globaler Standard. |
| | Variante / Reasoning | z. B. `high` (opencode `variant`) |
| | Temperatur, top_p | Optional. In v2 pro Session über den Kontext-Hook bzw. eine Modell-Variante. DeepSeek wendet `temperature` nur bei ausgeschaltetem Thinking an; der Editor weist darauf hin. |
| | Max. Schritte | Maximale Tool-Call-Iterationen (opencode `steps`) |
| | Timeout | Pro Schritt |
| **Werkzeuge und Rechte** | Preset | „Nur lesen“, „Implementieren“, „Voll“, danach individuell anpassbar |
| | Regeln | Geordnete Liste `{ action, resource, effect }`, die letzte passende Regel gewinnt (Form von v2). Aktionen u. a. `read, edit, glob, grep, list, shell, webfetch, websearch, subagent, skill, external_directory`; Effekte `allow` / `ask` / `deny`. Beispiel: `shell` `git push*` → deny, `shell` `pnpm test*` → allow. Der v1-Treiber übersetzt in die v1-Form (`bash`, `task` …) und warnt, wenn eine Regelreihenfolge dort nicht exakt abbildbar ist. |
| | Rückfragen erlaubt | Darf der Agent den Nutzer fragen? (v1: `question`-Tool, v2: Forms) |
| **MCP und Skills** | MCP-Server/-Tools | Auswahl aus `mcp.status`, pro Server an oder aus, pro Tool allow oder deny |
| | Skills | Erlaubte opencode-Skills |
| **Ausgabe** | Ausgabe-Vertrag | „Freitext“ oder JSON-Schema (visueller Builder für einfache Felder, Experten-Modus als JSON), z. B. `approved: boolean`, `findings[]`, `size: enum` |
| | Übergabe-Hinweise | Was dieser Agent standardmäßig an den Nächsten weitergibt |
| **Verhalten** | Kontext-Modus (Standard) | `fresh` / `resume` / `fork` (siehe 7.9) |
| | Retries | Bei Fehler, Timeout oder ungültiger Übergabe |
| | Entscheidungs-Stimmen | n ≥ 1 (Self-Consistency, siehe 8.5) |
| | Sub-Agenten (Standard) | Standardwerte für die Delegation (7.16), im Workflow pro Knoten überschreibbar |
| **Dokumente** | Standard-Zugriffe | Vorschläge, im Workflow überschreibbar |
| **Meta** | Scope, Version, Änderungsdatum | Versionierung über Inhalts-Hash |

**Rechte-Presets:**

| Preset | Inhalt |
|---|---|
| Nur lesen *(Standard für neue Agenten)* | `read/glob/grep/list`: allow · `edit`: deny · `shell`: deny außer Allowlist (`git diff*`, `git log*`, `git show*`, `git status*`) · Netz: deny · `subagent`: deny |
| Implementieren | Wie „Nur lesen“, zusätzlich `edit`: allow (nur im Workspace) und `shell`: allow mit Denylist (`git push*`, `git reset --hard*`, `git checkout*`, `rm -rf /*`, `sudo*` …). Unbekannte Netz-Tools: ask. |
| Voll | Alles allow außer `subagent` und `git push*` |

`external_directory` ist immer `deny`, mit Ausnahme des Dokument-Ordners des Runs und (nur lesend) der Kandidaten-Worktrees nach einem Join. AiFlow setzt diese Regeln in jeder Session explizit, denn v2 erlaubt `external_directory` standardmäßig. `subagent` (Sub-Agenten von opencode, in v1 `task`) ist standardmäßig aus, weil AiFlow orchestriert. Delegation an weitere Agenten läuft stattdessen über AiFlows eigene Sub-Agenten (7.16).

### 7.3 Bausteine (Snippets)

- Wiederverwendbare Markdown-Texte mit Name, Beschreibung und Inhalt, optional mit Template-Variablen.
- Typische Beispiele: „Coding-Standards des Teams“, „Security-Checkliste (OWASP)“, „Definition of Done“, „Commit-Konventionen“, „Ausgabeformat für Review-Befunde“.
- Agenten binden Bausteine ein. Eine Änderung am Baustein wirkt auf alle Agenten, die ihn nutzen. Die Versionierung erfolgt über den Run-Snapshot.
- Dazu gehören auch **Dokument-Vorlagen**, z. B. die Gliederung für `plan.md`.

### 7.4 Rollen-Vorlagen (optional)

Es gibt keine vorgegebenen Agenten. Eine Vorlagen-Galerie hilft aber beim Start. Eine Vorlage wird beim Anlegen **kopiert** und gehört danach dem Nutzer.

| Vorlage | Kern |
|---|---|
| Anforderungs-Analyst | Präzisiert den Auftrag, listet Annahmen und offene Fragen (Rückfragen erlaubt) |
| Evaluator / Triage | Klassifiziert Aufgaben, z. B. nach Größe, Risiko oder Bereich (nur lesen, Entscheidung) |
| Architekt | Entwirft Struktur, Schnittstellen und Datenmodell, schreibt `architecture.md` |
| Planner | Zerlegt in Teilschritte mit Akzeptanzkriterien, schreibt `plan.md`, liefert `tasks[]` |
| Implementer | Setzt um, schreibt Tests, hält sich an den Plan |
| Test-Writer | Schreibt Tests vorab oder ergänzend (TDD-Workflows) |
| Debugger / Fixer | Reproduziert Fehler, findet die Ursache, behebt sie minimal |
| Refactorer | Verbessert Struktur ohne Verhaltensänderung |
| Verifier | Prüft Akzeptanzkriterien gegen die Umsetzung, Ausgabe `approved` und `gaps[]` |
| Reviewer-Varianten | Security, Code-Standards, Architektur/Design, Performance, Testqualität, Barrierefreiheit (UI). Jeweils nur lesen, Ausgabe `approved` und `findings[]`. |
| Decider / Judge | Wählt unter Kandidaten mit Begründung |
| Integrator / Merger | Führt parallele Ergebnisse zusammen und löst Konflikte |
| Documenter / Writer | Schreibt Doku, Changelog, Commit- und PR-Text |
| Researcher | Recherchiert (Web/MCP erlaubt), schreibt Notizen, nur lesen im Repo |
| Recherche-Orchestrator | Zerlegt den Informationsbedarf in Teilfragen, delegiert sie in Wellen an Explorer (Delegation erzwungen) und fasst die Ergebnisse in `research.md` zusammen |
| Explorer | Beantwortet eine eng umrissene Frage zu Code, Abhängigkeiten oder Doku, nur lesen. Ausgabe `findings[]` und `openQuestions[]` |

### 7.5 Workflow

| Feld | Beschreibung |
|---|---|
| Name, ID | ID ist eindeutig im Scope |
| Command-Name | Ergibt `/aiflow-wf-<name>`. Validiert als gültiger Command-Name. |
| Beschreibung | Erscheint in der opencode-Command-Liste und in der Web-UI |
| Eingaben | `prompt` (Pflicht) plus optionale Parameter (Text, Zahl, Boolean, Auswahl) mit Label, Standardwert und Pflicht-Flag. Daraus entstehen Formulare in Web-UI und TUI. |
| Variablen | Konstanten, z. B. `checkCommand: pnpm typecheck && pnpm lint && pnpm test` |
| Standard-Modell | Fallback für Agenten ohne eigenes Modell |
| Workspace | Basis (`working-tree` / `head` / `branch:<name>`), Setup-Befehl, Aufbewahrung |
| Dokumente | Siehe 7.10 |
| Limits | Max. Schritte, max. Dauer, max. parallele Sessions, Standard-Schleifenlimit |
| Abschluss-Standard | Siehe 7.12 |
| Benachrichtigungen | Wann der Nutzer informiert wird |
| Knoten, Kanten, Layout | Der Graph und die Canvas-Positionen |

### 7.6 Knotentypen

| Knoten | Zweck | Ausgangsports | Wichtigste Einstellungen |
|---|---|---|---|
| **Start** | Einstieg, nimmt Prompt und Parameter an | `weiter` | Eingabe-Formular |
| **Agent** | Führt einen Agenten aus | `weiter` **oder** benutzerdefinierte Zweige; optional `fehler` | Agent-Referenz, Overrides (Modell, Zusatzanweisung), Zweige, Workspace, Dokumente, Kontext-Modus, Limits, Stimmen, Sub-Agenten (7.16) |
| **Bedingung** | Deterministische Verzweigung | Benannte Regeln + `sonst` | JSON-Logic-Regeln über den Run-Kontext |
| **Skript** | Führt einen Befehl aus (Tests, Lint, Typecheck, Build, Formatter, Codegen) | `ok` / `fehlgeschlagen` oder eigene Regeln über Exit-Code und Ausgabe; optional `fehler` | Befehl (Template), Timeout, Umgebung, Kürzung der Ausgabe (Kopf und Ende) |
| **Zusammenführung (Join)** | Wartet auf parallele Zweige und kombiniert sie | `weiter` oder Abstimmungsports (z. B. `approved` / `rejected`) | Warte-Strategie, Kombinations-Strategie, Workspace-Strategie (7.8) |
| **Für jedes (Map)** | Dynamische Parallelisierung über eine Liste | `weiter` (nach dem Einsammeln), `fehler` | Quelle (z. B. `node.plan.output.tasks`), max. Parallelität, Rumpf als Agent oder Sub-Workflow, Workspace je Element, Einsammel-Strategie wie beim Join |
| **Mensch** | Freigabe oder Eingabe durch den Nutzer | Benannte Antworten (z. B. `freigegeben` / `ändern` / `abbrechen`) | Frage (Template), Optionen, Freitext erlaubt, Timeout mit Standardantwort |
| **Sub-Workflow** | Ruft einen anderen Workflow als Schritt auf | Ein Port je Ende-Knoten des Sub-Workflows | Workflow-Referenz, Eingabe-Mapping, Workspace-Übergabe |
| **Ende** | Abschluss | – | Ergebnis (`success` / `rejected` / `failed` / `cancelled`), Abschluss-Modus, Bericht-Template, Dokument-Export |
| **Notiz / Rahmen** | Nur Dokumentation und Gruppierung auf dem Canvas | – | Text, Farbe |

### 7.7 Ports und Verbindungen

**Kernregel:**

1. Jeder Knoten (außer Ende und Notiz) hat einen oder mehrere **Ausgangsports**.
2. Pro Ausführung feuert **genau ein** Port. Welcher, bestimmt der Knotentyp: der einzige Port, die Agent-Entscheidung, die Bedingungsregel, der Exit-Code, die Abstimmung, die Nutzerantwort oder der Fehler.
3. **Alle Kanten am feuernden Port werden gleichzeitig aktiviert.** Mehrere Kanten an einem Port bedeuten Parallelisierung.
4. Parallel gestartete Zweige werden über einen **Join** wieder eingesammelt, oder jeder Zweig endet in einem eigenen Ende-Knoten.
5. Eine Kante zu einem bereits durchlaufenen Knoten ist eine **Schleife** und braucht ein **Limit** mit Eskalationsziel.

**Verbindungsarten, wie der Nutzer sie im UI sieht:**

| Verbindungsart | Modellierung | Beispiel |
|---|---|---|
| **Direkt (Sequenz)** | 1 Port → 1 Kante | Planner → Implementer |
| **Verzweigung (Agent entscheidet)** | Agent-Knoten mit n Zweig-Ports. Jeder Zweig hat Name, **Beschreibung „wann wählen“** und **Übergabe-Anweisung**. | Evaluator → klein / mittel / groß; Verifier → approved / nicht approved |
| **Bedingung (regelbasiert)** | Bedingungs- oder Skript-Knoten mit Regel-Ports + `sonst` | Befunde mit `severity = critical` vorhanden → Fixer |
| **Parallel (Fan-out)** | 1 Port → n Kanten | Planner → 3 Implementer; Implementer → 3 Reviewer |
| **Dynamisch parallel** | Für-jedes-Knoten | Plan mit 5 Teilaufgaben → 5 Implementer |
| **Zusammenführung (Fan-in)** | Join-Knoten | 3 Reviewer → Join (Veto) → approved / rejected |
| **Wettlauf (Race)** | Join mit „erster gewinnt“ | Zwei Lösungsansätze, der erste mit grünen Tests gewinnt, der andere wird abgebrochen |
| **Schleife / Feedback** | Kante zurück, mit `max` und `onExceeded` | Reviewer „nicht approved“ → Implementer (max. 3, dann Mensch) |
| **Fehlerpfad** | `fehler`-Port | Implementer scheitert wiederholt → Debugger oder Mensch |
| **Eskalation an den Menschen** | Kante zu einem Mensch-Knoten | Nach 3 Fehlversuchen entscheidet der Nutzer |
| **Sub-Workflow** | Sub-Workflow-Knoten | „Security-Review-Paket“ als wiederverwendbarer Baustein |

**Eigenschaften einer Kante:**

| Eigenschaft | Beschreibung |
|---|---|
| Label | Standard ist der Portname |
| **Übergabe-Anweisung** | Was der Sender für diesen Weg mitgeben soll. Der Sender sieht sie in seiner Abschluss-Phase, der Empfänger als Überschrift seines Kontexts. Beispiel: „Liste jeden Mangel mit Datei, Zeile und konkretem Änderungsvorschlag.“ |
| **Kontext-Paket** | Welche Inhalte der Empfänger bekommt (siehe 7.9). Standardwerte kommen vom Workflow, pro Kante überschreibbar. |
| **Workspace-Übergabe** | `continue` (weiterarbeiten) / `isolate` (eigene Kopie) / `read-only` / `scratch` (leeres Verzeichnis) |
| **Schleifen-Limit** | Nur bei Rückkanten und dort Pflicht: `max`, `onExceeded` (Zielknoten), optional `resetLoopCounters` |

**Darstellung im Editor:** Zweig-Ports erscheinen als beschriftete Handles am Knoten. Mehrere Kanten an einem Handle zeigen ein Fork-Symbol. Rückkanten sind gestrichelt und tragen einen Zähler (z. B. „max. 3“). Fehlerkanten sind rot.

### 7.8 Zusammenführung (Join)

**Zuordnung:** Ein Join gehört zu genau einem Fan-out. Die Zuordnung wird automatisch ermittelt und validiert (strukturierte Parallelität, siehe 8.3).

**Warte-Strategie:**

| Strategie | Verhalten |
|---|---|
| `all` | Wartet auf alle Zweige |
| `first` | Der erste fertige Zweig gewinnt, die übrigen werden abgebrochen (Race) |
| `first-matching` | Der erste Zweig, der eine Bedingung erfüllt (z. B. Checks grün), gewinnt |
| `n-of-m` | Weiter, sobald n Zweige fertig sind. Der Rest läuft optional weiter oder wird abgebrochen. |
| Timeout | Danach mit vorhandenen Ergebnissen weitermachen oder `fehler` |

**Kombination der Ergebnisse:**

| Strategie | Verhalten |
|---|---|
| `collect` | Alle Übergaben und Ausgaben gehen als Liste an den Nachfolger, z. B. an einen Decider |
| `vote` | Wertet ein Feld der strukturierten Ausgaben aus, z. B. `output.approved`. Regeln: `majority`, `unanimous`, `veto` (ein Nein reicht für Nein), `weighted`. Erzeugt Ports nach Ergebnis. Das **Feedback aller Gegenstimmen** wird zu einem Paket zusammengeführt, z. B. als Liste aller Befunde nach Schweregrad. |
| `synthesize` | Ein am Join konfigurierter Agent fasst zusammen oder entscheidet. Das ist eine kompakte Form von „Join → Decider“. |

**Workspace-Strategie:**

| Strategie | Verhalten | Typischer Fall |
|---|---|---|
| `keep-base` | Die Zweige haben nur gelesen, der Basis-Workspace läuft weiter | Parallele Reviewer |
| `candidates` | Alle Zweig-Workspaces bleiben als Kandidaten erhalten. Der nächste Agent bekommt sie lesend und wählt per strukturierter Ausgabe `selectedCandidate` (das Schema-Feld wird automatisch ergänzt). Die Engine führt den gewählten Workspace weiter. | Best-of-3-Implementierung |
| `git-merge` | Die Zweig-Branches werden zusammengeführt. Bei einem Konflikt feuert der `konflikt`-Port, z. B. hin zu einem Integrator-Agenten. | Für-jedes über unabhängige Teilaufgaben |

### 7.9 Kontext und Übergabe

**Kontext-Modi eines Agent-Knotens:**

| Modus | Verhalten | Einsatz |
|---|---|---|
| `fresh` *(Standard)* | Neue Session, nur das Kontext-Paket | Fast immer: fokussierter, reproduzierbarer Kontext |
| `resume` | Beim erneuten Besuch desselben Knotens (Schleife) wird die eigene Session mit einer neuen Nachricht fortgesetzt, z. B. mit Feedback | Ein Implementer, der seine eigene Arbeit kennt und nur nachbessert |
| `fork` | Die Session des Vorgängers wird geforkt; der Agent sieht dessen vollständigen Verlauf | Selbstprüfung direkt nach der Implementierung |

**Kontext-Paket (konfigurierbar pro Kante, Standardwerte pro Workflow):**

| Inhalt | Standard |
|---|---|
| Ursprünglicher Auftrag des Nutzers (unverändert) | an |
| Workflow-Ziel und Position (Knoten, Schritt, Durchlauf x von max. y) | an |
| Übergabe des Vorgängers: Zusammenfassung | an |
| Übergabe des Vorgängers: Details, strukturierte Ausgabe | an |
| Feedback (bei Rückkanten: z. B. Reviewer-Befunde, Skript-Ausgabe) | an |
| Ablauf-Journal (kompakte Liste aller bisherigen Schritte und Entscheidungen) | an, gekürzt |
| Workspace-Diff seit Run-Start: `none` / `stat` / `full` | `stat` |
| Dokumente: Liste mit Pfad, Zweck und Recht; optional der Inhalt direkt eingebettet | Liste an |
| Kandidaten (nach Join mit `candidates`) | an |
| Ergebnisse der Sub-Agenten des Vorgängers: `none` / `summary` / `full` | `summary` |

**Aufbau des Prompts:** Der Kontext-Assembler baut ihn deterministisch. Er wird als Event gespeichert und ist in der Run-Ansicht exakt einsehbar.

```markdown
# AiFlow · Workflow „Feature mit Multi-Review“ · Schritt 7 · Knoten „implement“ · Durchlauf 2 von max. 3

## Auftrag des Nutzers
Füge Passwort-Reset per E-Mail hinzu …

## Deine Aufgabe in diesem Schritt
<Zusatzanweisung des Knotens bzw. Standard aus der Agent-Beschreibung>

## Bisheriger Ablauf
1. plan (Planner): Plan mit 6 Teilschritten erstellt → plan.md
2. implement (Implementer): Endpunkte und Service umgesetzt
3. checks: fehlgeschlagen (2 Tests) → zurück zu implement
4. …

## Übergabe von „verdict“ (Zweig: rejected)
Anweisung: Arbeite alle Befunde mit Schweregrad ≥ medium ab.
<zusammengeführtes Feedback der Reviewer>

## Dokumente
- plan.md · lesen · /…/runs/r_8f2/docs/plan.md · Umsetzungsplan mit Akzeptanzkriterien
- review.md · lesen · /…/runs/r_8f2/docs/review.md · Gesammelte Review-Befunde

## Arbeitsumgebung
Arbeitsverzeichnis: /…/worktrees/…/t_3 (isoliert, schreibbar)
Änderungen seit Run-Start: 9 Dateien, +412 / −37

## Abschluss
Arbeite selbstständig, bis die Aufgabe vollständig erledigt ist.
Danach wirst du um eine strukturierte Übergabe gebeten.
```

**Nachschlagen statt Vollstopfen:** Ältere Übergaben, Ausgaben und Dokumentversionen kann der Agent bei Bedarf über das Tool `aiflow_context` abrufen. Der Prompt bleibt dadurch klein, die Tiefe ist trotzdem verfügbar.

### 7.10 Workflow-Dokumente

**Definition auf Workflow-Ebene:**

| Feld | Beschreibung |
|---|---|
| Name | z. B. `plan.md`, `verification.md`, `decisions.json` |
| Zweck | Wird den Agenten angezeigt |
| Format | `markdown` / `text` / `json` (mit JSON-Schema, gegen das validiert wird) |
| Vorlage | Startinhalt bzw. Gliederung |
| Pflicht am Ende | Run schlägt fehl bzw. fordert nach, wenn das Dokument fehlt oder leer ist |
| Export | Bei Abschluss ins Repo übernehmen, mit Pfad-Template, z. B. `docs/plans/{{run.date}}-{{run.slug}}.md` |
| Im Review zeigen | Erscheint in der Review-Ansicht |

**Zugriffsrechte pro Knoten:**

| Recht | Bedeutung | Prüfung |
|---|---|---|
| `–` | Kein Zugriff, Dokument ist unsichtbar | Lesen und Schreiben blockiert |
| `R` (lesen) | Nur lesen | Schreiben blockiert, Integritätsprüfung |
| `A` (anhängen) | Nur ergänzen, z. B. für mehrere Reviewer in `review.md` | Neuer Inhalt muss mit dem alten beginnen |
| `W` (schreiben) | Lesen und Schreiben | – |
| `W!` (muss schreiben) | Schreiben ist Pflicht in diesem Schritt | Unverändert → Nachforderung, dann `fehler` |

**Zugriffs-Matrix im Editor:** Zeilen sind Knoten, Spalten sind Dokumente, die Zellen sind per Klick umschaltbar.

```
                plan.md   review.md   decisions.json
Planner          W!          –            W
Implementer      R           R            R
Security-Rev.    R           A            –
Standards-Rev.   R           A            –
Documenter       R           R            R
```

**Technische Umsetzung:**

- **Speicherort:** `<data>/runs/<runId>/docs/`, also **außerhalb** der Worktrees. Dadurch gibt es keine Kopien und Konflikte zwischen parallelen Zweigen, und die Dokumente landen nicht im Code-Diff.
- **Zugriff:** Agenten nutzen ihre normalen Datei-Tools mit dem absoluten Pfad aus dem Kontext-Paket. Das ist robuster als Spezial-Tools.
- **Durchsetzung in drei Stufen:**
  1. Das Session-Permission-Ruleset (`read` / `edit` / `external_directory` mit Pfadmustern).
  2. Das AiFlow-Plugin blockiert in seiner Worker-Rolle unerlaubte Zugriffe hart, mit einer verständlichen Fehlermeldung an den Agenten (v1 `tool.execute.before`, v2 `tool.hook("execute.before")` bzw. `permission.hook("evaluate")`).
  3. Eine Integritätsprüfung nach jedem Schritt (Hash-Vergleich). Unerlaubte Änderungen, z. B. über `bash`, werden zurückgesetzt und als Warn-Event protokolliert.
- **Versionierung:** Nach jedem Schritt mit Schreibrecht wird ein Snapshot gespeichert. Die Run-Ansicht zeigt den Versionsverlauf mit Diff.
- **Parallelität:** Dürfen zwei parallele Zweige dasselbe Dokument schreiben (`W`), ist das ein Validierungsfehler. Erlaubt ist nur `A`; die Anhänge werden dann in fester Reihenfolge zusammengeführt.

### 7.11 Arbeitsverzeichnisse (Workspaces)

**Grundprinzip:** Agenten arbeiten nie direkt im Arbeitsverzeichnis des Nutzers. Jeder Run hat einen eigenen Workspace, und jedes Token trägt eine Workspace-Referenz (Worktree-Pfad und aktueller Commit).

- **Basis-Snapshot:** Beim Run-Start wird der aktuelle Stand des Nutzer-Arbeitsverzeichnisses als Commit-Objekt festgehalten, **inklusive uncommitted und untracked Dateien** (ohne ignorierte). Index und Arbeitsverzeichnis des Nutzers bleiben dabei unberührt. Technik: temporärer Index, d. h. `GIT_INDEX_FILE=<tmp> git add -A`, dann `git write-tree` und `git commit-tree`. Alternativ kann die Basis `HEAD` oder ein Branch sein.
- **Versteckte Refs:** Alle Run-Commits liegen unter `refs/aiflow/runs/<runId>/…`. Sie tauchen nicht in `git branch` auf, sind aber vor Garbage Collection geschützt.
- **Speicherort:** `<data>/worktrees/<projekt-hash>/<runId>/<tokenId>`, außerhalb des Repos. So gibt es keine Störungen durch Datei-Watcher, IDE-Indexer oder Test-Runner.

**Workspace-Modi** pro Agent-Knoten, als Standard über die Kante überschreibbar:

| Modus | Verhalten |
|---|---|
| `continue` *(Standard)* | Arbeitet im Workspace des eingehenden Tokens weiter |
| `isolate` | Neues Worktree ab dem aktuellen Commit des Vorgängers. **Pflicht** für parallele, schreibende Zweige (der Validator erzwingt das). |
| `read-only` | Workspace des Vorgängers ohne Schreibrecht. Parallele Reviewer teilen sich einen Workspace. |
| Schreibbereich | Zusätzlich zu `continue` oder `isolate`: Schreibrecht nur für Pfadmuster, z. B. `docs/**` für den Documenter oder `packages/api/**` |
| `scratch` | Leeres temporäres Verzeichnis für Recherche oder Prototypen ohne Repo-Bezug |
| `external` | Expliziter Pfad, z. B. ein anderes Repo. Nur nach Bestätigung (Workspace-Trust). |

**Weitere Mechanik:**

- **Checkpoints:** Nach jedem Schritt wird im Worktree committet (`aiflow: <knoten> · Schritt <n>`). Daraus ergeben sich Diffs pro Schritt, Zurückspulen und Wiederaufnahme nach einem Absturz.
- **Grenzprüfung:** Nach jedem Schritt prüft AiFlow, ob der Diff nur erlaubte Pfade betrifft. Bei einem Verstoß folgt eine Nachforderung oder ein Fehler.
- **Setup-Befehl** pro Workflow oder Projekt, z. B. `pnpm install --frozen-lockfile --prefer-offline`. Er läuft nach jeder Worktree-Erzeugung. Der pnpm-Store macht das per Hardlinks schnell. Optional gibt es den Modus „node_modules verlinken“: schnell, aber nur sicher bei identischem Lockfile.
- **Aufräumen:** Nach Abschluss werden die Worktrees entfernt. Die Refs bleiben für die History erhalten, bis der Run gelöscht wird. Die Aufbewahrung ist konfigurierbar (Standard: 14 Tage).

### 7.12 Abschluss (Ende-Knoten)

**Abschluss-Modi:**

| Modus | Verhalten |
|---|---|
| `apply` (direkt übernehmen) | Der Diff von Basis zu Ergebnis wird per 3-Wege-Merge ins Arbeitsverzeichnis des Nutzers übernommen. Bei Konflikten fällt AiFlow automatisch auf `review` zurück. |
| `review` (PR-Ansicht) | Der Run wartet im Zustand „Review ausstehend“. Die Entscheidung fällt in der Web-UI oder im TUI-Dialog. |
| `branch` | Das Ergebnis wird als normaler Branch `aiflow/<workflow>/<datum>-<kurz-id>` angelegt, optional mit einer Commit-Nachricht aus einer Agent-Ausgabe. Weiter geht es über den klassischen PR-Weg. |
| `patch` | Export als `.patch`-Datei |
| `none` (nur Bericht) | Kein Code-Ergebnis, z. B. bei Analyse- und Recherche-Workflows |

Dazu kommen ein **Abschlussbericht** (Template; Standard: Zusammenfassung, Entscheidungen, geänderte Dateien, offene Punkte, Dokumente), der **Dokument-Export** ins Repo und das **Ergebnis** (`success` / `rejected` / `failed` / `cancelled`). Mehrere Ende-Knoten sind erlaubt, z. B. „Ende: umgesetzt“ und „Ende: abgelehnt“.

**Review-Aktionen:**

| Aktion | Wirkung |
|---|---|
| Alles übernehmen | 3-Wege-Übernahme |
| Auswahl übernehmen | Pro Datei, später auch pro Hunk |
| **Änderungen anfordern** | Kommentare und allgemeines Feedback werden zu einer Übergabe. Der Run läuft ab einem konfigurierbaren Knoten weiter (Standard: der letzte schreibende Agent-Knoten). Es gelten die Limits. |
| Als Branch behalten | Wie Modus `branch` |
| Verwerfen | Run-Ergebnis `rejected`, Worktrees werden aufgeräumt |

**Konflikterkennung:** Hat der Nutzer seit dem Run-Start dieselben Dateien geändert, werden sie markiert. Die Übernahme läuft als 3-Wege-Merge (`git merge-tree` bzw. `git apply --3way`) mit Konfliktanzeige.

### 7.13 Variablen, Templates, Bedingungen

**Namensraum** für Templates (Prompts, Fragen, Befehle, Pfade) und Bedingungen:

| Variable | Inhalt |
|---|---|
| `input.prompt`, `input.<param>` | Eingaben des Runs |
| `vars.<name>` | Workflow-Variablen |
| `run.id`, `run.date`, `run.slug`, `run.workflow` | Run-Metadaten |
| `node.<id>.summary`, `node.<id>.output.<feld>`, `node.<id>.branch`, `node.<id>.visits` | Ergebnisse und Zähler von Knoten |
| `script.<id>.exitCode`, `script.<id>.output` | Ergebnisse von Skript-Knoten |
| `join.<id>.votes`, `join.<id>.feedback` | Ergebnisse von Joins |
| `docs.<name>.path`, `docs.<name>.content` | Dokumente |
| `workspace.diffStat`, `workspace.changedFiles` | Workspace-Zustand |
| `edge.feedback`, `loop.iteration`, `loop.max` | Kontext der aktuellen Kante |

- **Templates:** logikfrei und strikt. Unbekannte Variablen sind ein Validierungsfehler im Editor. Der Monaco-Editor bietet Autovervollständigung aus dem Variablen-Katalog.
- **Bedingungen:** JSON Logic, mit eigenen Operatoren wie `count`, `matches` (Regex) und `severityAtLeast`. Im UI gibt es einen Regel-Builder (Feld – Operator – Wert) und einen Experten-Modus mit JSON. Wo möglich wird gegen die Ausgabe-Schemas typgeprüft, z. B. „Feld `approved` existiert und ist Boolean“.

### 7.14 Speicherorte und Formate

| Ort | Inhalt |
|---|---|
| `~/.config/aiflow/` | `config.yaml`, `auth-token`, `agents/`, `workflows/`, `snippets/`, `templates/` (global) |
| `<repo>/.aiflow/` | `agents/`, `workflows/`, `snippets/`, `templates/` (projektbezogen, per git teilbar; bei gleicher ID überschreibt die Projekt-Definition die globale) |
| `~/.local/share/aiflow/` | `aiflow.db`, `runs/<id>/` (Transkripte, Dokumentversionen, Berichte), `worktrees/`, `logs/` |

Jede Datei trägt `schema: aiflow/<typ>@<version>`. Beim Laden werden ältere Versionen automatisch migriert. Beim Zurückschreiben bleiben Kommentare erhalten.

**Beispiel: Agent**

```yaml
# .aiflow/agents/security-reviewer.yaml
schema: aiflow/agent@1
id: security-reviewer
name: Security-Reviewer
description: Prüft Änderungen auf Sicherheitslücken (OWASP Top 10, Secrets, Injection, AuthZ).
tags: [review, security]
appearance: { icon: shield, color: "#d9480f" }

identity: |
  Du bist ein erfahrener Application-Security-Engineer.
  Du prüfst ausschließlich die Änderungen dieses Runs ({{workspace.diffStat}}) …
snippets: [security-checklist, review-output-format]
includeProjectInstructions: true

model:
  ref: deepseek/deepseek-v4.1-flash
  variant: high
  temperature: 0.2               # bei DeepSeek nur ohne Thinking wirksam (5.5.5)
limits: { maxSteps: 60, timeout: 20m, retries: 1 }

permissions:
  preset: read-only
  rules:                         # geordnet, die letzte passende Regel gewinnt
    - { action: shell, resource: "*",         effect: deny }
    - { action: shell, resource: "git diff*", effect: allow }
    - { action: shell, resource: "git log*",  effect: allow }
    - { action: shell, resource: "git show*", effect: allow }
  questions: false
mcp:
  allow: [context7]

output:
  type: json
  schema:
    type: object
    required: [approved, findings]
    properties:
      approved: { type: boolean }
      findings:
        type: array
        items:
          type: object
          required: [severity, message]
          properties:
            severity: { enum: [critical, high, medium, low, info] }
            file: { type: string }
            line: { type: integer }
            message: { type: string }
            suggestion: { type: string }

contextMode: fresh
```

Ein vollständiges Workflow-Beispiel steht in [16.3](#163-multi-review-mit-veto-und-feedback-schleife-vollständiges-yaml).

### 7.15 Versionierung

- Jede gespeicherte Änderung ergibt eine neue Version (Inhalts-Hash, Zeitstempel). Versionen lassen sich vergleichen (YAML-Diff) und wiederherstellen.
- **Ein Run speichert einen vollständigen Snapshot**: den Workflow, alle referenzierten Agenten, Bausteine und Vorlagen. Die History bleibt dadurch exakt, auch wenn Definitionen später geändert oder gelöscht werden.
- „Erneut ausführen“ ist mit der damaligen oder der aktuellen Version möglich. Zusammen mit dem Run-Vergleich lassen sich Workflow-Versionen so A/B-testen.

### 7.16 Sub-Agenten (dynamische Delegation)

Manche Aufgaben lassen sich nicht vorab als Graph zerlegen. Wie viel Recherche ein Feature braucht, weiß erst der Agent, der sich damit beschäftigt. Dafür kann ein Agent-Knoten **Sub-Agenten** starten. Im Graphen bleibt der Knoten ein einzelner Schritt; die Sub-Agenten laufen als Unter-Schritte innerhalb dieses Schritts.

**Ablauf in Wellen:**

1. Der Agent, z. B. ein Recherche-Orchestrator, analysiert den Auftrag und delegiert eine **Welle** von Teilaufgaben. Jede Teilaufgabe nennt einen Agenten, einen Auftrag und das erwartete Ergebnis.
2. AiFlow startet die Sub-Agenten bis zur maximalen Parallelität; weitere warten in einer Warteschlange. Sobald die Welle fertig ist, bekommt der Orchestrator alle Ergebnisse gesammelt zurück.
3. Der Orchestrator wertet aus. Bleibt etwas unklar, startet er die nächste Welle. Sonst schließt er mit seiner Übergabe ab, und der Workflow geht weiter.

```mermaid
flowchart LR
  S([Start]) --> O
  subgraph RO["Knoten „Recherche“ · ein Schritt im Workflow"]
    direction TB
    O["Recherche-Orchestrator<br/>plant die nächste Welle"] -->|aiflow_delegate| W["Explorer A · Explorer B · Explorer C<br/>parallel, max. 4"]
    W -->|Ergebnisse der Welle| Q{"Noch etwas unklar<br/>und Budget übrig?"}
    Q -->|ja| O
  end
  Q -->|nein · Übergabe| P["Planner"]
```

**Einstellungen am Agent-Knoten.** Standardwerte lassen sich in der Agent-Definition hinterlegen; der Knoten überschreibt sie.

| Einstellung | Bedeutung | Standard |
|---|---|---|
| Sub-Agenten aktiv | Darf dieser Knoten Sub-Agenten starten? | aus |
| Erlaubte Agenten | Mehrfachauswahl aus der Bibliothek. Nur diese kann der Agent starten. Ihre Beschreibungen stehen in seinem Kontext, damit er weiß, wofür welcher Agent taugt. Der eigene Agent ist erlaubt, z. B. ein Verifier, der weitere Verifier startet. | – (Pflicht, wenn aktiv) |
| Delegationsmodus | `optional`: Der Agent darf delegieren oder selbst arbeiten, z. B. ein Verifier, der große Prüfungen aufteilt und kleine selbst erledigt. `erzwungen`: Der Agent darf nicht selbst arbeiten. Seine Arbeits-Tools (Lesen und Suchen im Repo, Shell, Web, Schreiben) sind entzogen, und vor der Übergabe muss mindestens eine Delegation stattgefunden haben, z. B. beim Recherche-Orchestrator. Einzelne Tools lassen sich gezielt wieder freigeben, etwa `list` für einen Überblick über die Verzeichnisstruktur. | `optional` |
| Max. parallele Sub-Agenten | Wie viele gleichzeitig laufen; weitere warten. Zusätzlich gilt das globale Session-Limit (8.8). | 4 |
| Max. Sub-Agent-Runs | Gesamtbudget über alle Wellen dieses Schritts | 12 |
| Max. Wellen | Optionales Limit für die Anzahl der Delegationsrunden | – |
| Verschachtelungstiefe | Dürfen Sub-Agenten selbst Sub-Agenten starten? `0` = nein | 0 |
| Workspace der Sub-Agenten | `read-only`: Sie teilen sich den Workspace des Knotens (Explorer, Verifier). `isolate`: eigene Worktrees; die Ergebnisse werden wie beim Join per `git-merge` oder `candidates` zurückgeführt (7.8). | `read-only` |
| Dokument-Rechte der Sub-Agenten | Höchstens die Rechte des Knotens | lesen |
| Kontext für Sub-Agenten | Was zusätzlich zur Teilaufgabe mitgeht: Auftrag des Nutzers, Workflow-Ziel, Dokumentliste | Auftrag + Dokumente |
| Timeout je Sub-Agent | Danach wird der Sub-Agent abgebrochen und als `failed` gemeldet | 20 min |

**Verhalten an den Grenzen:**

- **Budget erschöpft:** Das Delegations-Tool antwortet mit einer klaren Meldung, z. B. „Budget erschöpft, schließe mit dem bisherigen Stand ab“. Der Orchestrator muss dann abschließen.
- **Nicht erlaubter Agent:** Tool-Fehler mit der Liste der erlaubten Agenten.
- **Sub-Agent scheitert:** Er erscheint mit Status `failed` und Grund im Ergebnis. Der Orchestrator entscheidet, ob er neu delegiert; der Knoten selbst scheitert dadurch nicht.
- **Abbruch oder Timeout des Knotens** bricht alle Sub-Agenten ab.

**Abgrenzung zum Für-jedes-Knoten:**

| | Für jedes | Sub-Agenten |
|---|---|---|
| Wer bestimmt Anzahl und Art | Eine Liste aus einer strukturierten Ausgabe; ein fester Rumpf | Der Agent selbst zur Laufzeit, aus den erlaubten Agenten |
| Runden | eine | beliebig viele Wellen bis zum Budget |
| Im Graphen | Jeder Rumpf ist sichtbar, mit eigenen Knoten (Checks, Reviews …) | Ein Knoten mit aufklappbaren Unter-Schritten |
| Typischer Einsatz | Teilaufgaben eines Plans mit eigener Prüf-Pipeline umsetzen | Recherche, Analyse, große Prüfungen aufteilen |

**Warum nicht die Sub-Agenten von opencode?** opencode kann selbst Sub-Agenten starten (v1 `task`, v2 `subagent`). AiFlow nutzt das bewusst nicht. Erlaubte Agenten, Limits, Workspaces und Dokument-Rechte sollen in AiFlows Hand liegen. Jeder Sub-Agent soll in History, Run-Ansicht und TUI erscheinen und eine strukturierte Übergabe liefern. Und der Mechanismus soll auch mit anderen Runtimes funktionieren. Die opencode-Aktion `subagent` bzw. `task` bleibt deshalb gesperrt.

---

## 8. Ausführungs-Engine

### 8.1 Ablauf eines Agent-Schritts

```mermaid
sequenceDiagram
  participant E as Engine
  participant W as Workspace-Manager
  participant R as Runtime (opencode)
  participant S as Event-Store
  E->>W: Workspace bereitstellen (ggf. Worktree + Setup)
  E->>E: Rechte berechnen, Kontext-Paket bauen, Prompt rendern
  E->>S: step.started, step.context_built (exakter Prompt)
  E->>R: startSession(directory, permission, metadata)
  E->>R: run(prompt)
  R-->>E: Events (Text, Tool-Calls, Diffs, Todos, Fragen)
  E->>S: gebündelte Step-Events
  R-->>E: idle
  E->>R: finalize(JSON-Schema: summary, branch, output …)
  R-->>E: Übergabe (validiert, ggf. Nachforderung)
  E->>E: Nachprüfung (Pflichtdokumente, Integrität, Schreibbereich)
  E->>W: Checkpoint-Commit
  E->>S: step.handoff, step.decision, step.completed (+ Metriken)
  E->>E: Port bestimmen → Tokens für Nachfolger
```

1. **Vorbereitung:** Workspace bereitstellen, Dokument-Rechte berechnen, Kontext-Paket zusammenbauen, Prompt rendern. Der Prompt wird als Event gespeichert.
2. **Arbeitsphase:** Session anlegen (Worktree als Arbeitsverzeichnis, Rechte-Regeln, `metadata` = `{ runId, stepId }`), Prompt asynchron senden, Events streamen. Die Phase endet, sobald die Session untätig ist (v1 `session.idle`, v2 `session.execution.succeeded` bzw. `session.wait`).
3. **Abschluss-Phase:** Die Engine fordert in derselben Session die Übergabe an (v1 per `format: json_schema`, v2 per Übergabe-Tool; 8.4).
4. **Nachprüfung:** Pflichtdokumente vorhanden? Dokument-Integrität gewahrt? Diff nur in erlaubten Pfaden? Bei einem Verstoß folgt eine Nachforderung in der Session, danach `fehler`.
5. **Abschluss:** Checkpoint-Commit, Dokument-Snapshots, Metriken (Dauer, Tokens, Tool-Calls, Retries).
6. **Weiterleitung:** Port bestimmen und Tokens für die Nachfolger erzeugen.

**Skript-Schritt:** Der Befehl läuft im Worktree (eigene Prozessgruppe, Timeout, Umgebung). Exit-Code und Ausgabe werden erfasst (gekürzt auf Anfang und Ende, die volle Ausgabe wird als Datei gespeichert). Danach werden die Port-Regeln ausgewertet. Die Ausgabe steht als `script.<id>.output` für Feedback-Kanten bereit.

### 8.2 Scheduler und Token-Semantik

- **Event-getriebene Schleife:** Eine Warteschlange bereiter Aktivierungen wird von typ-spezifischen Executors abgearbeitet. Ergebnisse werden über einen **reinen Reducer** `(state, event) → state` (in `core`) angewendet. Das ist vollständig unit-testbar.
- **Fan-out:** erzeugt eine Fan-out-ID. Die Kind-Tokens erben den Workspace gemäß dem Workspace-Modus ihrer Kante.
- **Join:** sammelt Tokens mit passender Fan-out-ID und feuert gemäß Strategie. Überzählige Tokens (Race) werden abgebrochen.
- **Für-jedes:** erzeugt n Tokens mit Index und Element, begrenzt durch die maximale Parallelität, und sammelt wie ein Join ein.
- **Run-Ende:** Der Run endet, wenn kein aktives Token mehr existiert. Erreicht ein Token ein Ende mit Ergebnis `failed` oder `cancelled`, werden alle anderen Tokens abgebrochen.

### 8.3 Strukturelle Regeln (Validator)

| Regel | Schwere |
|---|---|
| Genau ein Start-Knoten; mindestens ein Ende erreichbar | Fehler |
| Jeder Knoten ist vom Start erreichbar und kann ein Ende erreichen | Fehler |
| Agent-Entscheidungen haben ≥ 2 Zweige, jeder mit Beschreibung | Fehler |
| Bedingungen haben einen `sonst`-Port | Fehler |
| Jeder Zyklus enthält mindestens eine Kante mit `max` und gültigem `onExceeded` | Fehler |
| **Strukturierte Parallelität**: Jeder Fan-out mündet in genau einen Join oder alle Zweige enden in Ende-Knoten. Rückkanten springen nicht aus einem parallelen Bereich hinaus (außer über den Join). | Fehler |
| Parallele Zweige mit Schreibrecht nutzen `isolate` | Fehler |
| Parallele Zweige mit `W` auf dasselbe Dokument | Fehler (nur `A` erlaubt) |
| Pflichtdokument hat keinen Schreiber vor dem ersten Leser | Warnung |
| Join-Abstimmung referenziert ein Feld, das im Ausgabe-Vertrag aller Zweige existiert | Fehler |
| Template-Variablen existieren; Agent-, Baustein- und Sub-Workflow-Referenzen existieren; Sub-Workflows sind nicht rekursiv | Fehler |
| Command-Name ist gültig und eindeutig | Fehler |
| Sub-Agenten aktiv: erlaubte Agenten nicht leer und vorhanden; Budget ≥ Parallelität; bei `isolate` ist eine Rückführung (`git-merge` oder `candidates`) gesetzt | Fehler |
| Sub-Agenten mit Verschachtelungstiefe > 1 | Warnung |
| Agent ohne Schreibrecht steht vor einem Knoten mit Workspace-Modus `continue`, der Änderungen erwartet | Hinweis |

Strukturierte Parallelität verhindert Deadlocks und verwaiste Tokens und hält die Join-Zuordnung eindeutig.

### 8.4 Strukturierte Übergabe

Das Schema der Abschluss-Phase wird pro Knoten generiert:

```jsonc
{
  "type": "object",
  "required": ["summary", "branch", "branchReason", "handoff", "output"],
  "properties": {
    "summary":      { "type": "string", "description": "Was wurde getan bzw. entschieden? Höchstens 10 Sätze." },
    "branch":       { "enum": ["approved", "rejected"],
                      "description": "approved: <Zweig-Beschreibung> · rejected: <Zweig-Beschreibung>" },
    "branchReason": { "type": "string" },
    "handoff":      { "type": "string",
                      "description": "Übergabe passend zum gewählten Zweig. approved: <Anweisung> · rejected: <Anweisung>" },
    "output":       { /* Ausgabe-Vertrag des Agenten */ },
    "selectedCandidate": { "enum": ["impl-a", "impl-b", "impl-c"] } // nur nach Join mit `candidates`
  }
}
```

- Felder erscheinen nur, wenn sie relevant sind: `branch` nur bei mehreren Ports, `output` nur bei einem Ausgabe-Vertrag.
- Die Validierung erfolgt doppelt: durch die Runtime (v1: `retryCount`, v2: Tool-Eingabeschema) und durch AiFlow (Zod/Ajv). Ist die Übergabe ungültig, folgt eine Nachforderung mit konkreter Fehlermeldung. Danach wird mit frischer Session wiederholt, und erst dann feuert `fehler`.
- **Fallback**, falls ein Modell `json_schema` unzuverlässig umsetzt: Die Antwort wird nach einem JSON-Block durchsucht, validiert und bei Bedarf nachgefordert.

**Umsetzung je opencode-Linie:**

- **v1:** Folge-Prompt mit `format: { type: "json_schema", schema, retryCount }`.
- **v2:** Es gibt kein `format` mehr. Das Plugin registriert das Tool `aiflow_handoff`. Über den `context`-Hook bekommt es pro Session das knotenspezifische Eingabeschema, d. h. das Schema oben. Der Abschluss-Prompt fordert den Aufruf an. Das Tool validiert die Eingabe und meldet Schemafehler als Tool-Fehler zurück, sodass das Modell sofort korrigieren kann. Geht die Session in den Leerlauf, ohne dass eine gültige Übergabe vorliegt, fordert der `experimental.idle`-Hook sie per synthetischer Nachricht in derselben Ausführung nach. Fällt dieser experimentelle Hook weg, übernimmt die Engine die Nachforderung mit einem normalen Folge-Prompt.

### 8.5 Robuste Entscheidungen

- **Entscheidungs-Stimmen** (`votes: n`): Nach der Arbeitsphase wird die Session n-mal geforkt (`session.fork`), und jede Kopie trifft ihre Entscheidung. Die Mehrheit gewinnt. Alle Begründungen landen im Entscheidungs-Log. Das kostet Tokens, aber genau das ist hier der richtige Tausch.
- **Konservativer Fallback-Zweig** pro Entscheidung (z. B. `rejected`): Er greift bei Gleichstand, bei ungültiger Übergabe nach allen Retries oder bei Unklarheit.
- **Empfehlung im Editor:** Was objektiv prüfbar ist, prüft ein Skript-Knoten (Tests, Lint, Typecheck) vor den LLM-Reviews. LLM-Reviewer bewerten dann nur noch, was ein Skript nicht prüfen kann.
- **Option in v2:** `experimental.generate.decisions` beantwortet Auswahl-, Ja/Nein- und Bewertungsfragen zustandslos und strukturiert. Damit lässt sich eine Zweigentscheidung zusätzlich unabhängig gegenprüfen, z. B. anhand von Übergabe und Diff-Statistik. Die API ist experimentell und deshalb nur optional.

### 8.6 Schleifen, Limits, Budgets

- **Pflicht-Limit pro Rückkante** (`max`) mit Eskalationsziel `onExceeded`, z. B. ein Mensch-Knoten oder `Ende: failed`.
- **Max. Besuche pro Knoten** als zusätzliches Sicherheitsnetz.
- **Run-Budgets:** max. Schritte, max. Dauer, max. parallele Sessions, optional ein Token-Budget (informativ).
- **Iterationsinfo im Kontext**, z. B. „Durchlauf 2 von 3, bisheriges Feedback: …“. Der Agent weiß dadurch, dass er nachbessert und nicht neu beginnt.
- **`resetLoopCounters`** an Kanten, z. B. wenn der Nutzer nach einer Eskalation „weiter versuchen“ wählt.
- **Stagnationserkennung** (Phase 8): Wiederholt sich das Feedback, ist der Diff leer oder sind dieselben Tests zweimal rot, wird früher eskaliert.

### 8.7 Fehlerbehandlung

| Fehlerklasse | Beispiele | Behandlung |
|---|---|---|
| Runtime | Provider-Fehler, Rate-Limit, Netzwerk, Worker-Absturz | Automatische Retries mit exponentiellem Backoff |
| Agent | Ungültige Übergabe, Pflichtdokument fehlt, Schreibbereich verletzt | Nachforderung in der Session, dann Retry mit frischer Session, dann `fehler`-Port |
| Timeout | Schritt überschreitet das Zeitlimit | Abbrechen, dann Retry bzw. `fehler` |
| Infrastruktur | git-Fehler, Setup-Befehl schlägt fehl, Platte voll | Run **pausiert** mit klarer Meldung und kann manuell fortgesetzt werden |
| Nutzer | Abbruch | Status `cancelled` |

Hat der betroffene Knoten keinen `fehler`-Port, endet der Run mit `failed`. Die Workspaces bleiben für die Analyse erhalten.

### 8.8 Parallelität und Ressourcen

- Ein globaler Semaphor begrenzt die Agent-Sessions (Standard 4, konfigurierbar; Rate-Limits des Providers beachten) und verteilt sie fair zwischen Runs.
- Skript-Knoten haben einen eigenen Semaphor, weil sie CPU-lastig sind (Standard: Anzahl der CPU-Kerne / 2).
- Optional werden Setup-Befehle pro Projekt serialisiert.
- Pro Projekt kann immer nur eine Übernahme gleichzeitig laufen (Lock).

### 8.9 Human-in-the-Loop

- **Mensch-Knoten:** Frage und Optionen (optional mit Freitext) erscheinen in der Inbox der Web-UI, als TUI-Dialog und als Desktop-Benachrichtigung. Die Antwort wird zur Übergabe für den Nachfolger.
- **Agent-Rückfragen:** Darf der Agent fragen, leitet AiFlow die Frage an Inbox und TUI weiter. v1: Event `question.asked`, Antwort per `question.reply`. v2: Forms (Event `form.created`, Antwort über die Form-API); die TUI von v2 kann Forms auch nativ anzeigen.
- **Rechte-Anfragen:** Regeln mit `ask` lösen `permission.asked` aus. Die Anfrage wird weitergereicht, die Antwort geht per `permission.reply` zurück.
- **Timeouts** mit Standardantwort sind optional. Runs, die auf eine Eingabe warten, blockieren keine anderen Runs.

### 8.10 Event-Sourcing, Persistenz, Wiederaufnahme

- **`run_events`** (`run_id, seq, ts, type, payload`) ist append-only und die einzige Quelle der Wahrheit. Die Projektionen `runs`, `steps` und `tokens` dienen schnellen Abfragen.
- **Große Inhalte** (Transkripte, Diffs, Dokumentversionen, Skript-Ausgaben) liegen als Dateien unter `runs/<id>/`. Das Event enthält nur eine Hash-Referenz.
- **SSE** liefert Events mit `seq`. Nach einem Verbindungsabbruch setzen Clients per `Last-Event-ID` nahtlos fort.
- **Wiederaufnahme:** Beim Start des Daemons werden laufende Runs als `interrupted` markiert. „Fortsetzen“ setzt unterbrochene Schritte auf ihren Start-Checkpoint zurück und führt sie neu aus. Abgeschlossene Schritte werden nie wiederholt.
- **Replay:** Die Run-Ansicht kann jeden Zeitpunkt rekonstruieren (Zeitleisten-Schieber).

### 8.11 Pause und Abbruch

- **Pause:** Es starten keine neuen Schritte. Laufende Schritte werden zu Ende geführt.
- **Abbruch:** Alle Sessions werden abgebrochen (v1 `session.abort`, v2 `session.interrupt`) und Skript-Prozessgruppen per `kill` beendet. Der Status wird `cancelled`. Die Workspaces bleiben bis zum Aufräumen erhalten.
- **Schritt wiederholen:** Ein fehlgeschlagener oder pausierter Schritt kann vom Checkpoint aus neu ausgeführt werden, optional mit geänderter Zusatzanweisung.

### 8.12 Event-Katalog (Auszug)

| Bereich | Events |
|---|---|
| Run | `run.created`, `run.started`, `run.paused`, `run.resumed`, `run.interrupted`, `run.waiting_input`, `run.review_pending`, `run.completed`, `run.failed`, `run.cancelled` |
| Schritt | `step.started`, `step.context_built`, `step.session_started`, `step.text`, `step.tool_called`, `step.tool_result`, `step.progress`, `step.handoff`, `step.decision`, `step.document_written`, `step.violation`, `step.checkpoint`, `step.retry`, `step.completed`, `step.failed` |
| Ablauf | `token.forked`, `token.joined`, `token.cancelled`, `loop.iteration`, `loop.limit_reached` |
| Interaktion | `input.requested`, `input.answered`, `question.forwarded`, `permission.forwarded` |
| Abschluss | `review.decided`, `apply.completed`, `apply.conflict`, `branch.created`, `docs.exported` |
| Sub-Agenten | `delegation.wave_started`, `delegation.wave_completed`, `delegation.budget_exhausted`, `substep.queued`, `substep.started`, `substep.completed`, `substep.failed` |

### 8.13 Ausführung von Sub-Agenten

- **Delegations-Tool `aiflow_delegate`:** Das Plugin stellt es in seiner Worker-Rolle bereit, aber nur in Sessions von Knoten mit aktiven Sub-Agenten.
  - Eingabe: `{ tasks: [{ agent, task, expectedResult? }] }`. Das Feld `agent` ist ein `enum` der erlaubten Agenten.
  - Der Aufruf startet eine Welle und **blockiert, bis alle Teilaufgaben fertig sind**. Rückgabe: je Teilaufgabe Status, Zusammenfassung und strukturierte Ausgabe des Sub-Agenten, dazu das verbleibende Budget.
  - Bewusst ein blockierender Aufruf pro Welle statt einzelner Start- und Warte-Aufrufe: Für schnelle Modelle ist das robuster. Feinere Steuerung (`aiflow_spawn` + `aiflow_await`) ist eine spätere Erweiterung.
  - Sichtbarkeit pro Session: v2 über den `context`-Hook (Tool und `enum` je Session), v1 über die `tools`-Map beim Prompt.
- **Unter-Schritte:** Jeder Sub-Agent ist ein vollwertiger AiFlow-Schritt mit `parentStepId`. Er bekommt eine eigene Session, ein eigenes Kontext-Paket (Teilaufgabe plus konfigurierter Zusatzkontext), Rechte und Workspace nach den Knoten-Einstellungen, eine strukturierte Übergabe nach seinem Ausgabe-Vertrag und eigene Metriken.
- **Limits setzt die Engine durch, nicht das Modell:** ein Semaphor pro Knoten für die Parallelität, Zähler für Budget und Wellen, Prüfung der Verschachtelungstiefe.
- **Delegationszwang:** Session-Regeln entziehen die Arbeits-Tools. Die Nachprüfung (8.1, Schritt 4) verlangt mindestens eine Delegation, sonst wird nachgefordert.
- **Lange Tool-Aufrufe:** Eine Welle kann viele Minuten dauern. Der Tool-Aufruf hält die Session des Orchestrators so lange offen; abgebrochen wird über das Abort-Signal des Tools. Wie sich v1 und v2 bei sehr langen Tool-Aufrufen verhalten, klärt Spike S10.
- **Wiederaufnahme:** Abgeschlossene Unter-Schritte werden nie wiederholt. Startet der Orchestrator nach einem Absturz neu, stehen die bereits vorliegenden Ergebnisse in seinem Kontext („Bisherige Wellen“), und er plant ab dort weiter.

---

## 9. opencode-Runtime-Adapter und Worker-Rolle

### 9.1 Lebenszyklus des Workers

- **Versionserkennung:** `opencode --version` bzw. die Server-Info nach dem Start entscheiden über den Treiber (v1 oder v2). Konfiguration: `opencode.api: auto | v1 | v2`, optional `opencode.binary` für einen festen Pfad.
- **Start:** `opencode serve --hostname 127.0.0.1 --port <frei>` als Kindprozess mit zufälligem Passwort (v1: `OPENCODE_SERVER_PASSWORD`, v2: `OPENCODE_PASSWORD`, Benutzer `opencode`) und `AIFLOW_WORKER=1` samt Daemon-Adresse und Worker-Token in der Umgebung. Danach Health-Check, Überwachung und Neustart mit Backoff.
- **Plugin-Prüfung:** Nach dem Start fragt der Daemon die Plugin-Liste des Workers ab. Fehlt das AiFlow-Plugin oder passt seine Version nicht, startet kein Run. UI und `aiflow doctor` nennen die Abhilfe (`aiflow setup opencode`).
- **Versionsprüfung:** unterstützte Bereiche je Linie (5.5.1), Warnung bei Abweichung.
- **Nur v1:** LSP-Last bei vielen Worktrees begrenzen (Spike S4). v2 startet keine Language-Server.
- **v2-Option „eingebettet“ (später):** `@opencode/sdk` hostet opencode ohne HTTP-Listener im eigenen Prozess und nimmt Plugins direkt als Objekt entgegen (`OpenCode.create({ plugins })`). Das würde Prozessverwaltung und Plugin-Installation für den Worker überflüssig machen. Ob das unter Node läuft oder Bun voraussetzt, klärt Spike S9.

### 9.2 Abbildung Agent-Definition → opencode

| AiFlow (versionsneutral) | v1-Treiber | v2-Treiber |
|---|---|---|
| Agent als Ganzes | Basis-Agent plus Overrides pro Prompt (`agent`, `system`, `tools`, `model`, `variant`) | Agenten per `ctx.agent.transform` aus den AiFlow-Definitionen erzeugt (`reload()` bei Änderungen); Session wird mit `agent` und `model` angelegt |
| Identität + Bausteine + Zusatzanweisung des Knotens | `system` beim Prompt (Spike S1) | Agent-Feld `system`; knotenspezifische Ergänzungen über den `context`-Hook (`event.system`) |
| Kontext-Paket (Dokumente, Iteration, Feedback) | Prompt-Text | Erster Prompt-Text; spätere Aktualisierungen als Instruktions-Einträge (z. B. `aiflow.iteration`), ohne zusätzlichen Nachrichten-Turn |
| Modell | `model { providerID, modelID }`, `variant` | `model { providerID, id, variant }` bzw. `provider/model#variant` |
| Temperatur, top_p | Hook `chat.params` (pro Session aus den Metadaten) | `context`-Hook (`event.options`) oder Modell-Variante |
| Max. Schritte | Agent-`steps` | Agent-`steps` |
| Rechte | Session-`permission` (`{ permission, pattern, action }`) plus `tools`-Map | Session-`permissions` (`{ action, resource, effect }`, geordnet), bei Bedarf `session.update` |
| MCP-Rechte | `tools`-Map mit `<server>_*`-Mustern | Regeln über die Tool-Namen der MCP-Tools (Abbildung per Spike S2) |
| Arbeitsverzeichnis | Query `directory` | `location: { directory }` |
| Strukturierte Übergabe | `format: json_schema` | Übergabe-Tool (8.4) |
| Kontext-Modus `fork`, Stimmen | `session.fork` | `session.fork` |
| Abbruch | `session.abort` | `session.interrupt`, beim Aufräumen `session.remove` |
| Zuordnung Session ↔ Schritt | `metadata: { aiflowRunId, aiflowStepId }` bei `session.create` | ebenso |

### 9.3 Worker-Rolle des Plugins

Das AiFlow-Plugin steht in der globalen opencode-Konfiguration des Nutzers, also lädt es auch der Worker. **Die Rolle wird beim Laden gewählt:** Nur wenn `AIFLOW_WORKER=1` gesetzt ist, aktiviert das Plugin seine Worker-Rolle (Guards, Übergabe-Tool, Hilfs-Tools). In der opencode-Instanz des Nutzers fehlt die Variable; dort läuft nur die Bridge-Rolle (Kapitel 10). Zusätzlich prüft jeder Worker-Hook die Session-Metadaten und bleibt in Sessions ohne `aiflowStepId` wirkungslos.

Die Logik liegt im gemeinsamen Kern; die Shells binden sie an die jeweilige API.

| Aufgabe | v1 | v2 |
|---|---|---|
| Harte Durchsetzung (Pfade, Dokument-Rechte, Schreibbereich) | `tool.execute.before` (Fehler werfen) | `ctx.tool.hook("execute.before")` (Fehler werfen) und `ctx.permission.hook("evaluate")` (Effekt und Meldung setzen) |
| Rechte-Entscheidungen nach AiFlow-Regeln | `permission.ask` | `ctx.permission.hook("evaluate")` |
| Sampling pro Session | `chat.params` | `ctx.session.hook("context")` |
| Umgebungsvariablen (`AIFLOW_RUN_ID`, `AIFLOW_STEP_ID`, `AIFLOW_DOCS_DIR` …) | `shell.env` | `ctx.shell.hook("create.before")` |
| Pflichtkontext bei Kompaktierung (Auftrag, Dokumentpfade, Iteration) | `experimental.session.compacting` | `ctx.session.hook("compaction")` |
| Übergabe-Schema pro Session | – (`format: json_schema` beim Prompt) | `ctx.session.hook("context")`: Eingabeschema von `aiflow_handoff` in `event.tools` durch das knotenspezifische Schema ersetzen |
| Übergabe erzwingen | – (übernimmt `format`) | `ctx.session.hook("experimental.idle")`: fehlt eine gültige Übergabe, wird sie per `ctx.session.synthetic` in derselben Ausführung nachgefordert |
| Tools `aiflow_progress(message)`, `aiflow_context(query)` | `tool` (Helper `tool()`, Zod) | `ctx.tool.transform` (JSON Schema); Fortschritt zusätzlich über `context.progress` |
| Tool `aiflow_handoff` | – | `ctx.tool.transform` |
| Tool `aiflow_delegate` (nur bei aktiven Sub-Agenten, 8.13) | `tool`, freigegeben per `tools`-Map beim Prompt | `ctx.tool.transform`; Sichtbarkeit und `enum` der erlaubten Agenten per `context`-Hook |
| Kommunikation mit dem Daemon | lokale HTTP-API mit Worker-Token | ebenso |

Die Zuordnung Session → Schritt läuft über die Session-Metadaten und wird gecacht.

### 9.4 Event-Mapping

Die Treiber übersetzen die Server-Events in normalisierte `RuntimeEvent`s:

| Normalisiertes Event | v1 | v2 |
|---|---|---|
| Text | `message.part.delta`, `message.part.updated` | `session.text.delta`, `session.text.ended` |
| Tool-Aufruf | `message.part.updated` (Tool-Part) | `session.tool.called` / `success` / `failed` / `progress` |
| Modell-Schritt | – | `session.step.started` / `ended` / `failed` |
| Arbeit beendet | `session.idle` | `session.execution.succeeded`, `session.idle` |
| Fehler | `session.error` | `session.execution.failed` |
| Abgebrochen | – | `session.execution.interrupted` |
| Verbrauch | Nachrichten-Info (Tokens, Kosten) | `session.usage.updated` / `recorded` |
| Rückfrage | `question.asked` | `form.created` |
| Rechte-Anfrage | `permission.asked` | `permission.asked` |

- Text-Deltas werden gebündelt und gedrosselt (z. B. alle 250 ms), damit Event-Store und UI nicht überlaufen.
- Diffs berechnet AiFlow unabhängig von der Linie selbst per git.
- Die v2-Event-Streams liefern nur live und ohne Replay. Nach einem Verbindungsabbruch gleicht der Treiber den Zustand über `session.get` und `session.context` ab, bevor er wieder abonniert. Der v1-Treiber verfährt genauso.

---

## 10. opencode-Plugin: Bridge-Rolle

### 10.1 Installation und Verbindung

- **Ein npm-Paket** (Arbeitstitel `opencode-aiflow`) für v1 und v2, Aufbau siehe 5.5.4. `aiflow setup opencode` erkennt die Linie und trägt das Plugin nach Bestätigung **global** ein, damit TUI und Worker dasselbe Plugin laden:
  ```jsonc
  // opencode v1: ~/.config/opencode/opencode.json
  { "plugin": [["opencode-aiflow", { "url": "http://127.0.0.1:5739", "autoStart": true }]] }

  // opencode v2: ~/.config/opencode/opencode.json
  { "plugins": [{ "package": "opencode-aiflow", "options": { "url": "http://127.0.0.1:5739", "autoStart": true } }] }
  ```
- **TUI-Teil:** v2 lädt den `./tui`-Export automatisch mit. Wie v1 den TUI-Teil lädt, klärt Spike S6.
- **Beim Laden (Bridge-Rolle):**
  1. Health-Check. Ist der Daemon nicht erreichbar und `autoStart` gesetzt, wird `aiflow serve --detach` gestartet.
  2. Auth-Token aus `~/.config/aiflow/auth-token` lesen.
  3. Projekt registrieren (v1: `directory` und `worktree` aus dem Plugin-Input; v2: `ctx.location`).
  4. Workflow-Änderungen und Runs des Projekts per SSE abonnieren.
- **Transport zwischen TUI-Teil und Daemon:** In v1 spricht der TUI-Teil direkt per HTTP mit dem Daemon. In v2 kann die TUI mit einem entfernten opencode-Server verbunden sein. Der TUI-Teil geht dort deshalb über das Plugin-RPC des Server-Teils (`ctx.rpc.register`, in der TUI `client.rpc(AiFlow)`), und der Server-Teil spricht mit dem Daemon auf seinem Rechner. Ist RPC nicht verfügbar, verbindet sich der TUI-Teil direkt per HTTP.

### 10.2 Befehle

| Befehl | Funktion |
|---|---|
| `/aiflow-configure` | Daemon sicherstellen und Browser mit Projektkontext öffnen (Einmal-Login-Link) |
| `/aiflow-wf-<name> [prompt]` | Workflow starten. Ohne Prompt öffnet sich ein Eingabedialog, fehlende Pflicht-Parameter werden per Dialog abgefragt. |
| `/aiflow-run` | Workflow über einen Auswahl-Dialog starten |
| `/aiflow-status` | Detailansicht des aktuellen Runs |
| `/aiflow-runs` | Laufende und letzte Runs des Projekts |
| `/aiflow-inbox` | Offene Freigaben, Rückfragen und Reviews beantworten |
| `/aiflow-cancel` | Run abbrechen (mit Auswahl) |

**Registrierung:**

| | opencode v1 | opencode v2 |
|---|---|---|
| Workflow-Commands | TUI-Keymap-Command mit `slash`, läuft lokal ohne LLM. Argumente per Spike S6; sonst Eingabedialog. Fallback: `command`-Einträge per `config`-Hook, abgefangen mit `command.execute.before` (Spike S7); neue Workflows dann erst nach Neustart. | Server-Teil: `ctx.command.transform` mit `execute({ sessionID, prompt })`. Kein LLM, der Prompt kommt roh an. Nach Workflow-Änderungen `ctx.command.reload()`. |
| Reine TUI-Befehle (`/aiflow-status` …) | TUI-Keymap-Command mit `slash` | Reaktiver `keymap.layer` mit `slash: { name, arguments: true }` |

**Grundsatz:** Der Prompt des Nutzers wird **nie** vom Haupt-LLM umformuliert, sondern unverändert an AiFlow übergeben.

### 10.3 Live-Ansicht in der TUI

```
AiFlow · feature-review · 06:12
✔ Planner            1:48
✔ Implementer #1     2:31
✖ Checks             2 Tests rot → zurück
▶ Implementer #2     0:53  „behebe AuthService-Test“
○ Reviews (3× parallel)
○ Documenter
─ Entscheidungen
• Triage → mittel („3 Module betroffen“)
```

Knoten mit Sub-Agenten zeigen ihre Wellen eingerückt:

```
▶ Recherche-Orchestrator   Welle 2 · 3/5 fertig · Budget 7/15
   ✔ Explorer: Auth-Modul           1:12
   ✔ Explorer: E-Mail-Versand       0:58
   ✔ Explorer: Token-Speicherung    1:30
   ▶ Explorer: Rate-Limiting        0:41
   ○ Explorer: Bestehende Tests
```

| Element | opencode v1 | opencode v2 |
|---|---|---|
| Panel in der Seitenleiste (siehe oben) | Slot `sidebar_content` | Slot `sidebar.content` |
| Kompakte Statuszeile, z. B. `⚙ feature-review · Implementer (2/3) · 06:12` | Slot `session_prompt_right` bzw. `app_bottom` | Slot `prompt.footer.status` bzw. `home.footer.status` |
| Detailansicht (Schritt-Timeline, Entscheidungs-Log, Live-Ausschnitt der Agent-Ausgabe, Dokumente, Link zur Web-Ansicht) | Eigene Route | **Session-Panel** (`session.panel`, als Seitenpanel oder Vollbild, geöffnet per `ui.panel.open("aiflow.run")`) |
| Run-Liste | Eigene Route | Eigene Route (`ui.router`) |
| Mensch-Knoten, Abschluss-Review (Kurzfassung, Dateiliste mit +/−, Aktionen „Übernehmen“, „Im Browser reviewen“, „Als Branch behalten“, „Verwerfen“) | `DialogSelect`, `DialogPrompt` | Promise-Dialoge `ui.dialog.select` / `prompt` / `confirm` |
| Agent-Rückfragen | Dialog | Dialog bzw. native Form-Anzeige |
| Meilensteine (Entscheidungen, Fehler) | `ui.toast` | `ui.toast.show` |
| „Wartet auf dich“, „fertig“ | `attention.notify` (Desktop-Benachrichtigung und Sound) | `attention.notify` |
| Lokaler Zustand (z. B. eingeklappte Bereiche) | `kv` | `storage.store` / `storage.memory` |

Optional fügt die Bridge den Abschlussbericht in die aufrufende Session ein, damit das Hauptgespräch das Ergebnis kennt: v1 per `session.prompt({ noReply: true })`, v2 per `ctx.session.synthetic` (ob das eine Modellantwort auslöst, wird in Spike S6 geprüft).

### 10.4 Zusatz im Server-Teil

Die Tools `aiflow_list_workflows` und `aiflow_run(workflow, prompt)` lassen den Haupt-Agenten auch im normalen Gespräch einen Workflow starten („lass das über den Review-Workflow laufen“). Registrierung: v1 über `tool`, v2 über `ctx.tool.transform`. Optional und abschaltbar. Auch hier wird der Prompt unverändert übergeben.

### 10.5 OpenCode Desktop (v2, später)

v2 bringt eine Desktop-App mit experimenteller GUI-Plugin-API (`./gui-experimental`: Panels, Commands, Einstellungsseiten). Ein AiFlow-Panel mit Run-Status und Inbox ist als Ausbau vorgesehen (Phase 9). Bis dahin deckt die Web-UI das ab.

---

## 11. Web-UI

### 11.1 Navigation

| Bereich | Inhalt |
|---|---|
| **Übersicht** | Laufende Runs, Inbox-Zähler, letzte Runs, Schnellstart |
| **Inbox** | Offene Freigaben, Agent-Rückfragen, Rechte-Anfragen, ausstehende Reviews |
| **Agenten** | Bibliothek (global und Projekt), Editor, Vorlagen-Galerie, Playground |
| **Bausteine** | Wiederverwendbare Instruktionen, Dokument-Vorlagen |
| **Workflows** | Liste, Editor, Versionen, Import/Export |
| **Runs** | History, Run-Ansicht, Review |
| **Einstellungen** | Daemon, Worker/opencode, Standards (Modell, Limits, Parallelität), Projekte, Aufbewahrung, Sicherheit und Workspace-Trust |

Oben gibt es eine Projektauswahl (Scope „Global“ oder ein konkretes Projekt).

### 11.2 Agenten-Editor

- **Tabs:** Identität · Modell · Werkzeuge & Rechte · MCP & Skills · Ausgabe · Verhalten · Testen
- **Live-Vorschau** des zusammengesetzten System-Prompts (Identität + Bausteine + Projektregeln).
- Die **Rechte** sind als Tabelle editierbar (Tool × allow/ask/deny, Muster-Listen), mit Presets und einem Hinweis bei riskanten Kombinationen (z. B. `bash: allow` ohne Denylist).
- Die **MCP-Liste** kommt live aus dem Worker (v1 `mcp.status`, v2 `mcp.list`), mit Status pro Server.
- **Ausgabe-Vertrag:** visueller Schema-Builder für die gängigen Feldtypen (Boolean, Enum, Text, Zahl, Liste von Objekten) und ein Monaco-JSON-Editor für den Rest.
- **Playground:** Testet den Agenten mit einem Prompt in einem Scratch-Worktree. Transkript, Übergabe und Diff erscheinen nebeneinander, ohne dass ein Workflow nötig ist.

### 11.3 Workflow-Editor

```
┌──────────────┬───────────────────────────────────────────────┬──────────────────────┐
│ Palette      │ Canvas                                        │ Inspector            │
│ [Agenten]    │  (Start)─▶[Planner]─▶[Implementer]─▶{Checks}  │ Knoten: Implementer  │
│  ▸ Planner   │                 ▲  ▲          failed │ passed │ Agent: implementer   │
│  ▸ Implem.   │                 │  └──── max 3 ──────┘   │    │ Kontext: resume      │
│  ▸ Reviewer  │                 │                  ┌─────┼──┐ │ Workspace: continue  │
│ [Bausteine]  │                 │             [Sec][Std][Tst]│ Dokumente: plan.md R │
│  ▸ Start     │                 │                  └──┬──┘   │ Zusatzanweisung: …   │
│  ▸ Bedingung │                 └─ rejected (max 3) ─[Verdict]─approved─▶[Docs]─▶■ │
│  ▸ Skript …  │                                               │                      │
├──────────────┴───────────────────────────────────────────────┴──────────────────────┤
│ Probleme (1): ⚠ Pflichtdokument „plan.md“ wird nach „implement“ nicht mehr gelesen  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Palette:**
  - Agenten-Kacheln mit Suche und Filter nach Tags, per Drag & Drop aufs Canvas.
  - Bausteine: Start, Ende, Bedingung, Skript, Zusammenführung, Für jedes, Mensch, Sub-Workflow, Notiz/Rahmen.
- **Canvas** (React Flow):
  - Ports als beschriftete Handles, Kanten ziehen per Drag.
  - Neue Zweige direkt am Knoten anlegen.
  - Auto-Layout (elkjs), Mehrfachauswahl, Kopieren/Einfügen, Undo/Redo, Raster, Minimap, Tastenkürzel.
- **Inspector:** Kontextabhängig für den ausgewählten Knoten, die Kante oder (ohne Auswahl) den Workflow:
  - Knoten-Overrides
  - Zweige mit Beschreibung und Übergabe-Anweisung
  - Regel-Builder für Bedingungen
  - Template-Felder mit Autovervollständigung
  - Bereich „Sub-Agenten“ am Agent-Knoten mit allen Einstellungen aus 7.16
- **Workflow-Einstellungen:** Allgemein (Name, Command-Name, Beschreibung) · Eingaben · Variablen · Dokumente + **Zugriffs-Matrix** · Workspace (Basis, Setup-Befehl) · Limits · Abschluss · Benachrichtigungen.
- **Live-Validierung:** Das Probleme-Panel zeigt alle Regeln aus 8.3. Ein Klick springt zum betroffenen Element. Speichern ist auch mit Fehlern möglich (Entwurf), Starten nicht.
- **Kopfleiste:** Speichern · Validieren · **Testlauf** · Starten (mit Prompt-Dialog) · Versionen · Export/Import · Auto-Layout.

### 11.4 Testlauf (Simulation)

Der Testlauf nutzt dieselbe Engine mit einer Simulations-Runtime. Agenten werden nicht aufgerufen. Bei jeder Entscheidung wählt der Nutzer den Zweig, oder er lässt Zufall bzw. ein vorab definiertes Skript wählen. Die Simulation prüft Pfade, Schleifen-Limits, Joins und Dokument-Rechte in Sekunden. Ein Simulationsskript lässt sich als Regressionstest speichern.

### 11.5 Run-Ansicht (live und History)

- **Kopf:** Status, Dauer, Workflow@Version, Eingabe. Aktionen: Pause, Fortsetzen, Abbrechen, Schritt wiederholen.
- **Graph** (read-only Canvas):
  - Live-Status je Knoten: wartend, läuft, fertig, Fehler, übersprungen.
  - Animierte aktive Kanten, gewählte Zweige hervorgehoben, Durchlaufzähler an Rückkanten (z. B. „2/3“).
  - Knoten mit Sub-Agenten zeigen Welle, Fortschritt und Budget (z. B. „Welle 2 · 3/5 · 7/15“) und lassen sich zu einem Baum der Unter-Schritte aufklappen. Die Zeitleiste zeigt Unter-Schritte verschachtelt.
- **Zeitleiste** (Gantt) für parallele Zweige.
- **Schritt-Detail** (Seitenpanel):
  - Eingabe: exakter Prompt und Kontext-Paket
  - Transkript: Nachrichten, Tool-Calls mit Ein- und Ausgabe, Reasoning eingeklappt
  - Übergabe und strukturierte Ausgabe
  - Entscheidung mit Begründung (alle Stimmen)
  - Diff dieses Schritts, Dokument-Zugriffe, Verstöße, Metriken
- **Tabs:** Dokumente (Versionen mit Diff) · Änderungen (Gesamt-Diff, laufend aktualisiert) · Entscheidungs-Log · Rohes Event-Log.
- **Zeitreise-Schieber** zum Nachspielen beliebiger Zeitpunkte.

### 11.6 Review-Ansicht (wie ein Pull Request)

- **Kopf:** Abschlussbericht, Ergebnis, Statistik, exportierte Dokumente.
- **Inhalt:**
  - Dateibaum mit Status (hinzugefügt, geändert, gelöscht) und Konfliktmarkierung
  - Diff-Ansicht (unified oder split, Syntax-Highlighting)
  - Checkbox pro Datei für die Teil-Übernahme
  - Inline-Kommentare
- **Aktionen:** Übernehmen (alles oder Auswahl) · Änderungen anfordern (Kommentare + Freitext → Run läuft weiter) · Als Branch behalten · Patch herunterladen · Verwerfen.
- **Kontext:** Ein Klick auf eine Datei zeigt, welcher Schritt sie geändert hat. Das Diff pro Schritt hilft, Änderungen nachzuvollziehen.

### 11.7 History und Analytics

- **History:**
  - Filter: Projekt, Workflow, Status, Zeitraum, Volltext im Prompt
  - Spalten: Start, Dauer, Workflow@Version, Ergebnis, Schritte, Schleifen, geänderte Dateien
  - Aktionen: öffnen, erneut ausführen (gleiche oder aktuelle Version), zwei Runs vergleichen, Bericht exportieren (Markdown/JSON), löschen
- **Analytics** (Phase 9), pro Workflow:
  - Ø Dauer, Ø Schleifendurchläufe, Quote „im ersten Durchlauf approved“
  - Häufigste Fehler- und Eskalationsknoten
  - Tokens pro Knoten, Entscheidungsverteilung
  - Vergleich von Workflow-Versionen

### 11.8 UX-Grundsätze

- Dunkles und helles Theme, vollständig per Tastatur bedienbar.
- Deutsch als Standardsprache, i18n von Anfang an (Englisch ergänzbar).
- Leere Zustände erklären, was als Nächstes zu tun ist.
- Undo statt Bestätigungsdialoge, wo möglich. Destruktive Aktionen (Verwerfen, Löschen) werden bestätigt.

---

## 12. API und Sicherheit

### 12.1 REST-Endpunkte (Auszug)

| Methode und Pfad | Zweck |
|---|---|
| `GET /api/health` | Zustand von Daemon und Worker, Versionen |
| `GET/POST /api/projects` | Projekte (registriert per Pfad) |
| `GET/POST/PUT/DELETE /api/agents[/:id]` | Agenten (Query `scope=global\|project`) |
| `POST /api/agents/:id/playground` | Agent testen |
| `GET/POST/PUT/DELETE /api/snippets[/:id]` | Bausteine und Vorlagen |
| `GET/POST/PUT/DELETE /api/workflows[/:id]` | Workflows |
| `POST /api/workflows/:id/validate` | Validierung |
| `GET /api/workflows/:id/versions[/:v]` | Versionen |
| `POST /api/workflows/:id/simulate` | Testlauf |
| `POST /api/runs` | Run starten `{ workflowId, projectDir, input, origin }` |
| `GET /api/runs[?filter]`, `GET /api/runs/:id` | History und Details |
| `POST /api/runs/:id/{pause,resume,cancel}` | Steuerung |
| `POST /api/runs/:id/steps/:stepId/retry` | Schritt wiederholen |
| `GET /api/runs/:id/steps/:stepId[/transcript\|/diff\|/prompt]` | Schritt-Details |
| `GET /api/runs/:id/documents[/:name/versions]` | Dokumente |
| `GET /api/runs/:id/review`, `POST /api/runs/:id/review/{apply,request-changes,branch,discard}` | Review |
| `GET /api/inbox`, `POST /api/inbox/:itemId/answer` | Freigaben, Rückfragen, Rechte-Anfragen |
| `GET /api/runtime/{models,mcp,tools,skills}` | Daten aus dem Worker für die Editoren |
| `GET /api/events?project=…` | Globaler SSE-Stream (Workflow-Änderungen, Run-Status) |
| `GET /api/runs/:id/events` | SSE-Stream eines Runs (mit `Last-Event-ID`) |

Die OpenAPI-Spezifikation wird aus den Zod-Schemas erzeugt. Der Client im Paket `client` ist daraus typisiert.

### 12.2 Sicherheitskonzept

Ein lokaler Server, der Agenten Code schreiben und Befehle ausführen lässt, ist ein attraktives Angriffsziel. Jede Webseite im Browser kann Anfragen an `localhost` schicken. Deshalb:

| Maßnahme | Detail |
|---|---|
| Nur localhost | Bindung an `127.0.0.1` (änderbar nur mit deutlicher Warnung) |
| Auth-Token | Zufällig, Datei `~/.config/aiflow/auth-token` mit Modus `0600`. Als Bearer-Token für CLI und Bridge. |
| Browser-Login | Einmal-Link `/login?otp=…` (kurzlebig, einmalig) setzt ein `HttpOnly`-, `SameSite=Strict`-Cookie |
| DNS-Rebinding-Schutz | `Host`-Header muss `127.0.0.1:5739` oder `localhost:5739` sein |
| CSRF-Schutz | `Origin`-Prüfung bei allen schreibenden Requests, kein CORS |
| Worker isoliert | Zufälliger Port, nur der Daemon kennt Adresse und Passwort |
| **Workspace-Trust** | Projekt-Definitionen aus `.aiflow/` (z. B. aus einem fremden geklonten Repo) sind erst nach expliziter Bestätigung ausführbar. Ändern sich Skript-Knoten, Setup-Befehle oder Rechte in Projektdateien, ist erneut eine Bestätigung nötig (Hash-basiert). |
| Sichere Defaults | Neue Agenten dürfen nur lesen; `git push`, Netz-Tools und `task` sind aus; es gibt keinen Schreibzugriff auf das Nutzer-Arbeitsverzeichnis |
| Keine Secrets in AiFlow | Provider-Keys bleiben in opencode. AiFlow speichert keine Zugangsdaten. |
| Pfad-Validierung | Schutz vor Path-Traversal bei allen Datei-APIs |
| Log-Redaction | Umgebungsvariablen und bekannte Token-Muster werden in Logs geschwärzt |

---

## 13. CLI

```
aiflow serve [--port 5739] [--detach]         Daemon starten
aiflow stop | status | open                   Daemon steuern, Web-UI öffnen
aiflow run <workflow> "<prompt>"              Run starten
      [--project <pfad>] [--param k=v]…
      [--follow] [--finalize review|apply|branch|patch|none]
aiflow runs ls | show <id> | cancel <id> | resume <id> | apply <id> | discard <id>
aiflow workflows ls | validate <datei> | simulate <datei> --script <s> | export <id> | import <datei>
aiflow agents ls | export <id> | import <datei>
aiflow inbox [answer <id> <antwort>]
aiflow setup opencode [--api auto|v1|v2]      AiFlow-Plugin global in opencode eintragen (Linie wird erkannt)
aiflow doctor                                 Umgebung prüfen: git, opencode-Linie und -Version, Plugin aktiv, Provider, Ports, Rechte, Speicher
```

`--follow` zeigt eine kompakte Live-Ansicht wie in der TUI-Seitenleiste. Mit `--finalize branch` lässt sich AiFlow headless einsetzen, z. B. in CI oder per Skript.

---

## 14. Qualitätssicherung und Engineering-Standards

### 14.1 Code-Standards

- **TypeScript strikt:**
  - `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`
  - Kein `any`, keine Non-Null-Assertions
  - `as`-Casts nur mit Begründungskommentar
- **Zod an allen Systemgrenzen** (HTTP, Dateien, Runtime-Events, LLM-Ausgaben). Im Inneren werden nur geprüfte Typen verwendet.
- **Functional Core, Imperative Shell:** Reducer, Validator, Kontext-Assembler, Join- und Abstimmungslogik sind reine Funktionen.
- **Ports & Adapters:**
  - Die Engine kennt nur Interfaces.
  - Abhängigkeiten werden per Konstruktor injiziert.
  - Keine Singletons, kein globaler Zustand.
- **Fehler:**
  - Erwartbare Fehler sind typisierte Ergebnisse (`Result<T, AiflowError>` mit Fehlercodes).
  - Exceptions nur für Programmierfehler.
  - Jede Fehlermeldung sagt, was zu tun ist.
- **Diskriminierte Unions** mit exhaustivem `switch` (`assertNever`) für Knotentypen, Events und Ports.
- **Keine versteckten Seiteneffekte:** `Clock` und `IdGenerator` werden injiziert. Tests sind dadurch deterministisch.
- **Strukturiertes Logging** (pino) mit `runId` und `stepId` als Korrelation.
- **Kleine Module** (Richtwert < 300 Zeilen), sprechende Namen, TSDoc für öffentliche APIs.
- **Abhängigkeiten** sparsam halten und pinnen. Renovate für Updates.

### 14.2 Teststrategie

| Ebene | Werkzeug | Gegenstand | Wann |
|---|---|---|---|
| Unit | Vitest | core (Schemas, Validator, Templates, Bedingungen, Reducer) | Jeder Commit |
| Szenario | Vitest + FakeRuntime + In-Memory-Store | engine: alle Beispiel-Workflows, Limits, Race, Fehlerpfade, Wiederaufnahme | Jeder Commit |
| Integration | Vitest + temporäre git-Repos | workspace-git: Snapshots inkl. untracked, Worktrees, Checkpoints, 3-Wege-Übernahme, Konflikte | Jeder Commit |
| Integration | Vitest + SQLite-Datei | store: Events, Projektionen, Migrationen | Jeder Commit |
| API-Contract | Vitest + Hono-Testclient | server: Endpunkte, Auth, Host/Origin-Prüfung, SSE-Resume | Jeder Commit |
| Runtime-Contract | Vitest gegen echtes `opencode serve`, **Matrix v1 (1.19.x) und v2 (2.2.x)** | runtime-opencode: Sessions, Rechte, strukturierte Übergabe, Fork, Abbruch, Events | Nightly bzw. vor Release (braucht Modellzugang) |
| Plugin-Smoke | opencode v1 und v2 | `opencode-aiflow` lädt in beiden Linien; Commands, Tools und Guards sind registriert und greifen | Jeder PR (ohne Modell), nightly mit Modell |
| E2E | Playwright | Web-UI mit Daemon und FakeRuntime: Editor, Runs, Review | Jeder PR |
| Round-trip | Vitest | YAML → Modell → YAML ist identisch (inkl. Kommentare) | Jeder Commit |

Coverage-Schwellen: `core` und `engine` ≥ 90 % Zeilen, übrige Pakete ≥ 75 %.

### 14.3 Definition of Done (pro Aufgabe)

- `pnpm check` ist grün (Typecheck, Lint, Tests, Paketgrenzen, knip).
- Neue Logik hat Tests. Bugfixes haben einen Regressionstest.
- Öffentliche API ist dokumentiert. Eine Architekturentscheidung hat ein ADR.
- Kein `TODO` ohne verlinktes Issue.
- UI-Änderungen haben einen E2E-Test oder eine begründete Ausnahme.

### 14.4 Arbeiten mit KI-Agenten an AiFlow selbst

- **`AGENTS.md`** im Plugin-Ordner (Phase 0) fasst die Regeln aus 14.1–14.3, die Paketgrenzen, die Befehle und Beispiele für „guten Code“ in diesem Repo zusammen.
- Aufgaben aus [Kapitel 15](#15-roadmap-phasen-aufgaben-akzeptanzkriterien) sind bewusst klein geschnitten: ein Paket pro Aufgabe, mit vorab formulierten Akzeptanzkriterien.
- Für `core` und `engine` gilt: zuerst Typen, Schemas und Tests, dann die Implementierung.
- Jede Aufgabe bekommt ein Review durch einen zweiten Agenten mit Fokus auf Paketgrenzen, Fehlerbehandlung und Tests.
- **Dogfooding ab Meilenstein M2:** Die Weiterentwicklung von AiFlow läuft mit AiFlow-Workflows (z. B. [16.3](#163-multi-review-mit-veto-und-feedback-schleife-vollständiges-yaml) und [16.4](#164-bugfix-mit-reproduktion-tdd)).

---

## 15. Roadmap: Phasen, Aufgaben, Akzeptanzkriterien

**Meilensteine:**

| Meilenstein | Phasen | Ergebnis |
|---|---|---|
| **M1 – Engine korrekt** | 0–2 | Vollständige Ablauflogik, nachgewiesen durch Tests |
| **M2 – Headless nutzbar** | 3–4 | Echte Runs mit opencode per CLI und YAML; Dogfooding beginnt |
| **M3 – MVP** | 5–7 | Web-Editor, opencode-Bridge, Run-, Review- und History-Ansicht |
| **M4 – Erweitert** | 8 | Für-jedes, Sub-Workflows, Self-Consistency, Simulation, Playground |
| **M5 – Ausbau** | 9 | Analytics, weitere Runtimes, Komfortfunktionen |

Umfang: S = klein, M = mittel, L = groß (relativ, für die Planung der Agenten-Aufgaben).

### Phase 0 – Fundament (S)

| ID | Aufgabe |
|---|---|
| P0-01 | pnpm-Workspace, `tsconfig.base.json` (strikt), Gerüste aller Pakete mit README |
| P0-02 | ESLint (strictTypeChecked), Prettier, dependency-cruiser-Regeln (6.1), knip |
| P0-03 | Vitest-Workspace, Coverage-Schwellen |
| P0-04 | CI (GitHub Actions): `pnpm check` |
| P0-05 | `AGENTS.md`, ADR-Vorlage, ADR-001 „Architektur und Runtime-Adapter“ |
| P0-06 | lefthook (pre-commit: Lint und Typecheck der geänderten Pakete) |
| P0-07 | CI-Gerüst für Tests gegen opencode v1 und v2 (beide Linien installierbar, Versionen gepinnt) |

**Akzeptanz:** Ein frischer Clone ist nach `pnpm i && pnpm check` grün. Ein Import über eine Paketgrenze hinweg lässt die CI scheitern.

### Phase 1 – Core-Domäne (M)

| ID | Aufgabe |
|---|---|
| P1-01 | Zod-Schemas: Agent, Baustein, Workflow, Knoten (diskriminierte Union), Ports, Kanten, Dokumente, Workspace, Limits, Abschluss |
| P1-02 | YAML lesen und schreiben mit Schema-Version, Migrationsgerüst und erhaltenen Kommentaren |
| P1-03 | Graph-Modell und Validator (alle Regeln aus 8.3) mit Fehlercodes und Element-Referenzen |
| P1-04 | Template-Engine (strikt) und Variablen-Katalog (für Validierung und Autocomplete) |
| P1-05 | Bedingungen: JSON Logic, eigene Operatoren, Typprüfung gegen Ausgabe-Schemas |
| P1-06 | Generator für das Übergabe-Schema (Ports + Ausgabe-Vertrag + Kandidaten → JSON-Schema) |
| P1-07 | Run-Zustandsmodell, Event-Typen, Reducer |
| P1-08 | Beispiel-Definitionen in `examples/` (alle Workflows aus Kapitel 16) als Fixtures |

**Akzeptanz:** Alle Beispiel-Workflows validieren. Jede Validator-Regel hat mindestens einen positiven und einen negativen Test. Der YAML-Round-trip ist identisch. Coverage von `core` ≥ 90 %.

### Phase 2 – Engine mit Fake-Runtime (L)

| ID | Aufgabe |
|---|---|
| P2-01 | Ports: `AgentRuntime`, `WorkspaceManager`, `EventStore`, `DocumentStore`, `ScriptRunner`, `Clock`, `IdGenerator` |
| P2-02 | testkit: skriptbare FakeRuntime (Antworten, Entscheidungen, Fehler, Latenzen), In-Memory-Store, Fake-Workspace |
| P2-03 | Scheduler und Tokens: Sequenz, Verzweigung, Bedingung, Parallel, Join (`all` / `first` / `n-of-m`), Schleifen-Limits, Fehler-Ports |
| P2-04 | Kontext-Assembler (7.9) mit Snapshot-Tests der erzeugten Prompts |
| P2-05 | Abschluss-Phase: Übergabe anfordern, validieren, nachfordern, Fallback |
| P2-06 | Join-Kombination: `collect`, `vote` (Mehrheit, einstimmig, Veto), Feedback-Aggregation |
| P2-07 | Skript-Knoten-Executor (Prozessgruppen, Timeout, Ausgabe-Kürzung) |
| P2-08 | Limits, Budgets, Timeouts, Retries, Pause, Abbruch, Schritt wiederholen |
| P2-09 | `store`: SQLite-Event-Store, Projektionen, Migrationen, Wiederaufnahme nach Neustart |
| P2-10 | Dokument-Store: Versionen, Rechte-Berechnung, Integritäts- und Anhänge-Prüfung |
| P2-11 | Mensch-Knoten und Inbox-Modell (Engine-Seite) |

**Akzeptanz:**

- Szenario-Tests für alle Beispiel-Workflows, inklusive Überschreitung des Schleifen-Limits, Race-Abbruch, Fehlerpfad, Veto-Abstimmung und Mensch-Knoten.
- Crash-Test: Prozess mitten im Run beenden, „Fortsetzen“ liefert dasselbe Endergebnis.
- Determinismus: Gleiche Fake-Skripte ergeben die gleiche Event-Folge.

### Phase 3 – Git-Workspaces und opencode-Runtime (L)

| ID | Aufgabe |
|---|---|
| P3-00 | Spikes S1–S5 und S8 (Kapitel 17), Ergebnisse als ADRs |
| P3-01 | `workspace-git`: Basis-Snapshot inkl. untracked, Worktrees, versteckte Refs, Checkpoints, Diffs pro Schritt und gesamt, Aufräumen |
| P3-02 | Workspace-Modi (`continue`, `isolate`, `read-only`, Schreibbereich, `scratch`), Setup-Befehl, Grenzprüfung |
| P3-03 | Übernahme: 3-Wege-Merge, Konflikterkennung, Branch-Export, Patch-Export, Dokument-Export |
| P3-04 | `runtime-opencode/common`: Worker-Prozessverwaltung, Passwort, Health, Neustart, Versionserkennung, Plugin-Prüfung |
| P3-05 | Treiber v2: Sessions (`location`, `permissions`, `metadata`), Prompt, `wait`, `interrupt`, `fork`, Instruktions-Einträge, Event-Mapping, Übergabe per Tool |
| P3-06 | Treiber v1: Sessions (`directory`, `permission`, `metadata`), `promptAsync`, `abort`, `fork`, Event-Mapping, Übergabe per `format: json_schema` |
| P3-07 | Versionsneutrales Agenten-, Modell- und Rechte-Mapping → v1/v2, inkl. Warnung bei nicht exakt abbildbaren Regeln |
| P3-08 | `opencode-plugin`: Kern (Guards, Übergabe-Validierung, Kontext) und Worker-Rolle in der v1- und der v2-Shell; kombinierter Einstiegspunkt (5.5.4) |
| P3-09 | Weiterleitung von Rückfragen und Rechte-Anfragen (v1: `question.*`, `permission.*`; v2: Forms, `permission.*`) |
| P3-10 | Runtime-Contract-Tests und Plugin-Smoke-Tests als Matrix v1/v2 |

**Akzeptanz:**

- Der Workflow „Plan → Implement → Checks → Review-Schleife → Ende (Branch)“ läuft auf `examples/demo-repo` mit echtem Modell vollständig durch, **mit opencode v1 und mit v2**.
- Das Arbeitsverzeichnis des Nutzers bleibt bis zur Übernahme byte-identisch.
- Ein Verstoß gegen die Dokument-Rechte wird blockiert und protokolliert.

### Phase 4 – Daemon-API und CLI (M)

| ID | Aufgabe |
|---|---|
| P4-01 | Hono-Server, Composition Root, Konfiguration, Pfade, Logging, Lock-Datei |
| P4-02 | Auth: Token, Einmal-Login, Host- und Origin-Prüfung |
| P4-03 | REST-Endpunkte, OpenAPI, typisierter `client` |
| P4-04 | SSE (global und pro Run) mit Resume |
| P4-05 | Definitions-Repository: global und Projekt, Datei-Watcher, Versionierung, Workspace-Trust |
| P4-06 | CLI: `serve`, `stop`, `status`, `run --follow`, `runs`, `workflows`, `agents`, `inbox`, `setup opencode`, `doctor` |

**Akzeptanz:**

- `aiflow run feature-review "…" --follow` zeigt den Live-Fortschritt und endet mit Review-Link bzw. Branch.
- API-Contract-Tests sind grün.
- Sicherheitstests: fremder `Origin` oder `Host` ergibt 403, ohne Token gibt es 401.

**→ Meilenstein M2. Ab hier wird AiFlow für die eigene Weiterentwicklung genutzt.**

### Phase 5 – Web-UI I: Agenten und Workflow-Editor (L)

| ID | Aufgabe |
|---|---|
| P5-01 | App-Gerüst: Routing, Layout, Themes, i18n, Login-Flow, Projektauswahl |
| P5-02 | Agenten-Bibliothek und Editor inkl. Rechte, MCP, Ausgabe-Vertrag, Prompt-Vorschau |
| P5-03 | Bausteine und Vorlagen verwalten; Rollen-Vorlagen-Galerie |
| P5-04 | Canvas: Palette, Drag & Drop, Ports und Handles, Kanten, Auto-Layout, Undo/Redo, Kopieren/Einfügen |
| P5-05 | Inspector für alle Knoten- und Kantentypen, Regel-Builder, Template-Editor mit Autocomplete |
| P5-06 | Dokumente, Zugriffs-Matrix, Workflow-Einstellungen |
| P5-07 | Live-Validierung und Probleme-Panel |
| P5-08 | Versionen (Vergleich, Wiederherstellen), Import/Export |
| P5-09 | Workflow aus der Web-UI starten |

**Akzeptanz:** Alle Beispiel-Workflows lassen sich ohne YAML-Bearbeitung im UI erstellen. Die gespeicherten Dateien sind semantisch identisch zu den Fixtures. Playwright-E2E deckt die Kernabläufe ab.

### Phase 6 – opencode-Plugin: Bridge-Rolle (M)

| ID | Aufgabe |
|---|---|
| P6-00 | Spikes S6–S7 |
| P6-01 | Bridge-Rolle im Plugin-Kern, Shells für v1 und v2, Verbindung, Auto-Start des Daemons |
| P6-02 | `/aiflow-configure` |
| P6-03 | Workflow-Commands, Prompt-Durchreichung 1:1, Parameter-Dialog, `/aiflow-run`. v2: `command.transform` + `reload()`; v1: TUI-Slash-Commands bzw. Fallback |
| P6-04 | Live-Ansicht (per SSE bzw. v2-RPC): Seitenleisten-Panel, Statuszeile, Detailansicht (v1 Route, v2 Session-Panel), `/aiflow-status`, `/aiflow-runs` |
| P6-05 | Dialoge: Mensch-Knoten, Rückfragen, Abschluss-Review (Kurzform), `/aiflow-inbox` |
| P6-06 | Benachrichtigungen, optional Ergebnis in die Session einfügen, Tools `aiflow_run` und `aiflow_list_workflows` |

**Akzeptanz:** Folgender Ablauf funktioniert in der opencode-TUI, jeweils mit v1 und mit v2:

1. Workflow im Web anlegen.
2. Der Command erscheint ohne Neustart (oder mit dokumentiertem, einmaligem Neustart, falls Spike S6 das erzwingt).
3. Run starten.
4. Fortschritt in der Seitenleiste verfolgen.
5. Freigabe beantworten.
6. Ergebnis übernehmen.

### Phase 7 – Web-UI II: Run-Ansicht, Review, History (L)

| ID | Aufgabe |
|---|---|
| P7-01 | Live-Run-Ansicht: Graph-Status, Zeitleiste, Schritt-Details (Prompt, Transkript, Übergabe, Diff, Dokumente) |
| P7-02 | Inbox (Freigaben, Rückfragen, Rechte-Anfragen, Reviews) |
| P7-03 | Review-Ansicht: Dateibaum, Diff, Teil-Übernahme, Kommentare, Änderungen anfordern, Branch, Patch, Verwerfen |
| P7-04 | History: Filter, Suche, Replay, erneut ausführen, Export, Löschen und Aufbewahrung |
| P7-05 | Übersicht (Dashboard) |

**Akzeptanz:** Ein Review mit Teil-Übernahme und „Änderungen anfordern“ führt nachweislich zu einem weiteren Durchlauf ab dem richtigen Knoten. Ein abgeschlossener Run lässt sich vollständig nachspielen.

**→ Meilenstein M3 (MVP)**

### Phase 8 – Erweiterte Ablaufsteuerung (M)

- Für-jedes-Knoten (inkl. `git-merge`-Einsammeln und Konfliktport)
- Sub-Workflows
- Race und `n-of-m` im UI, `first-matching`
- Entscheidungs-Stimmen (Self-Consistency), konservativer Fallback-Zweig
- Kontext-Modus `fork`
- Testlauf und Simulation (inkl. gespeicherter Simulationsskripte als Regressionstests)
- Agent-Playground
- Stagnationserkennung
- Sub-Agenten (7.16, 8.13): Delegations-Tool, Unter-Schritte, Limits, Delegationszwang, Wiederaufnahme, Anzeige in Run-Ansicht und TUI. Kann vorgezogen werden, weil es fast nur Engine und Plugin betrifft.

### Phase 9 – Ausbau (fortlaufend)

- Analytics und Run-Vergleich
- Übernahme pro Hunk
- Direct-LLM-Runtime
- Attached Mode in der TUI (v2: über den gemeinsamen Hintergrunddienst, Agenten-Sessions als Tabs)
- Panel für OpenCode Desktop (v2, GUI-Teil `./gui-experimental`)
- Eingebetteter Worker über `@opencode/sdk` (v2, abhängig von Spike S9)
- v1-Unterstützung entfernen, sobald sie nicht mehr gebraucht wird (ADR)
- Workflow-Pakete teilen (Export inkl. Agenten und Bausteinen)
- Weitere Punkte aus [Kapitel 19](#19-backlog--spätere-ideen)

---

## 16. Beispiel-Workflows

Diese Beispiele dienen gleichzeitig als **Test-Fixtures** (P1-08) und als **Vorlagen** in der UI.

### 16.1 Feature mit Größen-Triage

```mermaid
flowchart LR
  S([Start]) --> T["Evaluator<br/>3 Stimmen"]
  T -->|klein| I["Implementer"]
  I --> C{{"Checks<br/>Skript"}}
  C -->|ok| E1(["Ende: apply"])
  C -.->|"fehlgeschlagen · max 2"| I
  T -->|mittel| SW1[["Sub-Workflow<br/>Feature mit Multi-Review"]]
  T -->|groß| A["Architekt"] --> SW2[["Sub-Workflow<br/>Großes Feature"]]
  SW1 --> E2(["Ende: review"])
  SW2 --> E2
```

```yaml
  triage:
    type: agent
    agent: evaluator
    decision:
      votes: 3          # Self-Consistency: 3 Stimmen, Mehrheit entscheidet
      fallback: mittel  # bei Gleichstand oder Unklarheit
    ports:
      klein:  { description: "≤ 2 Dateien, keine Schnittstellen- oder Datenmodelländerung, kein neues Modul" }
      mittel: { description: "Mehrere Dateien oder Module, klar umrissen, keine neuen Abhängigkeiten" }
      groß:   { description: "Neue Module, Schnittstellen- oder Datenmodelländerungen, Migrationen" }
```

### 16.2 Best-of-3-Implementierung mit Decider

```mermaid
flowchart LR
  S([Start]) --> P["Planner<br/>plan.md W!"]
  P -->|"isolate"| A["Implementer A<br/>Modell X"]
  P -->|"isolate"| B["Implementer B<br/>Temperatur 0.8"]
  P -->|"isolate"| C["Implementer C<br/>Identität: minimalistisch"]
  A --> CA{{Checks A}}
  B --> CB{{Checks B}}
  C --> CC{{Checks C}}
  CA --> J(("Join<br/>all · candidates"))
  CB --> J
  CC --> J
  J --> D["Decider<br/>wählt Kandidat"]
  D --> R["Reviewer"]
  R -->|approved| E(["Ende: review"])
  R -.->|"rejected · max 2"| F["Fixer"] --> R
```

Der Decider sieht alle drei Kandidaten-Worktrees lesend, dazu deren Übergaben und Check-Ergebnisse. Er gibt `selectedCandidate` mit Begründung zurück. Ab dann arbeiten Reviewer und Fixer im gewählten Workspace weiter.

### 16.3 Multi-Review mit Veto und Feedback-Schleife (vollständiges YAML)

```mermaid
flowchart LR
  S([Start]) --> P["Planner<br/>plan.md W!"]
  P --> I["Implementer<br/>resume"]
  I --> C{{"Checks"}}
  C -.->|"failed · max 3"| I
  C -->|passed| SEC["Security-Reviewer"]
  C -->|passed| STD["Standards-Reviewer"]
  C -->|passed| TST["Test-Reviewer"]
  SEC --> V(("Verdict<br/>vote · veto"))
  STD --> V
  TST --> V
  V -.->|"rejected · max 3"| I
  V -->|approved| DOC["Documenter"]
  DOC --> E(["Ende: review"])
  C -. "Limit erreicht" .-> H["Mensch: wie weiter?"]
  V -. "Limit erreicht" .-> H
  H -->|weiter versuchen| I
  H -->|so übernehmen| DOC
  H -->|abbrechen| X(["Ende: cancelled"])
```

```yaml
# .aiflow/workflows/feature-review.yaml
schema: aiflow/workflow@1
id: feature-review
name: Feature mit Multi-Review
command: feature-review            # → /aiflow-wf-feature-review
description: >
  Plant und implementiert ein Feature, prüft es mit Typecheck, Lint und Tests
  sowie drei spezialisierten Reviewern (Veto) und dokumentiert das Ergebnis.

inputs:
  prompt: { type: text, required: true, label: Auftrag }

variables:
  checkCommand: pnpm typecheck && pnpm lint && pnpm test

settings:
  defaultModel: deepseek/deepseek-v4.1-flash
  workspace:
    base: working-tree
    setup: pnpm install --frozen-lockfile --prefer-offline
  limits: { maxSteps: 60, maxDuration: 3h, maxParallelSessions: 4 }

documents:
  plan.md:
    description: Umsetzungsplan mit Teilschritten und Akzeptanzkriterien
    format: markdown
    template: templates/plan.md
    requiredAtEnd: true
    exportTo: docs/plans/{{run.date}}-{{run.slug}}.md
  review.md:
    description: Gesammelte Review-Befunde aller Reviewer
    format: markdown

nodes:
  start:
    type: start

  plan:
    type: agent
    agent: planner
    documents: { plan.md: write-required }

  implement:
    type: agent
    agent: implementer
    contextMode: resume              # in Schleifen eigene Session fortsetzen
    documents: { plan.md: read, review.md: read }

  checks:
    type: script
    command: "{{vars.checkCommand}}"
    timeout: 15m
    ports:
      passed: { when: { "==": [{ var: exitCode }, 0] } }
      failed: { else: true }

  security:
    type: agent
    agent: security-reviewer
    workspace: { mode: read-only }
    documents: { plan.md: read, review.md: append }

  standards:
    type: agent
    agent: standards-reviewer
    workspace: { mode: read-only }
    documents: { plan.md: read, review.md: append }

  tests:
    type: agent
    agent: test-reviewer
    workspace: { mode: read-only }
    documents: { plan.md: read, review.md: append }

  verdict:
    type: join
    wait: all
    combine:
      strategy: vote
      field: output.approved
      rule: veto                     # ein "false" genügt für rejected
      ports: { "true": approved, "false": rejected }
    workspace: keep-base

  document:
    type: agent
    agent: documenter
    workspace: { mode: continue, writeScope: ["docs/**", "**/*.md"] }
    documents: { plan.md: read }

  escalate:
    type: human
    question: >
      Nach {{node.implement.visits}} Durchläufen gibt es weiterhin Probleme.
      Letztes Feedback: {{edge.feedback}}. Wie weiter?
    ports: [weiter-versuchen, so-übernehmen, abbrechen]
    allowFreeText: true

  done:
    type: end
    outcome: success
    finalize: review

  cancelled:
    type: end
    outcome: cancelled
    finalize: none

edges:
  - { from: start, to: plan }
  - from: plan
    to: implement
    handoff: { instruction: "Kurze Zusammenfassung; alle Details stehen in plan.md." }
  - { from: implement, to: checks }
  - from: checks.failed
    to: implement
    loop: { max: 3, onExceeded: escalate }
    handoff:
      include: [script.output]
      instruction: "Behebe die fehlschlagenden Checks. Ändere keine Tests, nur um sie grün zu bekommen."
  - { from: checks.passed, to: security }      # drei Kanten am selben Port → parallel
  - { from: checks.passed, to: standards }
  - { from: checks.passed, to: tests }
  - { from: security, to: verdict }
  - { from: standards, to: verdict }
  - { from: tests, to: verdict }
  - from: verdict.rejected
    to: implement
    loop: { max: 3, onExceeded: escalate }
    handoff:
      include: [join.feedback]
      instruction: "Arbeite alle Befunde mit Schweregrad ≥ medium ab; begründe abgelehnte Befunde."
  - { from: verdict.approved, to: document }
  - { from: document, to: done }
  - from: escalate.weiter-versuchen
    to: implement
    resetLoopCounters: true
    loop: { max: 1, onExceeded: cancelled }
  - { from: escalate.so-übernehmen, to: document }
  - { from: escalate.abbrechen, to: cancelled }

layout: {}   # Canvas-Positionen, werden vom Editor verwaltet
```

### 16.4 Bugfix mit Reproduktion (TDD)

```mermaid
flowchart LR
  S([Start]) --> AN["Analyst<br/>bug.md W! · schreibt failing Test"]
  AN --> R{{"Skript: neuer Test<br/>muss fehlschlagen"}}
  R -.->|"grün · max 2<br/>reproduziert nicht"| AN
  R -->|rot| FX["Fixer<br/>resume"]
  FX --> T{{"Skript: alle Tests"}}
  T -.->|"rot · max 3"| FX
  T -->|grün| RV["Reviewer"]
  RV -.->|"rejected · max 2"| FX
  RV -->|approved| E(["Ende: review"])
  T -. "Limit" .-> H["Mensch"]
```

Das Prinzip: Erst wenn ein Test den Fehler nachweislich reproduziert, darf gefixt werden. Der Fix ist erst fertig, wenn genau dieser Test und alle anderen Tests grün sind.

### 16.5 Großes Feature mit Für-jedes

```mermaid
flowchart LR
  S([Start]) --> AR["Architekt<br/>architecture.md W!"]
  AR --> P["Planner<br/>plan.md W! · output.tasks[]"]
  P --> H["Mensch: Plan freigeben?"]
  H -.->|ändern| P
  H -->|freigegeben| M[["Für jedes Task<br/>max 3 parallel · isolate<br/>Sub-Workflow: Task umsetzen"]]
  M --> J(("Einsammeln<br/>git-merge"))
  J -->|konflikt| INT["Integrator"]
  INT --> CH{{"Checks gesamt"}}
  J -->|ok| CH
  CH -.->|"failed · max 3"| FX["Fixer"] --> CH
  CH -->|passed| SEC["Security-Reviewer"]
  CH -->|passed| ARC["Architektur-Reviewer"]
  SEC --> V(("vote · veto"))
  ARC --> V
  V -.->|"rejected · max 2"| FX
  V -->|approved| DOC["Documenter"] --> E(["Ende: review"])
```

### 16.6 Weitere Ideen für Vorlagen

- **Refactoring mit Verhaltensgarantie:** Test-Writer sichert das aktuelle Verhalten ab → Refactorer → Tests müssen unverändert grün bleiben → Architektur-Reviewer.
- **Recherche → Entscheidungsvorlage** (Abschluss `none`): 3 Researcher parallel mit unterschiedlichen Quellen → Synthesizer → `decision.md` exportieren.
- **Dokumentations-Sync:** Diff seit dem letzten Release → Documenter → Reviewer → Ende als Branch.

### 16.7 Feature mit Recherche-Orchestrator

Ein Recherche-Orchestrator sammelt vor der Planung alle nötigen Informationen. Er delegiert an spezialisierte Explorer, so viele Wellen wie nötig, und schreibt das Ergebnis nach `research.md`. Danach geht es z. B. mit dem Workflow aus 16.3 als Sub-Workflow weiter. Der zweite Knoten im Beispiel ist ein Verifier, der große Prüfungen auf weitere Verifier aufteilen darf und kleine selbst erledigt.

```yaml
nodes:
  research:
    type: agent
    agent: research-orchestrator
    documents: { research.md: write-required }
    subagents:
      enabled: true
      allowed: [code-explorer, docs-explorer, dependency-explorer]
      mode: enforced              # optional | enforced
      maxParallel: 4
      maxRuns: 15
      maxWaves: 4
      depth: 0
      workspace: read-only
      documents: read
      context: [input.prompt, documents]
      timeoutPerAgent: 20m

  verify:
    type: agent
    agent: verifier
    subagents:
      enabled: true
      allowed: [verifier]         # darf weitere Verifier starten
      mode: optional              # kleine Prüfungen erledigt er selbst
      maxParallel: 3
      maxRuns: 6
```

---

## 17. Risiken und Spikes

### 17.1 Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| opencode-API ändert sich: v1 läuft aus, v2 ist neu und entwickelt sich schnell (einige genutzte APIs sind experimentell, z. B. `experimental.idle`, `generate.decisions`, GUI-Teil) | Zwei Treiber und zwei Plugin-Shells hinter versionsneutralen Interfaces, Fähigkeiten statt Versionsnummern, gepinnte Versionsbereiche, Matrix-Tests. Experimentelle v2-APIs nur mit Fallback. |
| Doppelter Wartungsaufwand für v1 und v2 | Logik ausschließlich im gemeinsamen Kern, Shells und Treiber dünn halten, Matrix-Tests; v1-Support-Fenster per ADR begrenzen |
| Strukturierte Übergaben sind mit dem Flash-Modell unzuverlässig | v1 `retryCount`, v2 Tool-Schema mit Fehlerrückmeldung und Nachforderung im Leerlauf; Zod-Validierung mit präziser Nachforderung, Fallback-Parser, mehrere Stimmen, konservativer Fallback-Zweig |
| Ressourcenlast bei vielen Worktrees (Abhängigkeiten, Plattenplatz, unter v1 auch LSP-Prozesse) | Setup-Cache (pnpm-Store), Parallelitätslimits, unter v1 LSP für Worker-Sessions begrenzen, Aufräum-Jobs, Speicheranzeige in `doctor` |
| Agenten umgehen Dateirechte über `bash` | Dreistufige Durchsetzung plus Integritätsprüfung, Grenzprüfung des Diffs, Bash-Allowlist-Presets |
| Endlosschleifen und lange Läufe | Pflicht-Limits, Run-Budgets, Stagnationserkennung, Eskalation an den Menschen |
| Ausufernde Delegation (zu viele Sub-Agenten, zu viele Wellen) | Budget, Parallelitäts- und Wellenlimit pro Knoten, Verschachtelungstiefe standardmäßig 0, globale Run-Budgets; die Engine setzt alle Limits durch |
| Merge-Konflikte bei der Übernahme | Basis-Snapshot, 3-Wege-Merge, Konfliktanzeige, Branch-Export als Ausweg |
| Daemon- oder Worker-Absturz während eines Runs | Event-Sourcing, Checkpoints, Wiederaufnahme, Worker-Neustart mit Schritt-Retry |
| Angriff über den lokalen HTTP-Server | Token, Host- und Origin-Prüfung, nur localhost, Workspace-Trust |
| Kontextüberlauf im Modus `resume` | opencode-Kompaktierung plus Kompaktierungs-Hook mit AiFlow-Pflichtkontext (v2 zusätzlich Instruktions-Einträge); Standard bleibt `fresh` |
| Der Editor wird zu komplex | Strikte Validierung mit klaren Meldungen, Vorlagen, Simulation, gute Standardwerte |

### 17.2 Spikes (vor der jeweiligen Phase, Ergebnis jeweils als ADR)

| ID | Linie | Frage | Phase |
|---|---|---|---|
| S1 | v1 / v2 | v1: Ersetzt oder ergänzt `system` beim Prompt den Agent-Prompt? v2: Wirken Agenten per `agent.transform` plus `context`-Hook pro Session wie gewünscht? Beide: Werden `AGENTS.md` und Projektregeln im Worktree geladen? | 3 |
| S2 | v1 / v2 | Semantik der Session-Rechte: Pfadmuster für `read`, `edit`, `external_directory`; Reihenfolge und Priorität gegenüber Agent- und Nutzerregeln; Aktionsnamen für MCP-Tools | 3 |
| S3 | v1 / v2 | Strukturierte Übergabe mit DeepSeek V4.1 Flash: v1 `format: json_schema` (Zuverlässigkeit, `retryCount`, Latenz); v2 Übergabe-Tool mit Schema per `context`-Hook und Nachforderung per `experimental.idle` | 3 |
| S4 | v1 | Mehrere Verzeichnisse parallel in einem Worker: Isolation, LSP-Prozesse, Speicher, Startzeit | 3 |
| S5 | v1 / v2 | Rollenwahl per `AIFLOW_WORKER`, Plugin-Prüfung über die Plugin-Liste, Passwortschutz des Workers | 3 |
| S6 | v1 / v2 | TUI-Teil: v1 Slash-Commands mit Argumenten, Laden des TUI-Teils, kombinierter TUI-Export möglich? v2 reaktiver Keymap-Layer, Session-Panel, `session.synthetic` ohne Modellantwort | 6 |
| S7 | v1 | `command.execute.before`: Rohargumente abfangen und den LLM-Aufruf vermeiden oder minimieren | 6 |
| S8 | v1 / v2 | Kombinierter Einstiegspunkt lädt in v1 (≥ 1.18.29) und v2; keine Konflikte durch versionsspezifische Imports oder `effect` | 3 |
| S9 | v2 | Läuft `@opencode/sdk` (eingebetteter Host) unter Node oder nur unter Bun? Lohnt sich der eingebettete Worker? | 9 |
| S10 | v1 / v2 | Blockierende Plugin-Tool-Aufrufe über viele Minuten (`aiflow_delegate`): Timeouts, Abbruch, Verhalten der Session und des Modells danach | 8 |

---

## 18. Offene Entscheidungen

Zu jeder Frage gibt es eine Empfehlung. Der Plan geht von der Empfehlung aus, solange nichts anderes entschieden wird.

| # | Frage | Empfehlung |
|---|---|---|
| 1 | Runtime des Daemons: Node 24 LTS oder Bun? | **Node 24 LTS**, Code Bun-kompatibel halten |
| 2 | Agenten in einem eigenen Worker oder in der TUI-Instanz des Nutzers? | **Eigener Worker**, Attached Mode später optional |
| 3 | Ablage der Definitionen | **Global und projektbezogen** (`.aiflow/`, per git teilbar) |
| 4 | UI-Sprache | **Deutsch** mit i18n, Englisch ergänzbar |
| 5 | Strukturierte Parallelität erzwingen oder freie Graphen erlauben? | **Erzwingen**, vermeidet Deadlocks und unklare Joins |
| 6 | Veröffentlichung: nur intern oder als npm-Paket? | Zunächst intern, Paketnamen frühzeitig reservieren |
| 7 | Standard-Abschluss neuer Workflows | **`review`**: sicher, und der Nutzer sieht immer, was passiert |
| 8 | Primäre opencode-Linie | **v2** als Referenz für neue Funktionen; v1 voll unterstützt, solange es im Team genutzt wird |
| 9 | Plugin-Installation | **Global** über `aiflow setup opencode`, damit Worker und TUI dasselbe Plugin laden |

---

## 19. Backlog / spätere Ideen

- **Attached Mode:** Agenten-Sessions als Child-Sessions in der opencode-TUI, live hineinspringen (v2: als Tabs über den gemeinsamen Hintergrunddienst).
- **OpenCode Desktop (v2):** AiFlow-Panel mit Run-Status und Inbox als GUI-Teil.
- **Weitere Runtimes:** Direct-LLM (OpenAI-kompatibel), Claude Code, andere Agent-CLIs, Remote-Worker.
- **Trigger:** Runs per Webhook, GitHub-Issue, Label oder Zeitplan starten (z. B. nächtlicher „Dependency-Update“-Workflow).
- **Workflow-Pakete teilen:** Export-Bundles inkl. Agenten, Bausteinen und Vorlagen; eine kleine Galerie.
- **Evals:** Workflows gegen eine feste Menge von Benchmark-Aufgaben laufen lassen und Qualität messen (Testquote, Review-Befunde, Dauer). Damit lassen sich Modell- und Workflow-Varianten objektiv vergleichen.
- **Lernende Bausteine:** Wiederkehrende Review-Befunde werden als Vorschlag in die Coding-Standards übernommen.
- **Projektgedächtnis:** Entscheidungslog über Runs hinweg (z. B. `decisions.md`), automatisch als Kontext angeboten.
- **Feingranulares Review:** Übernahme pro Hunk, Inline-Kommentare werden zu gezielten Aufgaben für einen Fix-Durchlauf.
- **Kosten- und Token-Dashboard,** Modellvergleiche, A/B-Tests von Workflow-Versionen.
- **Team-Modus** (geteilter Daemon, Rechte, gemeinsame History), bewusst erst sehr spät.
