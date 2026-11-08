import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuditKind =
  | "session.guided"
  | "config.error"
  | "gate.passed"
  | "gate.invalidated"
  | "round.started"
  | "verdict"
  | "verdict.stale"
  | "report"
  | "blocked"
  | "override"
  | "escalation"
  | "fanout.started"
  | "fanout.finished"
  | "checks"
  | "nudge"
  | "apply";

/** Append-only Audit-Log `workDir/<sid>/log.jsonl` (plan.md 13). Fehler beim Schreiben werden geschluckt. */
export class AuditLog {
  constructor(private readonly sessionDir: (sid: string) => string) {}

  write(sessionID: string, kind: AuditKind, data: Record<string, unknown> = {}, at = Date.now()): void {
    const file = join(this.sessionDir(sessionID), "log.jsonl");
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify({ at: new Date(at).toISOString(), kind, ...data })}\n`);
    } catch {
      // Audit ist best effort; der Zustand selbst liegt in ctx.storage.
    }
  }

  /** Volle Ausgaben (z. B. Check-Logs) neben dem Log ablegen. Gibt den Pfad zurück. */
  attach(sessionID: string, name: string, content: string): string | undefined {
    const file = join(this.sessionDir(sessionID), "logs", name.replace(/[^\w.-]+/g, "_"));
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    } catch {
      return undefined;
    }
  }
}
