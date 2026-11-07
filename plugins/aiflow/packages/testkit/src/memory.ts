import { AiflowError, type DiffStat, type FileChange, type RunEvent } from "@aiflow/core";
import type { DocumentStore, DocumentVersion, EventSink, RunState, ScriptResult, ScriptRunner, WorkspaceManager, WorkspaceRef } from "@aiflow/engine";

type Files = Map<string, string>;

/** Workspace-Manager im Speicher: Dateien je Workspace, Commits als Snapshots. */
export class MemoryWorkspaceManager implements WorkspaceManager {
  private readonly files = new Map<string, Files>();
  private readonly commits = new Map<string, Files>();
  private counter = 0;
  readonly project = new Map<string, Files>();
  readonly branches: string[] = [];
  readonly applied: string[][] = [];

  constructor(initial: Record<string, string> = {}) {
    this.initial = new Map(Object.entries(initial));
  }
  private readonly initial: Files;

  private commit(files: Files): string {
    const id = `c${++this.counter}`;
    this.commits.set(id, new Map(files));
    return id;
  }

  private filesOf(ref: WorkspaceRef): Files {
    const f = this.files.get(ref.id);
    if (!f) throw new AiflowError("WORKSPACE", `Workspace ${ref.id} unbekannt`);
    return f;
  }

  /** Für Fakes: Datei per Pfad des Workspaces schreiben. */
  writeByPath(path: string, relative: string, content: string): void {
    const id = path.replace("mem://ws/", "");
    const files = this.files.get(id);
    if (!files) throw new AiflowError("WORKSPACE", `Workspace ${path} unbekannt`);
    files.set(relative, content);
  }

  read(ref: WorkspaceRef, relative: string): string | undefined {
    return this.filesOf(ref).get(relative);
  }

  async prepare(runId: string, projectDir: string): Promise<WorkspaceRef> {
    const files = new Map(this.project.get(projectDir) ?? this.initial);
    const base = this.commit(files);
    const id = `${runId}-main`;
    this.files.set(id, files);
    return Promise.resolve({ id, path: `mem://ws/${id}`, head: base, base });
  }

  async isolate(runId: string, from: WorkspaceRef, label: string): Promise<WorkspaceRef> {
    const id = `${runId}-${label.replace(/\W+/g, "-")}-${++this.counter}`;
    this.files.set(id, new Map(this.filesOf(from)));
    return Promise.resolve({ ...from, id, path: `mem://ws/${id}` });
  }

  async scratch(runId: string, label: string): Promise<WorkspaceRef> {
    const id = `${runId}-scratch-${label}-${++this.counter}`;
    this.files.set(id, new Map());
    const c = this.commit(new Map());
    return Promise.resolve({ id, path: `mem://ws/${id}`, head: c, base: c });
  }

  async checkpoint(ref: WorkspaceRef): Promise<WorkspaceRef> {
    return Promise.resolve({ ...ref, head: this.commit(this.filesOf(ref)) });
  }

  async reset(ref: WorkspaceRef, commit: string): Promise<WorkspaceRef> {
    const snapshot = this.commits.get(commit);
    if (!snapshot) throw new AiflowError("WORKSPACE", `Commit ${commit} unbekannt`);
    this.files.set(ref.id, new Map(snapshot));
    return Promise.resolve({ ...ref, head: commit });
  }

  async diffStat(ref: WorkspaceRef, from: string): Promise<DiffStat> {
    const changes = await this.changes(ref, from);
    return { files: changes.length, additions: changes.reduce((n, c) => n + c.additions, 0), deletions: changes.reduce((n, c) => n + c.deletions, 0) };
  }

  async changes(ref: WorkspaceRef, from: string): Promise<FileChange[]> {
    const before = this.commits.get(from) ?? new Map<string, string>();
    const after = this.filesOf(ref);
    const result: FileChange[] = [];
    for (const [path, content] of after) {
      const old = before.get(path);
      if (old === undefined) result.push({ path, status: "added", additions: lines(content), deletions: 0, patch: `+${content}` });
      else if (old !== content) result.push({ path, status: "modified", additions: lines(content), deletions: lines(old), patch: `-${old}\n+${content}` });
    }
    for (const [path, old] of before) if (!after.has(path)) result.push({ path, status: "deleted", additions: 0, deletions: lines(old), patch: `-${old}` });
    return Promise.resolve(result.sort((a, b) => a.path.localeCompare(b.path)));
  }

  async merge(target: WorkspaceRef, sources: WorkspaceRef[]): Promise<{ ref: WorkspaceRef; conflicts: string[] }> {
    const files = this.filesOf(target);
    const base = this.commits.get(target.head) ?? new Map<string, string>();
    const conflicts = new Set<string>();
    const touched = new Map<string, string>();
    for (const source of sources) {
      for (const [path, content] of this.filesOf(source)) {
        if (base.get(path) === content) continue;
        const prev = touched.get(path);
        if (prev !== undefined && prev !== content) conflicts.add(path);
        touched.set(path, content);
        files.set(path, content);
      }
    }
    return { ref: await this.checkpoint(target), conflicts: [...conflicts] };
  }

  async writeFile(ref: WorkspaceRef, relative: string, content: string): Promise<void> {
    this.filesOf(ref).set(relative, content);
    return Promise.resolve();
  }

  async apply(ref: WorkspaceRef, projectDir: string, only?: string[]): Promise<{ applied: string[]; conflicts: string[] }> {
    const changes = (await this.changes(ref, ref.base)).filter((c) => !only || only.includes(c.path));
    const project = this.project.get(projectDir) ?? new Map(this.initial);
    for (const c of changes) {
      const content = this.filesOf(ref).get(c.path);
      if (content === undefined) project.delete(c.path);
      else project.set(c.path, content);
    }
    this.project.set(projectDir, project);
    this.applied.push(changes.map((c) => c.path));
    return { applied: changes.map((c) => c.path), conflicts: [] };
  }

  async createBranch(_ref: WorkspaceRef, _projectDir: string, name: string): Promise<string> {
    this.branches.push(name);
    return Promise.resolve(name);
  }

  async patch(ref: WorkspaceRef): Promise<string> {
    return Promise.resolve(`mem://patch/${ref.id}.patch`);
  }

  async cleanup(): Promise<void> {
    return Promise.resolve();
  }
}

function lines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

export class MemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<string, string>();
  private readonly history = new Map<string, DocumentVersion[]>();

  async init(runId: string, documents: { name: string; content: string }[]): Promise<void> {
    for (const d of documents) this.docs.set(`${runId}/${d.name}`, d.content);
    return Promise.resolve();
  }
  path(runId: string, name: string): string {
    return `mem://docs/${runId}/${name}`;
  }
  async read(runId: string, name: string): Promise<string> {
    return Promise.resolve(this.docs.get(`${runId}/${name}`) ?? "");
  }
  async write(runId: string, name: string, content: string): Promise<void> {
    this.docs.set(`${runId}/${name}`, content);
    return Promise.resolve();
  }
  /** Für Fakes: Schreiben über den Pfad, den der Agent bekommen hat. */
  writeByPath(path: string, content: string): void {
    this.docs.set(path.replace("mem://docs/", ""), content);
  }
  async recordVersion(runId: string, name: string, version: DocumentVersion): Promise<void> {
    const key = `${runId}/${name}`;
    this.history.set(key, [...(this.history.get(key) ?? []), version]);
    return Promise.resolve();
  }
  async versions(runId: string, name: string): Promise<DocumentVersion[]> {
    return Promise.resolve(this.history.get(`${runId}/${name}`) ?? []);
  }
}

export class MemorySink implements EventSink {
  readonly events: RunEvent[] = [];
  readonly states = new Map<string, RunState>();
  append(event: RunEvent): void {
    this.events.push(event);
  }
  saveState(state: RunState): void {
    this.states.set(state.id, structuredClone(state));
  }
  ofRun(runId: string): RunEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }
}

export type ScriptHandler = (command: string, cwd: string, call: number) => ScriptResult | Promise<ScriptResult>;

export class FakeScriptRunner implements ScriptRunner {
  readonly calls: { command: string; cwd: string }[] = [];
  constructor(private readonly handler: ScriptHandler = () => ({ exitCode: 0, output: "ok" })) {}
  async run(command: string, options: { cwd: string }): Promise<ScriptResult> {
    this.calls.push({ command, cwd: options.cwd });
    return this.handler(command, options.cwd, this.calls.length);
  }
}
