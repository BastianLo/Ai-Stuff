import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunSummary } from "@aiflow/core";
import { summarizeRun, type EventSink, type RunState } from "@aiflow/engine";

export interface RunFilter {
  projectDir?: string;
  workflowId?: string;
  status?: string;
  query?: string;
  limit?: number;
  includeChildren?: boolean;
}

export interface DefinitionVersion {
  kind: string;
  id: string;
  scope: string;
  version: string;
  createdAt: number;
  content: string;
}

/** Event-Store und Run-Projektion in SQLite (node:sqlite). */
export class SqliteStore implements EventSink {
  private readonly db: DatabaseSync;
  private readonly insertEvent;
  private readonly upsertRun;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        status TEXT NOT NULL,
        parent_run_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        summary TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        step_id TEXT,
        data TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS definition_versions (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        scope TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (kind, id, scope, version)
      );
    `);
    const row = this.db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    if (!row) this.db.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    this.insertEvent = this.db.prepare("INSERT OR IGNORE INTO events (run_id, seq, ts, type, step_id, data) VALUES (?, ?, ?, ?, ?, ?)");
    this.upsertRun = this.db.prepare(`
      INSERT INTO runs (id, workflow_id, project_dir, status, parent_run_id, created_at, updated_at, summary, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, summary = excluded.summary, state = excluded.state
    `);
  }

  append(event: RunEvent): void {
    this.insertEvent.run(event.runId, event.seq, event.ts, event.type, event.stepId ?? null, JSON.stringify(event.data));
  }

  saveState(state: RunState): void {
    const summary = summarizeRun(state);
    this.upsertRun.run(
      state.id,
      state.spec.workflow.id,
      state.spec.projectDir,
      state.status,
      state.spec.parentRunId ?? null,
      state.createdAt,
      Date.now(),
      JSON.stringify(summary),
      JSON.stringify(state),
    );
  }

  listRuns(filter: RunFilter = {}): RunSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectDir) {
      where.push("project_dir = ?");
      params.push(filter.projectDir);
    }
    if (filter.workflowId) {
      where.push("workflow_id = ?");
      params.push(filter.workflowId);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (!filter.includeChildren) where.push("parent_run_id IS NULL");
    if (filter.query) {
      where.push("summary LIKE ?");
      params.push(`%${filter.query}%`);
    }
    const sql = `SELECT summary FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
    params.push(filter.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as { summary: string }[]).map((r) => JSON.parse(r.summary) as RunSummary);
  }

  getState(id: string): RunState | undefined {
    const row = this.db.prepare("SELECT state FROM runs WHERE id = ?").get(id) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as RunState) : undefined;
  }

  /** Runs, die beim Herunterfahren noch nicht abgeschlossen waren. */
  unfinishedStates(): RunState[] {
    const rows = this.db.prepare("SELECT state FROM runs WHERE status NOT IN ('completed', 'failed', 'cancelled')").all() as { state: string }[];
    return rows.map((r) => JSON.parse(r.state) as RunState);
  }

  events(runId: string, afterSeq = 0): RunEvent[] {
    const rows = this.db.prepare("SELECT run_id, seq, ts, type, step_id, data FROM events WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, afterSeq) as {
      run_id: string;
      seq: number;
      ts: number;
      type: RunEvent["type"];
      step_id: string | null;
      data: string;
    }[];
    return rows.map((r) => ({ runId: r.run_id, seq: r.seq, ts: r.ts, type: r.type, ...(r.step_id ? { stepId: r.step_id } : {}), data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  deleteRun(id: string): void {
    this.db.prepare("DELETE FROM events WHERE run_id = ?").run(id);
    this.db.prepare("DELETE FROM runs WHERE id = ? OR parent_run_id = ?").run(id, id);
  }

  saveDefinitionVersion(v: DefinitionVersion): void {
    this.db
      .prepare("INSERT OR IGNORE INTO definition_versions (kind, id, scope, version, created_at, content) VALUES (?, ?, ?, ?, ?, ?)")
      .run(v.kind, v.id, v.scope, v.version, v.createdAt, v.content);
  }

  definitionVersions(kind: string, id: string): DefinitionVersion[] {
    const rows = this.db
      .prepare("SELECT kind, id, scope, version, created_at, content FROM definition_versions WHERE kind = ? AND id = ? ORDER BY created_at DESC")
      .all(kind, id) as { kind: string; id: string; scope: string; version: string; created_at: number; content: string }[];
    return rows.map((r) => ({ kind: r.kind, id: r.id, scope: r.scope, version: r.version, createdAt: r.created_at, content: r.content }));
  }

  close(): void {
    this.db.close();
  }
}
