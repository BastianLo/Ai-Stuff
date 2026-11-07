import type { InboxItem } from "@aiflow/core";
import type { RunView } from "@aiflow/client";
import { BridgeService, statusLines, type WorkflowCommand } from "./bridge.js";
import { resolveOptions } from "./config.js";

export interface TuiSnapshot {
  connected: boolean;
  run?: RunView;
  lines: string[];
  inbox: InboxItem[];
  workflows: WorkflowCommand[];
}

/** Versionsneutraler Zustand der TUI-Ansicht: aktueller Run, Inbox und Workflows (per SSE aktualisiert). */
export class TuiState {
  readonly bridge: BridgeService;
  private snapshot: TuiSnapshot = { connected: false, lines: [], inbox: [], workflows: [] };
  private readonly listeners = new Set<(s: TuiSnapshot) => void>();
  private readonly stop = new AbortController();
  private lastStatus?: string;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  onAttention?: (title: string, message: string) => void;

  constructor(rawOptions: unknown, projectDir: string) {
    this.bridge = new BridgeService(resolveOptions(rawOptions), projectDir);
  }

  get current(): TuiSnapshot {
    return this.snapshot;
  }

  onChange(listener: (s: TuiSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.bridge.init().catch(() => undefined);
    await this.refresh();
    this.bridge.watch(() => this.scheduleRefresh(), this.stop.signal);
    // Laufzeitanzeige aktualisieren, auch ohne Events
    const tick = setInterval(() => this.publish(), 1000);
    this.stop.signal.addEventListener("abort", () => clearInterval(tick));
  }

  dispose(): void {
    this.stop.abort();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  async refresh(): Promise<void> {
    try {
      const [run, inbox, workflows] = await Promise.all([
        this.bridge.latestRun(),
        this.bridge.client.inbox(this.bridge.projectDir),
        this.bridge.refreshWorkflows(),
      ]);
      this.snapshot = { connected: true, ...(run ? { run } : {}), lines: run ? statusLines(run) : ["AiFlow · noch kein Run"], inbox, workflows };
      if (run && run.status !== this.lastStatus) {
        if (this.lastStatus !== undefined && ["waiting_input", "review_pending", "completed", "failed"].includes(run.status)) {
          const message = run.status === "waiting_input" ? "wartet auf dich" : run.status === "review_pending" ? "Review ausstehend" : run.status === "completed" ? "fertig" : `fehlgeschlagen: ${run.error ?? ""}`;
          this.onAttention?.(`AiFlow · ${run.workflow.name}`, message);
        }
        this.lastStatus = run.status;
      }
    } catch {
      this.snapshot = { ...this.snapshot, connected: false, lines: ["AiFlow · Daemon nicht erreichbar"] };
    }
    this.publish();
  }

  private publish(): void {
    if (this.snapshot.run && this.snapshot.run.status === "running") this.snapshot = { ...this.snapshot, lines: statusLines(this.snapshot.run) };
    for (const l of this.listeners) l(this.snapshot);
  }

  compactStatus(): string {
    const run = this.snapshot.run;
    if (!run) return "";
    const active = run.steps.filter((s) => !s.parentStepId && s.status === "running").map((s) => s.label);
    return `⚙ ${run.workflow.id} · ${active[0] ?? run.status}`;
  }
}
