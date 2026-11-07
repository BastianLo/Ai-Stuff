# AGENTS.md – Regeln für KI-Agenten in `plugins/aiflow`

Lies zuerst `PLAN.md` (Architektur) und `docs/IMPLEMENTATION_STATUS.md` (Stand).

## Befehle
- `pnpm install` – Abhängigkeiten
- `pnpm check` – Typecheck, Lint, Paketgrenzen, Tests (muss grün sein)
- `pnpm test` – nur Tests, `pnpm build` – alles bauen
- `node packages/cli/dist/index.js serve --runtime simulation` – Daemon mit Simulations-Runtime

## Paketgrenzen (durch dependency-cruiser erzwungen)
- `core`: Domänenmodell, keine I/O, keine Abhängigkeit auf andere Pakete.
- `engine`: nur `core` + eigene Interfaces (Ports).
- `store`, `workspace-git`: nur `core`. `runtime-opencode`: `core` + `engine` (Ports). Treiber `v1/` und `v2/` importieren sich nie gegenseitig.
- `server` ist die einzige Stelle, die alles zusammensteckt.
- `web`, `cli`, `opencode-plugin` sprechen nur über `client` mit dem Daemon.

## Code-Regeln
- TypeScript strikt; kein `any`, keine Non-Null-Assertions in `src`, `as` nur mit Begründung.
- Zod an allen Systemgrenzen (HTTP, Dateien, Runtime-Ausgaben).
- Erwartbare Fehler als `AiflowError` mit Code; Exceptions nur für Programmierfehler.
- Diskriminierte Unions mit exhaustivem `switch` (`assertNever`).
- Zeit und IDs über injizierte `Clock`/`IdGenerator`, damit Tests deterministisch sind.
- Neue Logik braucht Tests in `packages/<paket>/test`.
