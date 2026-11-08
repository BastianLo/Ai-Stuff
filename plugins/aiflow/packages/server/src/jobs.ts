import { randomBytes } from "node:crypto";
import { AiflowError } from "@aiflow/core";

export type JobView = { state: "running" } | { state: "done"; result: unknown } | { state: "failed"; error: { code: string; message: string } };

/**
 * Lang laufende Worker-Aufrufe (Delegation, Rückfragen an den Nutzer) laufen als Auftrag: Das Plugin startet ihn und
 * fragt das Ergebnis ab. So begrenzen keine HTTP-Timeouts, wie lange ein Sub-Agent oder ein Mensch brauchen darf.
 */
export class WorkerJobs {
  private readonly jobs = new Map<string, JobView>();

  start(work: () => Promise<unknown>): string {
    const id = `job_${randomBytes(9).toString("base64url")}`;
    this.jobs.set(id, { state: "running" });
    work().then(
      (result) => this.jobs.set(id, { state: "done", result }),
      (error: unknown) =>
        this.jobs.set(id, {
          state: "failed",
          error: error instanceof AiflowError ? { code: error.code, message: error.message } : { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) },
        }),
    );
    return id;
  }

  /** Stand eines Auftrags; ein abgeschlossener Auftrag wird beim Abholen entfernt. */
  take(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    if (job && job.state !== "running") this.jobs.delete(id);
    return job;
  }
}
