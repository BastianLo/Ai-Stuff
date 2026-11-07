export function duration(ms: number | undefined): string {
  if (ms === undefined) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")} min`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
}

export function dateTime(ts: number | undefined): string {
  if (!ts) return "–";
  return new Date(ts).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function relative(ts: number | undefined): string {
  if (!ts) return "–";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "gerade eben";
  if (diff < 3_600_000) return `vor ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `vor ${Math.round(diff / 3_600_000)} h`;
  return dateTime(ts);
}

export function tokens(n: number | undefined): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export const STATUS_LABEL: Record<string, string> = {
  running: "läuft",
  waiting_input: "wartet auf dich",
  review_pending: "Review ausstehend",
  paused: "pausiert",
  interrupted: "unterbrochen",
  completed: "abgeschlossen",
  failed: "fehlgeschlagen",
  cancelled: "abgebrochen",
  waiting: "wartet",
};

export const NODE_TYPE_LABEL: Record<string, string> = {
  start: "Start",
  agent: "Agent",
  script: "Skript",
  condition: "Bedingung",
  join: "Zusammenführung",
  map: "Für jedes",
  human: "Mensch",
  subworkflow: "Sub-Workflow",
  end: "Ende",
  note: "Notiz",
  subagent: "Sub-Agent",
  "map-item": "Teilaufgabe",
};
