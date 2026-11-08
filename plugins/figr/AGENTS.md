# AGENTS.md – Regeln für KI-Agenten in `plugins/figr`

Lies zuerst `plan.md` (Abschnitte 1–4 und 14) und `docs/STATUS.md` (Stand, Abweichungen).

## Befehle
- `pnpm install` – Abhängigkeiten
- `pnpm check` – Typecheck (Server und TUI), Lint, Schichtgrenzen, Tests. Muss grün sein.
- `pnpm test`, `pnpm coverage` – nur Tests
- `pnpm schema` – `figr.schema.json` aus dem Zod-Schema erzeugen (nach Änderungen an `src/config/schema.ts`)

## Aufbau
- `server.ts` – v2-Einstieg (`{ id, setup }`), `tui.tsx` – TUI-Einstieg
- `src/core/` – **rein**: Gate-Automat, Runden/Quorum, `decide`, nächster Schritt, Statustexte, Zustandstypen. Kein I/O.
- `src/config/` – Schema (Zod, strikt), Laden/Merge/`extends`, Validierung gegen die Agentenliste
- `src/figr.ts` – hostunabhängiger Controller: Hooks, Tools, Befehle; spricht nur über Ports
- `src/host/ports.ts` – Ports; `src/host/v2.ts` – **einzige** Stelle, die `@opencode/plugin` kennt; `src/host/tools.ts` – Tool-Definitionen
- `src/patterns/` – Review-Gremium, Multi-Plan, Best-of-N (über das Interface `PatternHost`)
- `src/fanout/` – Fan-out-Runner und Rollen-Prompts
- `src/workspace/` – git (Worktrees, Diff, Apply), Checks
- `src/artifacts/`, `src/state/`, `src/audit/`, `src/tui/`, `src/util/`

## Grenzen (dependency-cruiser)
- `core` importiert nur `core`, `util/{hash,text,pattern,errors}` und `config/schema` (Typen/Zod).
- Nur `src/host/` darf `@opencode/plugin` importieren.
- `patterns`, `fanout`, `state` importieren nicht `host/v2` oder `host/tools`.
- Keine Zyklen.

## Code-Regeln
- TypeScript strikt, kein `any`, keine Non-Null-Assertions in `src`.
- Zod an allen Grenzen (Konfiguration, Tool-Eingaben, gespeicherter Zustand, Statusdatei).
- Erwartbare Fehler als `FigrError`; der Text geht direkt ans Modell: was blockiert, warum, nächster Schritt.
- Texte für Nutzer und Sperrmeldungen deutsch; **Prompts für Agenten englisch** (`src/fanout/prompts.ts`, Systemblöcke).
- Neue Logik braucht Tests. Muster und Hooks über `test/fake-host.ts` (In-Memory-Ports, simulierte Kind-Sessions), git mit echten Temp-Repos.
- Jeder Meilenstein: `pnpm check` grün, Eintrag in `docs/STATUS.md`.
