import { readdirSync, readFileSync } from "node:fs";
import { agentSchema, parseYaml, sequentialIds, snippetSchema, workflowSchema, type AgentDefinition, type Clock, type Snippet, type Workflow } from "@aiflow/core";
import { Engine, type RunSpec, type ScriptRunner } from "@aiflow/engine";
import { FakeRuntime, type FakeEntry } from "./fake-runtime.js";
import { FakeScriptRunner, MemoryDocumentStore, MemorySink, MemoryWorkspaceManager, type ScriptHandler } from "./memory.js";

export interface Definitions {
  agents: Record<string, AgentDefinition>;
  workflows: Record<string, Workflow>;
  snippets: Record<string, Snippet>;
}

/** Lädt die Beispiel-Definitionen aus `examples/` (oder einem anderen Verzeichnis mit agents/, workflows/, snippets/). */
export function loadDefinitions(dir: string): Definitions {
  const load = <T>(sub: string, parse: (text: string, file: string) => T): T[] => {
    try {
      return readdirSync(`${dir}/${sub}`)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => parse(readFileSync(`${dir}/${sub}/${f}`, "utf8"), f));
    } catch {
      return [];
    }
  };
  const agents = load("agents", (t, f) => parseYaml(agentSchema, t, f));
  const workflows = load("workflows", (t, f) => parseYaml(workflowSchema, t, f));
  const snippets = load("snippets", (t, f) => parseYaml(snippetSchema, t, f));
  return {
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    workflows: Object.fromEntries(workflows.map((w) => [w.id, w])),
    snippets: Object.fromEntries(snippets.map((s) => [s.id, s])),
  };
}

export const examplesDir = new URL("../../../examples", import.meta.url).pathname;

export interface HarnessOptions {
  script?: Record<string, FakeEntry>;
  scripts?: ScriptHandler | ScriptRunner;
  files?: Record<string, string>;
  maxParallelSessions?: number;
  definitions?: Definitions;
  idNamespace?: string;
}

/** Engine mit Fakes für Szenario-Tests. */
export function createHarness(options: HarnessOptions = {}) {
  const definitions = options.definitions ?? loadDefinitions(examplesDir);
  const workspace = new MemoryWorkspaceManager(options.files ?? { "README.md": "# Demo\n" });
  const documents = new MemoryDocumentStore();
  const sink = new MemorySink();
  const runtime = new FakeRuntime(options.script ?? {}, { workspace, documents });
  const scripts = options.scripts && typeof options.scripts === "object" ? options.scripts : new FakeScriptRunner(options.scripts);
  let now = 1_700_000_000_000;
  const clock: Clock = { now: () => (now += 1000) };
  const engine = new Engine({ runtime, workspace, scripts, documents, sink, clock, ids: sequentialIds(options.idNamespace), maxParallelSessions: options.maxParallelSessions ?? 8 });

  const spec = (workflowId: string, prompt = "Baue ein Feature", overrides: Partial<RunSpec> = {}): RunSpec => {
    const workflow = definitions.workflows[workflowId];
    if (!workflow) throw new Error(`Workflow ${workflowId} unbekannt`);
    return {
      workflow,
      version: "test",
      agents: definitions.agents,
      snippets: definitions.snippets,
      workflows: definitions.workflows,
      input: { prompt },
      projectDir: "/project",
      origin: "api",
      ...overrides,
    };
  };

  const run = async (workflowId: string, prompt?: string, overrides?: Partial<RunSpec>) => {
    const id = engine.start(spec(workflowId, prompt, overrides));
    const state = await engine.wait(id);
    return { id, state, events: sink.ofRun(id) };
  };

  return { engine, runtime, workspace, documents, sink, scripts, definitions, spec, run };
}
