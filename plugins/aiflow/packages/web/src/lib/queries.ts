import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AgentDefinition, Snippet, Workflow } from "@aiflow/core";
import { api } from "./api";

export function useAgents(project?: string) {
  return useQuery({ queryKey: ["definitions", "agents", project], queryFn: () => api.agents(project) });
}
export function useWorkflows(project?: string) {
  return useQuery({ queryKey: ["definitions", "workflows", project], queryFn: () => api.workflows(project) });
}
export function useSnippets(project?: string) {
  return useQuery({ queryKey: ["definitions", "snippets", project], queryFn: () => api.snippets(project) });
}
export function useRuntime(project?: string) {
  return useQuery({ queryKey: ["runtime", project], queryFn: () => api.runtime(project), staleTime: 60_000 });
}

export function agentMap(entries: { id: string; definition?: AgentDefinition; shadowed?: boolean }[] | undefined): Map<string, AgentDefinition> {
  return new Map((entries ?? []).filter((e) => e.definition && !e.shadowed).map((e) => [e.id, e.definition as AgentDefinition]));
}
export function workflowList(entries: { definition?: Workflow; shadowed?: boolean }[] | undefined): Workflow[] {
  return (entries ?? []).filter((e) => e.definition && !e.shadowed).map((e) => e.definition as Workflow);
}
export function snippetList(entries: { definition?: Snippet; shadowed?: boolean }[] | undefined): Snippet[] {
  return (entries ?? []).filter((e) => e.definition && !e.shadowed).map((e) => e.definition as Snippet);
}

/** Run mit Live-Aktualisierung über den Run-Stream. */
export function useLiveRun(id: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["run", id], queryFn: () => api.run(id ?? ""), enabled: Boolean(id) });
  useEffect(() => {
    if (!id) return;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    void api.subscribeRun(
      id,
      () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          void qc.invalidateQueries({ queryKey: ["run", id] });
        }, 300);
      },
      stop.signal,
    );
    return () => {
      stop.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, qc]);
  return query;
}
