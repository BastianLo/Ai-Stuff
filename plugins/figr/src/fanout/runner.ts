import type { ChildRole } from "../core/types.ts";
import type { SessionPort } from "../host/ports.ts";
import { messageOf } from "../util/errors.ts";
import { mapLimit } from "../util/semaphore.ts";

export interface FanoutJob {
  /** Kurzname für Anzeige und Zuordnung (z. B. „A“ oder Agentenname). */
  readonly label: string;
  readonly role: ChildRole;
  readonly agent: string;
  readonly title: string;
  readonly prompt: string;
  readonly directory?: string;
}

export type FanoutStatus = "done" | "missing" | "failed" | "cancelled";

export interface FanoutResult<R = unknown> {
  readonly job: FanoutJob;
  readonly sessionID?: string;
  readonly status: FanoutStatus;
  readonly result?: R;
  readonly error?: string;
}

export interface FanoutDeps<R> {
  readonly sessions: SessionPort;
  /** Registriert die Kind-Session (Rolle, Bindung), bevor sie den ersten Prompt bekommt. */
  register(job: FanoutJob, sessionID: string): void;
  /** Strukturiertes Ergebnis (Urteil/Report) der Kind-Session, sobald vorhanden. */
  result(sessionID: string): R | undefined;
  /** Nachforderung, falls noch erlaubt (zählt mit dem Idle-Hook zusammen); sonst `undefined`. */
  nudge(sessionID: string): string | undefined;
  onStatus?(job: FanoutJob, status: "running" | FanoutStatus, sessionID?: string): void;
}

/**
 * Gemeinsamer Fan-out-Runner (plan.md 11): Kind-Sessions anlegen, prompten, warten, Ergebnis einsammeln.
 * Parallelität über `maxParallel`; bei Abbruch werden alle laufenden Kinder unterbrochen.
 */
export async function runFanout<R>(parentID: string, jobs: readonly FanoutJob[], deps: FanoutDeps<R>, opts: { maxParallel: number; signal: AbortSignal }): Promise<FanoutResult<R>[]> {
  const running = new Set<string>();
  const onAbort = (): void => {
    for (const id of running) void deps.sessions.interrupt(id).catch(() => undefined);
  };
  opts.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await mapLimit(jobs, opts.maxParallel, async (job): Promise<FanoutResult<R>> => {
      if (opts.signal.aborted) return { job, status: "cancelled" };
      let sessionID: string | undefined;
      try {
        sessionID = await deps.sessions.create({ parentID, agent: job.agent, title: job.title, ...(job.directory ? { directory: job.directory } : {}) });
        deps.register(job, sessionID);
        running.add(sessionID);
        deps.onStatus?.(job, "running", sessionID);
        await deps.sessions.prompt(sessionID, job.prompt);
        await deps.sessions.wait(sessionID, opts.signal);
        let result = deps.result(sessionID);
        // Fallback, falls der Idle-Hook nicht nachfordern konnte: erneut prompten, solange erlaubt.
        while (result === undefined && !opts.signal.aborted) {
          const nudge = deps.nudge(sessionID);
          if (!nudge) break;
          await deps.sessions.prompt(sessionID, nudge);
          await deps.sessions.wait(sessionID, opts.signal);
          result = deps.result(sessionID);
        }
        running.delete(sessionID);
        if (opts.signal.aborted && result === undefined) {
          deps.onStatus?.(job, "cancelled", sessionID);
          return { job, sessionID, status: "cancelled" };
        }
        const status: FanoutStatus = result === undefined ? "missing" : "done";
        deps.onStatus?.(job, status, sessionID);
        return result === undefined ? { job, sessionID, status } : { job, sessionID, status, result };
      } catch (error) {
        if (sessionID) running.delete(sessionID);
        const status: FanoutStatus = opts.signal.aborted ? "cancelled" : "failed";
        deps.onStatus?.(job, status, sessionID);
        return { job, status, error: messageOf(error), ...(sessionID ? { sessionID } : {}) };
      }
    });
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
  }
}
