import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api, useProject } from "../lib/api";
import { Icon } from "./Icon";
import { Badge, cx } from "./ui";

const NAV = [
  { to: "/", label: "Übersicht", icon: "home", end: true },
  { to: "/inbox", label: "Inbox", icon: "inbox" },
  { to: "/workflows", label: "Workflows", icon: "flow" },
  { to: "/agents", label: "Agenten", icon: "bot" },
  { to: "/snippets", label: "Bausteine", icon: "puzzle" },
  { to: "/runs", label: "Runs", icon: "runs" },
  { to: "/settings", label: "Einstellungen", icon: "settings" },
];

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => localStorage.getItem("aiflow.theme") === "dark" || (localStorage.getItem("aiflow.theme") === null && window.matchMedia("(prefers-color-scheme: dark)").matches));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("aiflow.theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

/** Hält Listen per globalem SSE-Stream aktuell. */
function useLiveInvalidation(project: string | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    const stop = new AbortController();
    void api.subscribeGlobal(
      (e) => {
        if (e.type === "run.updated") {
          void qc.invalidateQueries({ queryKey: ["runs"] });
          void qc.invalidateQueries({ queryKey: ["run", e.runId] });
        }
        if (e.type === "inbox.changed" || e.type === "run.updated") void qc.invalidateQueries({ queryKey: ["inbox"] });
        if (e.type === "definitions.changed") void qc.invalidateQueries({ queryKey: ["definitions"] });
      },
      stop.signal,
      project,
    );
    return () => stop.abort();
  }, [project, qc]);
}

export function Layout({ children }: { children: ReactNode }) {
  const [project, setProject] = useProject();
  const [dark, toggleTheme] = useTheme();
  const location = useLocation();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), refetchInterval: 15_000 });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });
  const inbox = useQuery({ queryKey: ["inbox", project], queryFn: () => api.inbox(project) });
  useLiveInvalidation(project);
  const fullBleed = /^\/workflows\/[^/]+$/.test(location.pathname) || /^\/runs\/[^/]+(\/review)?$/.test(location.pathname);
  const runtime = health.data?.runtime;

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src="/favicon.svg" alt="" className="h-7 w-7" />
          <div>
            <div className="text-sm font-semibold leading-tight">AiFlow</div>
            <div className="text-[11px] text-slate-500">Workflows aus KI-Agenten</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={{ pathname: item.to, search: project ? `?project=${encodeURIComponent(project)}` : "" }}
              end={item.end}
              className={({ isActive }) =>
                cx(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm font-medium",
                  isActive ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
                )
              }
            >
              <Icon name={item.icon} />
              <span className="flex-1">{item.label}</span>
              {item.to === "/inbox" && (inbox.data?.length ?? 0) > 0 && <Badge color="amber">{inbox.data?.length}</Badge>}
            </NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-slate-200 p-3 text-xs dark:border-slate-800">
          <div className="flex items-center gap-2" title={runtime?.error}>
            <span className={cx("h-2 w-2 rounded-full", runtime?.ready ? "bg-emerald-500" : "bg-amber-500")} />
            <span className="text-slate-600 dark:text-slate-400">
              Runtime: {runtime?.id ?? "…"}
              {runtime?.api ? ` (${runtime.api})` : ""}
            </span>
          </div>
          <button type="button" onClick={toggleTheme} className="flex items-center gap-2 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
            <Icon name={dark ? "sun" : "moon"} size={14} /> {dark ? "Helles Design" : "Dunkles Design"}
          </button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 dark:border-slate-800 dark:bg-slate-900">
          <span className="text-xs font-medium text-slate-500">Projekt</span>
          <select
            value={project ?? ""}
            onChange={(e) => setProject(e.target.value || undefined)}
            className="max-w-md rounded-md border-0 bg-slate-100 py-1 pl-2 pr-8 text-sm ring-0 dark:bg-slate-800"
          >
            <option value="">Global (keine Projektauswahl)</option>
            {projects.data?.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name} – {p.path}
              </option>
            ))}
            {project && !projects.data?.some((p) => p.path === project) && <option value={project}>{project}</option>}
          </select>
          {project && projects.data?.find((p) => p.path === project)?.trusted === false && (
            <Badge color="amber" title="Projekt-Definitionen müssen freigegeben werden (Einstellungen)">
              <Icon name="shield" size={12} /> nicht freigegeben
            </Badge>
          )}
        </header>
        <main className={cx("min-h-0 flex-1", fullBleed ? "overflow-hidden" : "overflow-y-auto px-6 py-6")}>{children}</main>
      </div>
    </div>
  );
}
