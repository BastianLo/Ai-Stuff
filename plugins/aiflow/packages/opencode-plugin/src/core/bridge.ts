import { spawn } from "node:child_process";
import { AiflowClient, type GlobalEvent, type RunView } from "@aiflow/client";
import { commandName, type RunSummary, type Workflow } from "@aiflow/core";
import { readAuthToken, serveArgs, type PluginOptions } from "./config.js";

export interface WorkflowCommand {
  id: string;
  command: string;
  name: string;
  description: string;
}

export const COMMAND_PREFIX = "aiflow-wf-";

/** Bridge-Rolle: Verbindung der opencode-Instanz des Nutzers zum AiFlow-Daemon. */
export class BridgeService {
  readonly client: AiflowClient;
  private workflowsCache: WorkflowCommand[] = [];

  constructor(
    readonly options: PluginOptions,
    readonly projectDir: string,
    token = readAuthToken(),
  ) {
    this.client = new AiflowClient({ baseUrl: options.url, ...(token ? { token } : {}) });
  }

  async ensureDaemon(): Promise<boolean> {
    if (await this.client.health().then(() => true, () => false)) return true;
    if (!this.options.autoStart) return false;
    const child = spawn(this.options.aiflowCommand, serveArgs(this.options), { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await this.client.health().then(() => true, () => false)) return true;
    }
    return false;
  }

  async init(): Promise<void> {
    if (!(await this.ensureDaemon())) return;
    await this.client.registerProject(this.projectDir).catch(() => undefined);
    await this.refreshWorkflows();
  }

  get workflows(): WorkflowCommand[] {
    return this.workflowsCache;
  }

  async refreshWorkflows(): Promise<WorkflowCommand[]> {
    const entries = await this.client.workflows(this.projectDir).catch(() => []);
    this.workflowsCache = entries
      .filter((e) => !e.shadowed && e.definition)
      .map((e) => {
        const w = e.definition as Workflow;
        return { id: w.id, command: `${COMMAND_PREFIX}${commandName(w)}`, name: w.name, description: w.description || w.name };
      });
    return this.workflowsCache;
  }

  workflowForCommand(command: string): WorkflowCommand | undefined {
    return this.workflowsCache.find((w) => w.command === command || w.command === `${COMMAND_PREFIX}${command}` || w.id === command);
  }

  /** Startet einen Workflow. Der Prompt wird unverändert übergeben. */
  async start(workflowId: string, prompt: string, origin: "tui" | "api" = "tui"): Promise<string> {
    const { id } = await this.client.startRun({ workflowId, projectDir: this.projectDir, input: { prompt }, origin });
    return id;
  }

  async configureUrl(): Promise<string> {
    const { url } = await this.client.createLogin(this.projectDir);
    return url;
  }

  openBrowser(url: string): void {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }

  async latestRun(): Promise<RunView | undefined> {
    const [latest] = await this.client.runs({ project: this.projectDir, limit: 1 });
    return latest ? this.client.run(latest.id) : undefined;
  }

  watch(onEvent: (event: GlobalEvent) => void, signal: AbortSignal): void {
    void this.client.subscribeGlobal(onEvent, signal, this.projectDir);
  }

  summaryLine(run: RunSummary): string {
    return `${STATUS_ICON[run.status] ?? "•"} ${run.workflowName} · ${run.status}`;
  }
}

export const STATUS_ICON: Record<string, string> = {
  running: "▶",
  waiting_input: "⏸",
  review_pending: "👀",
  paused: "⏸",
  interrupted: "⚠",
  completed: "✔",
  failed: "✖",
  cancelled: "■",
};

/** Kompakte Darstellung eines Runs für Seitenleiste und Statuszeile (PLAN.md 10.3). */
export function statusLines(run: RunView, now = Date.now()): string[] {
  const elapsed = formatDuration((run.finishedAt ?? now) - (run.startedAt ?? run.createdAt));
  const lines = [`AiFlow · ${run.workflow.id} · ${elapsed}`];
  const top = run.steps.filter((s) => !s.parentStepId && s.nodeType !== "start" && s.nodeType !== "end");
  for (const s of top.slice(-8)) {
    const icon = s.status === "completed" ? "✔" : s.status === "failed" ? "✖" : s.status === "running" ? "▶" : s.status === "waiting" ? "⏸" : "■";
    const dur = s.metrics.durationMs !== undefined ? formatDuration(s.metrics.durationMs) : "";
    const note = s.status === "running" ? (s.delegation ? `Welle ${s.delegation.waves} · Budget ${s.delegation.runs}/${s.delegation.budget}` : "") : s.port && s.port !== "next" ? `→ ${s.port}` : "";
    lines.push(`${icon} ${s.label}${s.visit > 1 ? ` #${s.visit}` : ""}  ${dur}  ${note}`.trimEnd());
    if (s.status === "running" && s.delegation) {
      for (const sub of run.steps.filter((x) => x.parentStepId === s.id).slice(-5)) {
        lines.push(`   ${sub.status === "completed" ? "✔" : sub.status === "running" ? "▶" : "✖"} ${sub.label}`);
      }
    }
  }
  const decisions = top.filter((s) => s.handoff?.branch).slice(-3);
  if (decisions.length > 0) {
    lines.push("─ Entscheidungen");
    for (const d of decisions) lines.push(`• ${d.label} → ${d.handoff?.branch ?? ""}${d.handoff?.branchReason ? ` („${d.handoff.branchReason.slice(0, 40)}“)` : ""}`);
  }
  if (run.status === "review_pending") lines.push("👀 Review ausstehend – /aiflow-inbox");
  if (run.status === "waiting_input") lines.push("⏸ Wartet auf dich – /aiflow-inbox");
  return lines;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
