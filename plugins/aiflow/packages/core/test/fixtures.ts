import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentSchema, parseYaml, snippetSchema, workflowSchema, type AgentDefinition, type Snippet, type Workflow } from "@aiflow/core";

const examples = fileURLToPath(new URL("../../../examples/", import.meta.url));

function loadDir<T>(dir: string, parse: (text: string, name: string) => T): T[] {
  return readdirSync(`${examples}${dir}`)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => parse(readFileSync(`${examples}${dir}/${f}`, "utf8"), f));
}

export function loadExamples(): { agents: Map<string, AgentDefinition>; workflows: Map<string, Workflow>; snippets: Map<string, Snippet> } {
  const agents = new Map(loadDir("agents", (t, n) => parseYaml(agentSchema, t, n)).map((a) => [a.id, a]));
  const workflows = new Map(loadDir("workflows", (t, n) => parseYaml(workflowSchema, t, n)).map((w) => [w.id, w]));
  const snippets = new Map(loadDir("snippets", (t, n) => parseYaml(snippetSchema, t, n)).map((s) => [s.id, s]));
  return { agents, workflows, snippets };
}
