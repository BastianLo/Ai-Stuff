import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AiflowError,
  agentSchema,
  errorMessage,
  parseYaml,
  snippetSchema,
  toYaml,
  workflowSchema,
  type AgentDefinition,
  type Snippet,
  type Workflow,
} from "@aiflow/core";

export type DefinitionKind = "agents" | "workflows" | "snippets";
export type Scope = "global" | "project";

type DefinitionOf<K extends DefinitionKind> = K extends "agents" ? AgentDefinition : K extends "workflows" ? Workflow : Snippet;

const SCHEMAS = { agents: agentSchema, workflows: workflowSchema, snippets: snippetSchema } as const;

export interface DefinitionEntry<K extends DefinitionKind = DefinitionKind> {
  kind: K;
  id: string;
  scope: Scope;
  file: string;
  version: string;
  definition?: DefinitionOf<K>;
  error?: string;
  /** Eine globale Definition, die von einer Projekt-Definition gleicher ID verdeckt wird. */
  shadowed?: boolean;
}

export interface ResolvedDefinitions {
  agents: Record<string, AgentDefinition>;
  workflows: Record<string, Workflow>;
  snippets: Record<string, Snippet>;
  versions: Record<string, string>;
}

export function versionOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

export interface DefinitionRepositoryOptions {
  globalDir: string;
  onSave?: (entry: { kind: DefinitionKind; id: string; scope: Scope; version: string; content: string }) => void;
}

/** Definitionen als YAML-Dateien: global (`<globalDir>/<kind>`) und pro Projekt (`<projekt>/.aiflow/<kind>`). */
export class DefinitionRepository {
  constructor(private readonly options: DefinitionRepositoryOptions) {}

  dirOf(kind: DefinitionKind, scope: Scope, projectDir?: string): string {
    if (scope === "project") {
      if (!projectDir) throw new AiflowError("VALIDATION", "Für Projekt-Definitionen fehlt das Projektverzeichnis.");
      return join(projectDir, ".aiflow", kind);
    }
    return join(this.options.globalDir, kind);
  }

  private read<K extends DefinitionKind>(kind: K, scope: Scope, projectDir?: string): DefinitionEntry<K>[] {
    const dir = this.dirOf(kind, scope, projectDir);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort()
      .map((f) => {
        const file = join(dir, f);
        const content = readFileSync(file, "utf8");
        const base: DefinitionEntry<K> = { kind, id: f.replace(/\.ya?ml$/, ""), scope, file, version: versionOf(content) };
        try {
          const definition = parseYaml(SCHEMAS[kind], content, `${kind}/${f}`) as DefinitionOf<K>;
          return { ...base, id: definition.id, definition };
        } catch (error) {
          return { ...base, error: errorMessage(error) };
        }
      });
  }

  list<K extends DefinitionKind>(kind: K, projectDir?: string): DefinitionEntry<K>[] {
    const project = projectDir ? this.read(kind, "project", projectDir) : [];
    const projectIds = new Set(project.map((e) => e.id));
    const global = this.read(kind, "global").map((e) => (projectIds.has(e.id) ? { ...e, shadowed: true } : e));
    return [...project, ...global];
  }

  get<K extends DefinitionKind>(kind: K, id: string, projectDir?: string): DefinitionEntry<K> {
    const entry = this.list(kind, projectDir).find((e) => e.id === id && !e.shadowed);
    if (!entry) throw new AiflowError("NOT_FOUND", `${kindLabel(kind)} „${id}“ existiert nicht.`);
    return entry;
  }

  /** Validiert und speichert eine Definition. Gibt die neue Version zurück. */
  save<K extends DefinitionKind>(kind: K, raw: unknown, scope: Scope, projectDir?: string): DefinitionEntry<K> {
    const parsed = SCHEMAS[kind].safeParse(raw);
    if (!parsed.success) {
      throw new AiflowError("VALIDATION", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), parsed.error.issues);
    }
    const definition = parsed.data as DefinitionOf<K>;
    const dir = this.dirOf(kind, scope, projectDir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${definition.id}.yaml`);
    const content = toYaml(definition);
    writeFileSync(file, content);
    const version = versionOf(content);
    this.options.onSave?.({ kind, id: definition.id, scope, version, content });
    return { kind, id: definition.id, scope, file, version, definition };
  }

  delete(kind: DefinitionKind, id: string, scope: Scope, projectDir?: string): void {
    const file = join(this.dirOf(kind, scope, projectDir), `${id}.yaml`);
    if (!existsSync(file)) throw new AiflowError("NOT_FOUND", `${kindLabel(kind)} „${id}“ existiert nicht (${scope}).`);
    rmSync(file);
  }

  resolve(projectDir?: string): ResolvedDefinitions {
    const out: ResolvedDefinitions = { agents: {}, workflows: {}, snippets: {}, versions: {} };
    for (const kind of ["agents", "workflows", "snippets"] as const) {
      for (const e of this.list(kind, projectDir)) {
        if (e.shadowed || !e.definition) continue;
        (out[kind] as Record<string, unknown>)[e.id] = e.definition;
        out.versions[`${kind}/${e.id}`] = e.version;
      }
    }
    return out;
  }

  /** Kopiert Beispiel-Definitionen in den globalen Bereich, wenn dieser noch leer ist. */
  seed(fromDir: string): number {
    let count = 0;
    for (const kind of ["agents", "workflows", "snippets"] as const) {
      const target = this.dirOf(kind, "global");
      if (existsSync(target) && readdirSync(target).length > 0) continue;
      const source = join(fromDir, kind);
      if (!existsSync(source)) continue;
      mkdirSync(target, { recursive: true });
      for (const f of readdirSync(source)) {
        writeFileSync(join(target, f), readFileSync(join(source, f)));
        count++;
      }
    }
    return count;
  }

  // ----------------------------------------------------------- Workspace-Trust

  /** Fingerabdruck aller Projekt-Definitionen. Ändert er sich, muss erneut vertraut werden. */
  projectFingerprint(projectDir: string): string | undefined {
    const parts: string[] = [];
    for (const kind of ["agents", "workflows", "snippets"] as const) {
      for (const e of this.read(kind, "project", projectDir)) parts.push(`${kind}/${e.id}:${e.version}`);
    }
    return parts.length === 0 ? undefined : versionOf(parts.sort().join("\n"));
  }

  private trustFile(): string {
    return join(this.options.globalDir, "trust.json");
  }

  private trusted(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.trustFile(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  isTrusted(projectDir: string): boolean {
    const fingerprint = this.projectFingerprint(projectDir);
    return fingerprint === undefined || this.trusted()[projectDir] === fingerprint;
  }

  trust(projectDir: string): void {
    const fingerprint = this.projectFingerprint(projectDir);
    if (!fingerprint) return;
    mkdirSync(this.options.globalDir, { recursive: true });
    writeFileSync(this.trustFile(), JSON.stringify({ ...this.trusted(), [projectDir]: fingerprint }, null, 2));
  }
}

function kindLabel(kind: DefinitionKind): string {
  return kind === "agents" ? "Agent" : kind === "workflows" ? "Workflow" : "Baustein";
}
