import { AiflowClient } from "@aiflow/client";
import { useSearchParams } from "react-router-dom";
import { useEffect } from "react";

export const api = new AiflowClient({ baseUrl: window.location.origin, credentials: "include" });

const KEY = "aiflow.project";

/** Aktuelles Projekt: aus `?project=` (Login-Link) oder zuletzt gewählt. */
export function useProject(): [string | undefined, (path: string | undefined) => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("project") ?? undefined;
  useEffect(() => {
    if (fromUrl) localStorage.setItem(KEY, fromUrl);
  }, [fromUrl]);
  const project = fromUrl ?? localStorage.getItem(KEY) ?? undefined;
  const set = (path: string | undefined) => {
    if (path) localStorage.setItem(KEY, path);
    else localStorage.removeItem(KEY);
    const next = new URLSearchParams(params);
    if (path) next.set("project", path);
    else next.delete("project");
    setParams(next, { replace: true });
  };
  return [project, set];
}
