# ADR-0002: Run-Zustand und Persistenz

Status: angenommen

Jeder Run schreibt ein append-only Event-Log (Historie, SSE, Replay der Anzeige). Zusätzlich speichert die Engine nach
jedem Übergang einen serialisierbaren Zustands-Snapshot. Die Wiederaufnahme nach einem Absturz lädt den Snapshot und
startet unterbrochene Schritte neu (Workspace wird auf den Start-Checkpoint zurückgesetzt). Ein vollständiger
Reducer über alle Events wäre eleganter, ist für die Wiederaufnahme aber nicht nötig und doppelt fehleranfällig.

Persistenz nutzt `node:sqlite` (Node ≥ 22.12), damit keine native Abhängigkeit gebaut werden muss.
