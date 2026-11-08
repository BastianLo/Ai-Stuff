import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { artifactPath, DiffCache, diffVersion, fileVersion, normalizeText, relativeTo, textVersion, type ArtifactLocation } from "./artifacts/version.ts";
import { AuditLog } from "./audit/log.ts";
import { renderReport } from "./audit/report.ts";
import { ConfigError, configSources, loadConfig, watchConfig, type ConfigSources } from "./config/load.ts";
import type { FigrConfig, ProfileConfig } from "./config/schema.ts";
import { validateConfig } from "./config/validate.ts";
import { decide, type Action, type Decision, type SessionRole } from "./core/decide.ts";
import { computeGates, isComplete, reviewTarget, roundFor, type GateView } from "./core/gates.ts";
import { phaseAgents } from "./core/graph.ts";
import { nextStep, openGates } from "./core/next-step.ts";
import { isReportRole, issuesText, REPORT_SCHEMAS, toJsonSchema, VerdictInputSchema } from "./core/reports.ts";
import { roundFindings } from "./core/round.ts";
import { compactStatus, gateLine, statusText, systemBlock } from "./core/status.ts";
import { emptyGateState, newSessionState, RoundSchema, type Child, type CurrentVersions, type FanoutInfo, type GateState, type Round, type SessionState } from "./core/types.ts";
import { nudgeText, reviewerAppendix } from "./fanout/prompts.ts";
import type { FanoutDeps, FanoutJob } from "./fanout/runner.ts";
import type { HostPorts } from "./host/ports.ts";
import { runBestOfN } from "./patterns/best-of-n.ts";
import type { PatternHost } from "./patterns/host.ts";
import { runPlan } from "./patterns/plan.ts";
import { runReview, type ToolRun } from "./patterns/review.ts";
import { StateStore } from "./state/store.ts";
import { FigrError, messageOf } from "./util/errors.ts";
import { runCheck, runChecks } from "./workspace/checks.ts";
import { diffStat, headCommit } from "./workspace/git.ts";

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
export const SHELL_TOOLS: ReadonlySet<string> = new Set(["shell", "bash"]);
export const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["subagent", "task"]);

export const TOOL = {
  status: "figr_status",
  plan: "figr_plan",
  review: "figr_review",
  bestOfN: "figr_best_of_n",
  submit: "figr_submit",
  verdict: "figr_verdict",
  report: "figr_report",
} as const;
export const ALL_TOOLS: readonly string[] = Object.values(TOOL);

const CHILD_NUDGES = 2;

export interface Resolved {
  readonly state: SessionState;
  readonly role: SessionRole;
  readonly child?: Child;
}

export interface ContextResult {
  /** Systemblock, der vorangestellt wird. */
  readonly system?: string;
  /** Sichtbare FiGr-Tools; alle anderen FiGr-Tools werden ausgeblendet. */
  readonly visible: readonly string[];
  /** Pro Session gesetztes Eingabeschema (z. B. figr_report je Rolle). */
  readonly inputs: Readonly<Record<string, Record<string, unknown>>>;
}

export interface FigrOptions {
  readonly profile?: string;
  readonly config?: string;
  readonly global?: boolean;
  /** Konfiguration direkt übergeben (Tests); sonst aus Dateien. */
  readonly inlineConfig?: FigrConfig;
  readonly watch?: boolean;
}

interface Known {
  parentID?: string;
  agent?: string;
}

/**
 * Hostunabhängiger Controller: hält Konfiguration und Zustand, beantwortet Hooks, führt Tools und Befehle aus.
 * `host/v2.ts` bildet die opencode-Hooks hierauf ab; Tests sprechen ihn direkt über einen FakeHost an.
 */
export class Figr implements PatternHost {
  readonly audit: AuditLog;
  readonly store: StateStore;
  config: FigrConfig | undefined;
  configProblem: string | undefined;
  warnings: string[] = [];
  private readonly sources: ConfigSources;
  private readonly diff = new DiffCache();
  private readonly known = new Map<string, Known>();
  /** child sessionID → root sessionID */
  private readonly childIndex = new Map<string, string>();
  /** Sessions, die als nicht geführt erkannt wurden (mit dem Agenten zum Zeitpunkt der Prüfung). */
  private readonly unmanaged = new Map<string, string | undefined>();
  private readonly roots = new Set<string>();
  private readonly judgeRules = new Map<string, { all: string[]; allowed: string[] }>();
  private readonly checkRuns = new Map<string, Promise<void>>();
  private readonly toasts: { at: number; message: string }[] = [];
  private stopWatch: (() => void) | undefined;
  private fanoutSeq = 0;
  /** Letzter Nachforderungstext pro Session (damit eigene Nachrichten den Zähler nicht zurücksetzen). */
  private readonly ownMessages = new Map<string, string>();

  constructor(
    readonly ports: HostPorts,
    private readonly options: FigrOptions = {},
  ) {
    this.sources = configSources(ports.directory, { ...(options.config ? { config: options.config } : {}), ...(options.global === false ? { global: false } : {}) });
    this.store = new StateStore(ports.storage, ports.log);
    this.audit = new AuditLog((sid) => this.sessionDir(sid));
    this.store.onChange((s) => this.writeStatusFile(s));
  }

  // ───────────────────────── Konfiguration ─────────────────────────

  async start(): Promise<void> {
    await this.reloadConfig();
    if (this.options.watch !== false && !this.options.inlineConfig) this.stopWatch = watchConfig(this.sources, () => void this.reloadConfig());
  }

  async stop(): Promise<void> {
    this.stopWatch?.();
    for (const t of this.statusTimers.values()) clearTimeout(t);
    this.statusTimers.clear();
    await this.store.flush();
  }

  /** Lädt die Konfiguration neu. Bei Fehlern bleibt die letzte gültige aktiv (plan.md 6.1). */
  async reloadConfig(): Promise<void> {
    let next: FigrConfig | undefined;
    try {
      next = this.options.inlineConfig ?? loadConfig(this.sources);
    } catch (error) {
      this.configProblem = error instanceof ConfigError ? `Konfiguration ungültig:\n${error.message}` : `Konfiguration nicht lesbar: ${messageOf(error)}`;
      this.toast(`FiGr: ${this.configProblem}${this.config ? " (letzte gültige bleibt aktiv)" : " – FiGr ist inaktiv"}`);
      this.ports.log.error(this.configProblem);
      return;
    }
    if (!next) {
      this.config = undefined;
      this.configProblem = `Keine figr.jsonc gefunden (${this.sources.project}) – FiGr ist inaktiv.`;
      return;
    }
    let agents: Awaited<ReturnType<HostPorts["agents"]["list"]>> = [];
    try {
      agents = await this.ports.agents.list();
    } catch (error) {
      this.ports.log.warn("Agentenliste nicht verfügbar; Querverweise ungeprüft", { error: messageOf(error) });
    }
    if (agents.length > 0) {
      const result = validateConfig(next, agents);
      this.warnings = result.warnings.map((w) => `${w.path}: ${w.message}`);
      if (result.errors.length > 0) {
        this.configProblem = `Konfiguration ungültig:\n${result.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`;
        this.toast(`FiGr: ${this.configProblem}${this.config ? " (letzte gültige bleibt aktiv)" : " – FiGr ist inaktiv"}`);
        this.ports.log.error(this.configProblem);
        return;
      }
      for (const w of this.warnings) this.ports.log.warn(w);
    }
    this.config = next;
    this.configProblem = undefined;
    // Neue Konfiguration: bisher ungeführte Sessions neu bewerten.
    this.unmanaged.clear();
  }

  profileName(state: SessionState): string {
    const cfg = this.config;
    if (!cfg) return state.profile;
    return cfg.profiles[state.profile] ? state.profile : cfg.defaultProfile;
  }

  profile(state: SessionState): ProfileConfig {
    const p = this.config?.profiles[this.profileName(state)];
    if (!p) throw new FigrError("FiGr ist nicht konfiguriert.");
    return p;
  }

  // ───────────────────────── Orte ─────────────────────────

  get workDirAbs(): string {
    const wd = this.config?.workDir ?? ".opencode/figr";
    return isAbsolute(wd) ? wd : resolve(this.ports.directory, wd);
  }

  sessionDir(sessionID: string): string {
    return join(this.workDirAbs, sessionID.replace(/[^\w.-]/g, "_"));
  }

  location(state: SessionState): ArtifactLocation {
    const rel = relative(this.ports.directory, this.workDirAbs);
    return { project: this.ports.directory, sessionDir: this.sessionDir(state.sessionID), workDirRel: rel.startsWith("..") ? "" : rel };
  }

  // ───────────────────────── Sessions ─────────────────────────

  private async info(sessionID: string): Promise<Known> {
    const cached = this.known.get(sessionID);
    if (cached) return cached;
    let k: Known = {};
    try {
      const s = await this.ports.sessions.get(sessionID);
      k = { ...(s.parentID ? { parentID: s.parentID } : {}), ...(s.agent ? { agent: s.agent } : {}) };
    } catch {
      // Unbekannte Session: als ungeführt behandeln.
    }
    this.known.set(sessionID, k);
    return k;
  }

  /** Session-Ereignis `session.created` (plan.md 10.5). */
  async onSessionCreated(sessionID: string, parentID: string | undefined, agent: string | undefined): Promise<void> {
    this.known.set(sessionID, { ...(parentID ? { parentID } : {}), ...(agent ? { agent } : {}) });
    if (parentID) await this.resolve(sessionID, agent);
  }

  /** Ermittelt, ob eine Session geführt ist (Orchestrator) bzw. Kind einer geführten Session. */
  async resolve(sessionID: string, agent?: string, depth = 0): Promise<Resolved | undefined> {
    if (!this.config || depth > 12) return undefined;
    const known = await this.info(sessionID);
    if (agent && known.agent !== agent) {
      known.agent = agent;
      this.unmanaged.delete(sessionID);
    }
    const rootID = this.childIndex.get(sessionID);
    if (rootID) {
      const state = await this.store.load(rootID);
      const child = state?.children[sessionID];
      if (state && child) return { state, role: { kind: "child", role: child.role }, child };
    }
    if (this.unmanaged.has(sessionID) && this.unmanaged.get(sessionID) === known.agent) return undefined;

    const own = await this.store.load(sessionID);
    if (own) {
      this.indexRoot(own);
      return { state: own, role: { kind: "orchestrator" } };
    }
    if (!known.parentID) {
      if (known.agent && this.config.orchestrators.includes(known.agent)) return { state: await this.guide(sessionID), role: { kind: "orchestrator" } };
      this.unmanaged.set(sessionID, known.agent);
      return undefined;
    }
    const parent = await this.resolve(known.parentID, undefined, depth + 1);
    if (!parent) {
      this.unmanaged.set(sessionID, known.agent);
      return undefined;
    }
    const child = await this.registerDiscovered(parent.state, sessionID, known.parentID, known.agent ?? "unknown");
    return { state: parent.state, role: { kind: "child", role: child.role }, child };
  }

  private indexRoot(state: SessionState): void {
    if (this.roots.has(state.sessionID)) return;
    this.roots.add(state.sessionID);
    for (const id of Object.keys(state.children)) this.childIndex.set(id, state.sessionID);
  }

  /** Macht eine Session zur geführten Session (Orchestrator bzw. `/figr on`). */
  private async guide(sessionID: string, enabled = true): Promise<SessionState> {
    const existing = await this.store.load(sessionID);
    if (existing) return existing;
    const profile = this.options.profile && this.config?.profiles[this.options.profile] ? this.options.profile : (this.config?.defaultProfile ?? "");
    const base = await headCommit(this.ports.directory).catch(() => undefined);
    const state = newSessionState(sessionID, profile, this.ports.clock.now(), base);
    state.enabled = enabled;
    this.store.put(state);
    this.indexRoot(state);
    // Kinder dieser Session waren evtl. als ungeführt vermerkt.
    this.unmanaged.clear();
    this.audit.write(sessionID, "session.guided", { profile, baseCommit: base ?? null });
    this.suggestGitignore();
    return state;
  }

  private gitignoreHinted = false;

  /** Einmaliger Hinweis, workDir in .gitignore aufzunehmen; FiGr schreibt nie selbst in .gitignore (plan.md 13). */
  private suggestGitignore(): void {
    if (this.gitignoreHinted) return;
    this.gitignoreHinted = true;
    const rel = relative(this.ports.directory, this.workDirAbs);
    if (rel.startsWith("..")) return;
    const gi = join(this.ports.directory, ".gitignore");
    let content: string;
    try {
      content = existsSync(gi) ? normalizeText(readFileSync(gi, "utf8")) : "";
    } catch {
      return;
    }
    const first = rel.split("/")[0] ?? rel;
    if (!content.split("\n").some((l) => l.trim().replace(/\/$/, "") === rel || l.trim().replace(/\/$/, "") === first)) this.toast(`FiGr: Tipp – „${rel}/“ in .gitignore aufnehmen.`);
  }

  private async registerDiscovered(state: SessionState, sessionID: string, parentID: string, agent: string): Promise<Child> {
    const existing = state.children[sessionID];
    if (existing) return existing;
    const idx = state.pending.findIndex((p) => p.agent === agent);
    let child: Child;
    if (idx >= 0) {
      const [binding] = state.pending.splice(idx, 1);
      child = { sessionID, agent, role: "reviewer", parentID, nudges: 0, done: false, ...(binding ? { gate: binding.gate, version: binding.version } : {}) };
    } else {
      const views = await this.views(state);
      const reviewing = views.filter((v) => v.config.approve?.reviewers.includes(agent));
      const phase = views.some((v) => phaseAgents(v.config).includes(agent));
      const target = reviewTarget(reviewing);
      if (target?.version && !phase) child = { sessionID, agent, role: "reviewer", parentID, nudges: 0, done: false, gate: target.name, version: target.version.hash };
      else child = { sessionID, agent, role: phase ? "phase" : "other", parentID, nudges: 0, done: false };
    }
    this.registerChild(state, child);
    return child;
  }

  registerChild(state: SessionState, child: Child): void {
    state.children[child.sessionID] = child;
    this.childIndex.set(child.sessionID, state.sessionID);
    this.known.set(child.sessionID, { parentID: child.parentID, agent: child.agent });
    this.store.touch(state);
  }

  touch(state: SessionState): void {
    this.store.touch(state);
  }

  // ───────────────────────── Gates und Versionen ─────────────────────────

  private gateState(state: SessionState, name: string): GateState {
    let gs = state.gates[name];
    if (!gs) {
      gs = emptyGateState();
      state.gates[name] = gs;
    }
    return gs;
  }

  bumpDiff(): void {
    this.diff.bump();
  }

  /** Aktuelle Artefakt-Versionen (lazy, Diff gecacht) und Nachweise vom Host. */
  private async currentVersions(state: SessionState, profile: ProfileConfig): Promise<CurrentVersions> {
    const loc = this.location(state);
    const out: Record<string, string | undefined> = {};
    for (const [name, gate] of Object.entries(profile.gates)) {
      const gs = this.gateState(state, name);
      const a = gate.artifact;
      if (a?.type === "file") out[name] = fileVersion(artifactPath(a, loc));
      else if (a?.type === "text") out[name] = textVersion(gs.text);
      else if (a?.type === "diff") out[name] = await this.diff.get(`${state.baseCommit ?? ""}|${a.ignore.join(",")}`, () => diffVersion(loc, state.baseCommit, a.ignore).catch(() => undefined));
      const ev = gate.evidence;
      if (ev?.file && !gs.evidencePassed) gs.evidenceFlags.file = existsSync(isAbsolute(ev.file.path) ? ev.file.path : resolve(ev.file.root === "project" ? loc.project : loc.sessionDir, ev.file.path));
      const hash = out[name];
      if (hash && !gs.versions.some((v) => v.hash === hash)) {
        const prefix = name[0] ?? "v";
        gs.versions.push({ hash, short: `${prefix}${gs.versions.length + 1}`, at: this.ports.clock.now() });
        this.store.touch(state);
      }
    }
    return out;
  }

  /** Gate-Ansichten berechnen und abgeleitete Zustände festhalten (bestanden, verfallen). */
  async views(state: SessionState): Promise<GateView[]> {
    const profile = this.profile(state);
    const current = await this.currentVersions(state, profile);
    let views = computeGates(profile, state, current);
    let changed = false;
    for (const v of views) {
      const gs = this.gateState(state, v.name);
      if (v.status === "passed" && v.version && v.config.approve && gs.passedVersion !== v.version.hash && (!gs.passedVersion || v.config.approve.invalidateOnChange)) {
        gs.passedVersion = v.version.hash;
        changed = true;
        this.audit.write(state.sessionID, "gate.passed", { gate: v.name, version: v.version.short });
        this.toast(`FiGr: Gate „${v.name}“ abgenommen (${v.version.short})`);
      } else if (v.status !== "passed" && v.status !== "skipped" && gs.passedVersion && v.config.approve?.invalidateOnChange && v.version && gs.passedVersion !== v.version.hash) {
        this.audit.write(state.sessionID, "gate.invalidated", { gate: v.name, version: v.version.short });
        this.toast(`FiGr: Freigabe für „${v.name}“ verfallen (neue Version ${v.version.short})`);
        delete gs.passedVersion;
        changed = true;
      }
      if (v.config.evidence && v.status === "passed" && !gs.evidencePassed) {
        gs.evidencePassed = true;
        changed = true;
        this.audit.write(state.sessionID, "gate.passed", { gate: v.name, evidence: true });
      }
    }
    if (changed) {
      this.store.touch(state);
      views = computeGates(profile, state, current);
    }
    return views;
  }

  ensureRound(state: SessionState, gate: string, version: { hash: string; short: string }): Round {
    const gs = this.gateState(state, gate);
    const existing = roundFor(gs, version.hash);
    const approve = this.profile(state).gates[gate]?.approve;
    if (existing) return existing;
    const round = RoundSchema.parse({ index: gs.rounds.length + 1, version: version.hash, short: version.short, reviewers: approve?.reviewers ?? [], verdicts: {}, startedAt: this.ports.clock.now(), ...(approve && approve.checks.length === 0 ? { checks: [] } : {}) });
    gs.rounds.push(round);
    this.audit.write(state.sessionID, "round.started", { gate, version: version.short, round: round.index });
    this.store.touch(state);
    return round;
  }

  async runRoundChecks(state: SessionState, gate: string, round: Round, signal?: AbortSignal): Promise<void> {
    const approve = this.profile(state).gates[gate]?.approve;
    if (!approve || approve.checks.length === 0 || round.checks !== undefined) return;
    const key = `${state.sessionID}|${gate}|${round.version}`;
    const running = this.checkRuns.get(key);
    if (running) return running;
    const p = (async () => {
      const results = await runChecks(approve.checks, this.ports.directory, { timeoutMs: approve.checkTimeout * 1000, ...(signal ? { signal } : {}), onFull: (cmd, out) => this.audit.attach(state.sessionID, `${gate}-${round.short}-${cmd}.log`, out) });
      round.checks = results;
      this.audit.write(state.sessionID, "checks", { gate, version: round.short, results: results.map((r) => ({ command: r.command, ok: r.ok, exitCode: r.exitCode })) });
      this.store.touch(state);
    })().finally(() => this.checkRuns.delete(key));
    this.checkRuns.set(key, p);
    return p;
  }

  async describeArtifact(state: SessionState, view: GateView): Promise<string> {
    const a = view.config.artifact;
    const loc = this.location(state);
    if (a?.type === "file") return `File: ${artifactPath(a, loc)} (read it completely).`;
    if (a?.type === "text") return ["Text submitted by the orchestrator:", "", view.state.text ?? ""].join("\n");
    if (a?.type === "diff") {
      const stat = state.baseCommit ? await diffStat(loc.project, state.baseCommit, [loc.workDirRel, ...a.ignore]).catch(() => "") : "";
      return [`Code changes in ${loc.project} against base commit ${state.baseCommit ?? "?"}.`, "Inspect them with `git diff " + (state.baseCommit ?? "HEAD") + "` and `git status` (untracked files count too).", "", "```", stat || "(no stat)", "```"].join("\n");
    }
    return "(no artifact)";
  }

  // ───────────────────────── Menschliche Entscheidungen ─────────────────────────

  async ask(state: SessionState, title: string, detail: string): Promise<{ approved: boolean; feedback?: string }> {
    try {
      return await this.ports.permission.ask({ sessionID: state.sessionID, title, detail });
    } catch (error) {
      this.ports.log.warn("Nutzerfrage fehlgeschlagen", { error: messageOf(error) });
      return { approved: false };
    }
  }

  async escalate(state: SessionState, view: GateView, reason: string): Promise<{ text: string; passed: boolean } | undefined> {
    const version = view.version;
    if (!version) return undefined;
    const gs = this.gateState(state, view.name);
    if (gs.escalated?.version === version.hash && gs.escalated.answered) return undefined;
    const findings = view.round ? roundFindings(view.round).slice(0, 10) : [];
    const detail = [`Gate „${view.name}“ (${version.short}) nach ${gs.rounds.length} Runde(n) nicht abgenommen: ${reason}.`, ...(findings.length ? ["Offene Befunde:", ...findings.map((f) => `- [${f.severity}] ${f.message}`)] : []), "", "Trotzdem fortfahren (Gate gilt als abgenommen)? Ablehnen mit Text = Anweisung an den Orchestrator."].join("\n");
    gs.escalated = { version: version.hash, reason, answered: false };
    this.audit.write(state.sessionID, "escalation", { gate: view.name, version: version.short, reason });
    this.toast(`FiGr: Eskalation bei „${view.name}“ – ${reason}`);
    const answer = await this.ask(state, `FiGr: Gate „${view.name}“ eskaliert`, detail);
    gs.escalated = { version: version.hash, reason, answered: true };
    if (answer.approved) {
      gs.passedVersion = version.hash;
      if (view.config.approve?.human) gs.humanApproved = version.hash;
      state.overrides.push({ gate: view.name, kind: "escalation", by: "user", at: this.ports.clock.now(), note: reason });
      this.audit.write(state.sessionID, "override", { gate: view.name, kind: "escalation", version: version.short });
      this.store.touch(state);
      const views = await this.views(state);
      return { text: `Nutzer hat Gate „${view.name}“ trotz offener Befunde freigegeben. Nächster Schritt: ${nextStep(views)}`, passed: true };
    }
    this.store.touch(state);
    return {
      text: answer.feedback ? `Eskalation: Nutzer hat nicht freigegeben. Anweisung des Nutzers: ${answer.feedback}` : `Eskalation: Gate „${view.name}“ ${reason}. Der Nutzer hat nicht freigegeben – frage nach, wie es weitergehen soll.`,
      passed: false,
    };
  }

  async humanApproval(state: SessionState, view: GateView): Promise<{ approved: boolean; feedback?: string }> {
    const ev = view.evaluation;
    return this.ask(state, `FiGr: Gate „${view.name}“ freigeben?`, `Die Reviewer haben ${view.version?.short ?? ""} zugestimmt (${ev?.approved ?? 0}/${ev?.required ?? 0}). Freigeben?`);
  }

  // ───────────────────────── Fan-out ─────────────────────────

  startFanout(state: SessionState, kind: FanoutInfo["kind"], gate: string, jobs: readonly FanoutJob[]): FanoutInfo {
    const info: FanoutInfo = { id: `f${++this.fanoutSeq}-${this.ports.clock.now()}`, kind, gate, startedAt: this.ports.clock.now(), jobs: jobs.map((j) => ({ label: j.label, agent: j.agent, status: "pending" })) };
    state.fanouts.push(info);
    this.audit.write(state.sessionID, "fanout.started", { id: info.id, kind, gate, jobs: jobs.map((j) => `${j.label}:${j.agent}`) });
    this.store.touch(state);
    return info;
  }

  endFanout(state: SessionState, fanout: FanoutInfo): void {
    state.fanouts = state.fanouts.filter((f) => f.id !== fanout.id);
    this.judgeRules.delete(fanout.id);
    this.audit.write(state.sessionID, "fanout.finished", { id: fanout.id, jobs: fanout.jobs.map((j) => `${j.label}:${j.status}`) });
    this.store.touch(state);
  }

  fanoutDeps<R>(state: SessionState, fanout: FanoutInfo, extra: (job: FanoutJob) => Partial<Child>, read: (child: Child) => R | undefined): FanoutDeps<R> {
    return {
      sessions: this.ports.sessions,
      register: (job, sessionID) => {
        state.subagentsTotal++;
        this.registerChild(state, { sessionID, agent: job.agent, role: job.role, parentID: state.sessionID, nudges: 0, done: false, fanout: fanout.id, label: job.label, ...extra(job) });
      },
      result: (sessionID) => {
        const child = state.children[sessionID];
        return child ? read(child) : undefined;
      },
      nudge: (sessionID) => {
        const child = state.children[sessionID];
        if (!child || child.nudges >= CHILD_NUDGES) return undefined;
        child.nudges++;
        this.store.touch(state);
        return this.childNudge(child);
      },
      onStatus: (job, status, sessionID) => {
        const j = fanout.jobs.find((x) => x.label === job.label);
        if (j) {
          j.status = status;
          if (sessionID) j.sessionID = sessionID;
        }
        this.store.touch(state);
      },
    };
  }

  setJudgeRule(fanoutID: string, rule: { all: string[]; allowed: string[] }): void {
    this.judgeRules.set(fanoutID, rule);
  }

  private childNudge(child: Child): string {
    return child.role === "reviewer" ? nudgeText("reviewer", TOOL.verdict) : nudgeText(child.role, TOOL.report);
  }

  // ───────────────────────── Hooks ─────────────────────────

  private async decideFor(resolved: Resolved, action: Action): Promise<Decision> {
    const views = await this.views(resolved.state);
    return decide(action, resolved.role, { profile: this.profile(resolved.state), views, state: resolved.state });
  }

  private block(state: SessionState, message: string, extra: Record<string, unknown>): void {
    state.lastBlock = { message, at: this.ports.clock.now() };
    this.audit.write(state.sessionID, "blocked", { message, ...extra });
    this.store.touch(state);
  }

  /** `permission.hook("evaluate")`: harte Sperren für edit und shell (plan.md 10.1). */
  async evaluatePermission(sessionID: string, agent: string | undefined, action: string, resources: readonly string[]): Promise<{ deny?: string }> {
    const resolved = await this.resolve(sessionID, agent);
    if (!resolved || !resolved.state.enabled) return {};
    const actions: Action[] = [];
    if (action === "edit" || action === "write" || action === "patch") actions.push(resources.length > 0 ? { kind: "edit", path: resources[0] ?? "" } : { kind: "edit" });
    else if (action === "shell" || action === "bash") for (const r of resources) actions.push({ kind: "shell", command: r });
    for (const a of actions) {
      const d = await this.decideFor(resolved, a);
      if (!d.allow) {
        this.block(resolved.state, d.message, { via: "evaluate", action, resources: [...resources] });
        return { deny: d.message };
      }
    }
    return {};
  }

  /**
   * `tool.hook("execute.before")`: dieselben Regeln als Rückfall, Erkennung direkter Reviewer und Prompt-Anreicherung (plan.md 10.2).
   * Wirft `FigrError` zum Blockieren; gibt ggf. eine geänderte Eingabe zurück.
   */
  async beforeTool(sessionID: string, agent: string | undefined, tool: string, input: unknown): Promise<{ input?: unknown }> {
    const resolved = await this.resolve(sessionID, agent);
    if (!resolved || !resolved.state.enabled) return {};
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    let action: Action | undefined;
    if (EDIT_TOOLS.has(tool)) action = { kind: "edit" };
    else if (SHELL_TOOLS.has(tool) && typeof i.command === "string") action = { kind: "shell", command: i.command };
    else if (SUBAGENT_TOOLS.has(tool)) {
      const target = typeof i.agent === "string" ? i.agent : typeof i.subagent_type === "string" ? i.subagent_type : undefined;
      if (target) action = { kind: "subagent", agent: target };
    }
    if (!action) return {};
    const d = await this.decideFor(resolved, action);
    if (!d.allow) {
      this.block(resolved.state, d.message, { via: "execute.before", tool });
      throw new FigrError(d.message);
    }
    if (action.kind !== "subagent") return {};

    const state = resolved.state;
    state.subagentsTotal++;
    if (resolved.role.kind === "orchestrator") state.directSubagentsThisTurn++;
    this.store.touch(state);
    const views = await this.views(state);
    const target = action.agent;
    const isPhase = views.some((v) => phaseAgents(v.config).includes(target));
    const reviewing = isPhase ? undefined : reviewTarget(views.filter((v) => v.config.approve?.reviewers.includes(target)));
    if (!reviewing?.version) return {};
    // Direkter Reviewer-Aufruf: Bindung vorbereiten und Prompt anreichern.
    state.pending.push({ agent: target, gate: reviewing.name, version: reviewing.version.hash, at: this.ports.clock.now() });
    this.ensureRound(state, reviewing.name, reviewing.version);
    this.store.touch(state);
    const artifact = await this.describeArtifact(state, reviewing);
    const prompt = typeof i.prompt === "string" ? i.prompt : "";
    return { input: { ...i, prompt: prompt + reviewerAppendix({ gate: reviewing.name, short: reviewing.version.short, artifact }) } };
  }

  /** `tool.hook("execute.after")`: Nachweise und Diff-Cache (plan.md 10.3). */
  async afterTool(sessionID: string, agent: string | undefined, tool: string, input: unknown, ok: boolean, output: string): Promise<void> {
    if (EDIT_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) this.diff.bump();
    if (!SUBAGENT_TOOLS.has(tool)) return;
    this.diff.bump();
    const resolved = await this.resolve(sessionID, agent);
    if (!resolved || !ok) return;
    const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const target = typeof i.agent === "string" ? i.agent : typeof i.subagent_type === "string" ? i.subagent_type : undefined;
    if (!target) return;
    // Hintergrund-Läufe und Fehlschläge zählen nicht als Nachweis.
    if (/state="(running|failed|error|interrupted|cancelled)"/.test(output)) return;
    const state = resolved.state;
    const profile = this.profile(state);
    const childID = /sessionID="?([^"\s>]+)"?/.exec(output)?.[1];
    for (const [name, gate] of Object.entries(profile.gates)) {
      if (!gate.evidence?.subagents?.agents.includes(target)) continue;
      this.gateState(state, name).evidenceRuns.push({ agent: target, at: this.ports.clock.now(), ...(childID ? { sessionID: childID } : {}) });
    }
    this.store.touch(state);
  }

  /** Neue Nutzernachricht: Zähler pro Nachricht zurücksetzen. */
  async onUserPrompt(sessionID: string, text: string): Promise<void> {
    if (text.startsWith("FiGr:") || this.ownMessages.get(sessionID) === text) return;
    const resolved = await this.resolve(sessionID);
    if (!resolved || resolved.role.kind !== "orchestrator") return;
    resolved.state.nudges = 0;
    resolved.state.directSubagentsThisTurn = 0;
    this.store.touch(resolved.state);
  }

  /** `session.hook("context")`: Sichtbarkeit der Tools und Systemblöcke (plan.md 10.4). */
  async context(sessionID: string, agent: string | undefined): Promise<ContextResult> {
    const resolved = await this.resolve(sessionID, agent);
    if (!resolved || !resolved.state.enabled) return { visible: [], inputs: {} };
    const { state, role, child } = resolved;
    const profile = this.profile(state);
    if (role.kind === "orchestrator") {
      const views = await this.views(state);
      const visible: string[] = [TOOL.status, TOOL.review, TOOL.submit];
      const gates = Object.values(profile.gates);
      if (gates.some((g) => g.artifact?.type === "file" && (g.produce?.pattern === "multi-plan" || g.produce?.pattern === "single"))) visible.push(TOOL.plan);
      if (gates.some((g) => g.produce?.pattern === "best-of-n")) visible.push(TOOL.bestOfN);
      return { system: systemBlock({ profileName: this.profileName(state), profile, views, state }), visible, inputs: {} };
    }
    if (!child) return { visible: [], inputs: {} };
    if (child.role === "reviewer") {
      const gate = child.gate ? profile.gates[child.gate] : undefined;
      const views = await this.views(state);
      const view = views.find((v) => v.name === child.gate);
      const short = view?.state.versions.find((v) => v.hash === child.version)?.short ?? "?";
      const artifact = view ? await this.describeArtifact(state, view) : "";
      const lines = [
        `# FiGr review duty`,
        `You review gate "${child.gate ?? "?"}", version ${short}.`,
        artifact,
        ...(gate?.approve?.rubric ? [`Evaluate against: ${gate.approve.rubric}`] : []),
        "Do not modify files. You must finish by calling `figr_verdict` (approved | changes_requested | rejected, summary, findings). Text verdicts do not count.",
      ];
      return { system: lines.join("\n"), visible: [TOOL.verdict], inputs: {} };
    }
    if (isReportRole(child.role)) {
      const schema = REPORT_SCHEMAS[child.role];
      return { system: `# FiGr role: ${child.role}\nFollow the task. You must finish by calling \`figr_report\` with the structured result for your role.`, visible: [TOOL.report], inputs: { [TOOL.report]: toJsonSchema(schema) } };
    }
    return { visible: [], inputs: {} };
  }

  /** `session.hook("experimental.idle")`: Stop-Guard und Nachforderungen (plan.md 7.4, 10.6). Rückgabe = Fortsetzungstext. */
  async idle(sessionID: string, background: readonly { kind: string; sessionID: string }[]): Promise<string | undefined> {
    const resolved = await this.resolve(sessionID);
    if (!resolved || !resolved.state.enabled) return undefined;
    const { state, role, child } = resolved;
    const profile = this.profile(state);
    if (role.kind === "child") {
      if (!child || child.done || (child.role !== "reviewer" && !isReportRole(child.role))) return undefined;
      if (child.nudges < CHILD_NUDGES) {
        child.nudges++;
        this.store.touch(state);
        return this.childNudge(child);
      }
      // Nach allen Nachforderungen: direkter Reviewer gilt als missing (Fan-outs markieren selbst).
      if (child.role === "reviewer" && !child.fanout && child.gate && child.version) {
        const round = roundFor(this.gateState(state, child.gate), child.version);
        if (round && !round.verdicts[child.agent] && !round.missing.includes(child.agent)) round.missing.push(child.agent);
        child.done = true;
        this.store.touch(state);
      }
      return undefined;
    }
    const guard = profile.rules.stopGuard;
    if (!guard.enabled) return undefined;
    if (background.some((b) => b.sessionID === sessionID)) return undefined;
    await this.refreshEvidenceChecks(state);
    const views = await this.views(state);
    if (isComplete(views)) {
      this.writeReport(state, views);
      return undefined;
    }
    if (guard.respectQuestions) {
      const last = await this.ports.sessions.lastAssistant(sessionID).catch(() => undefined);
      if (last && (last.tools.includes("question") || /\?\s*$/.test(last.text.trim()))) return undefined;
    }
    const open = openGates(profile, views);
    const text = `FiGr: Noch nicht fertig. Offen: ${open.map((v) => gateLine(v).replace(/\s+/g, " ").trim()).join("; ")}. Nächster Schritt: ${nextStep(views)}`;
    if (state.nudges < guard.maxNudges) {
      state.nudges++;
      this.audit.write(sessionID, "nudge", { n: state.nudges, open: open.map((v) => v.name) });
      this.store.touch(state);
      this.ownMessages.set(sessionID, text);
      return text;
    }
    if (state.nudges === guard.maxNudges) {
      state.nudges++;
      this.store.touch(state);
      const answer = await this.ask(state, "FiGr: Orchestrator will aufhören", `Offene Gates: ${open.map((v) => v.name).join(", ")}.\nNach ${guard.maxNudges} Erinnerungen meldet der Orchestrator trotzdem fertig.\n\nBeenden zulassen? Ablehnen mit Text = Anweisung an den Orchestrator.`);
      if (!answer.approved && answer.feedback) {
        const t = `FiGr: Anweisung des Nutzers: ${answer.feedback}`;
        this.ownMessages.set(sessionID, t);
        return t;
      }
      this.toast("FiGr: Session endet mit offenen Gates.");
    }
    return undefined;
  }

  // ───────────────────────── Tools ─────────────────────────

  private async requireOrchestrator(sessionID: string, agent: string | undefined): Promise<SessionState> {
    const resolved = await this.resolve(sessionID, agent);
    if (!resolved) throw new FigrError(this.configProblem ?? "Diese Session wird nicht von FiGr geführt.");
    if (resolved.role.kind !== "orchestrator") throw new FigrError("Dieses FiGr-Tool ist nur für den Orchestrator.");
    if (!resolved.state.enabled) throw new FigrError("FiGr ist für diese Session ausgeschaltet (/figr on).");
    return resolved.state;
  }

  async toolStatus(sessionID: string, agent: string | undefined): Promise<string> {
    const state = await this.requireOrchestrator(sessionID, agent);
    await this.refreshEvidenceChecks(state);
    const views = await this.views(state);
    return statusText({ profileName: this.profileName(state), profile: this.profile(state), views, state });
  }

  async toolSubmit(sessionID: string, agent: string | undefined, input: { gate?: unknown; text?: unknown }): Promise<string> {
    const state = await this.requireOrchestrator(sessionID, agent);
    if (typeof input.gate !== "string" || typeof input.text !== "string" || input.text.trim().length === 0) throw new FigrError("figr_submit braucht gate und text.");
    const profile = this.profile(state);
    const gate = profile.gates[input.gate];
    if (!gate) throw new FigrError(`Unbekanntes Gate „${input.gate}“.`);
    const views = await this.views(state);
    const view = views.find((v) => v.name === input.gate);
    if (view?.status === "blocked") throw new FigrError(`Gate „${input.gate}“ ist gesperrt: zuerst ${view.missingRequires.join(", ")}.`);
    const a = gate.artifact;
    if (a?.type === "text") this.gateState(state, input.gate).text = input.text;
    else if (a?.type === "file") {
      const path = artifactPath(a, this.location(state));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, input.text);
    } else throw new FigrError(`Gate „${input.gate}“ nimmt keinen Text an (artifact.type ist ${a?.type ?? "nicht gesetzt"}).`);
    this.store.touch(state);
    const after = await this.views(state);
    const v = after.find((x) => x.name === input.gate);
    return `Eingereicht für „${input.gate}“${v?.version ? ` als Version ${v.version.short}` : ""}. Nächster Schritt: ${nextStep(after)}`;
  }

  async toolVerdict(sessionID: string, agent: string | undefined, raw: unknown): Promise<string> {
    const resolved = await this.resolve(sessionID, agent);
    const child = resolved?.child;
    if (!resolved || !child || child.role !== "reviewer") throw new FigrError("figr_verdict ist nur für Reviewer-Sessions eines FiGr-Gates.");
    const parsed = VerdictInputSchema.safeParse(raw);
    if (!parsed.success) throw new FigrError(`Ungültiges Urteil: ${issuesText(parsed.error)}`);
    const input = parsed.data;
    if (input.verdict === "approved" && input.findings.some((f) => f.severity === "blocker")) throw new FigrError("Widerspruch: approved mit Blocker-Befund. Entweder den Blocker entfernen oder changes_requested/rejected wählen.");
    const { state } = resolved;
    const profile = this.profile(state);
    let gateName = child.gate;
    let version = child.version;
    const views = await this.views(state);
    if (!gateName || !version) {
      const target = reviewTarget(views.filter((v) => v.config.approve?.reviewers.includes(child.agent)));
      if (!target?.version) throw new FigrError("Kein Gate mit prüfbarem Artefakt gefunden.");
      gateName = target.name;
      version = target.version.hash;
      child.gate = gateName;
      child.version = version;
    }
    const gs = this.gateState(state, gateName);
    const short = gs.versions.find((v) => v.hash === version)?.short ?? "?";
    const round = this.ensureRound(state, gateName, { hash: version, short });
    if (!round.reviewers.includes(child.agent)) throw new FigrError(`„${child.agent}“ ist kein Reviewer von Gate „${gateName}“.`);
    round.verdicts[child.agent] = { reviewer: child.agent, verdict: input.verdict, summary: input.summary, findings: input.findings, sessionID, at: this.ports.clock.now() };
    child.done = true;
    const current = views.find((v) => v.name === gateName)?.version?.hash;
    const stale = current !== undefined && current !== version;
    this.audit.write(state.sessionID, stale ? "verdict.stale" : "verdict", { gate: gateName, version: short, reviewer: child.agent, verdict: input.verdict, findings: input.findings.length });
    this.store.touch(state);
    if (!child.fanout && profile.gates[gateName]?.approve?.checks.length) void this.runRoundChecks(state, gateName, round);
    return stale ? `Urteil gespeichert, aber Version ${short} ist veraltet – es zählt nicht für den aktuellen Stand.` : `Urteil „${input.verdict}“ für Gate „${gateName}“ (${short}) gespeichert. Danke – du bist fertig.`;
  }

  async toolReport(sessionID: string, agent: string | undefined, raw: unknown): Promise<string> {
    const resolved = await this.resolve(sessionID, agent);
    const child = resolved?.child;
    if (!resolved || !child || !isReportRole(child.role)) throw new FigrError("figr_report ist nur für Kind-Sessions eines FiGr-Musters (Planer, Synthesizer, Kandidat, Richter).");
    const parsed = REPORT_SCHEMAS[child.role].safeParse(raw);
    if (!parsed.success) throw new FigrError(`Ungültiger Report (${child.role}): ${issuesText(parsed.error)}`);
    const report = parsed.data as Record<string, unknown>;
    if (child.role === "judge" && child.fanout) {
      const rule = this.judgeRules.get(child.fanout);
      const winner = String(report.winner).toUpperCase();
      if (rule && !rule.all.includes(winner)) throw new FigrError(`Unbekannter Kandidat „${winner}“. Wähle aus: ${rule.all.join(", ")}.`);
      if (rule && !rule.allowed.includes(winner)) throw new FigrError(`Kandidat ${winner} hat rote Checks, es gibt aber grüne (${rule.allowed.join(", ")}). Wähle einen grünen Kandidaten.`);
      report.winner = winner;
    }
    if ((child.role === "planner" || child.role === "synthesizer") && typeof report.planPath === "string" && !existsSync(report.planPath)) {
      throw new FigrError(`Die Plan-Datei ${report.planPath} existiert nicht. Schreibe den Plan zuerst dorthin.`);
    }
    child.report = report;
    child.done = true;
    this.audit.write(resolved.state.sessionID, "report", { role: child.role, agent: child.agent, label: child.label ?? null });
    this.store.touch(resolved.state);
    return "Report gespeichert. Du bist fertig.";
  }

  private toolRun(signal: AbortSignal, progress: (m: string) => void): ToolRun {
    return { signal, progress };
  }

  async toolReview(sessionID: string, agent: string | undefined, input: { gate?: unknown; focus?: unknown }, signal: AbortSignal, progress: (m: string) => void): Promise<string> {
    const state = await this.requireOrchestrator(sessionID, agent);
    if (typeof input.gate !== "string") throw new FigrError("figr_review braucht gate.");
    return runReview(this, state, { gate: input.gate, ...(typeof input.focus === "string" ? { focus: input.focus } : {}) }, this.toolRun(signal, progress));
  }

  async toolPlan(sessionID: string, agent: string | undefined, input: { task?: unknown; planners?: unknown; context?: unknown; gate?: unknown }, signal: AbortSignal, progress: (m: string) => void): Promise<string> {
    const state = await this.requireOrchestrator(sessionID, agent);
    if (typeof input.task !== "string" || input.task.trim().length === 0) throw new FigrError("figr_plan braucht task.");
    const planners = Array.isArray(input.planners) ? input.planners.filter((p): p is string => typeof p === "string") : undefined;
    return runPlan(this, state, { task: input.task, ...(planners?.length ? { planners } : {}), ...(typeof input.context === "string" ? { context: input.context } : {}), ...(typeof input.gate === "string" ? { gate: input.gate } : {}) }, this.toolRun(signal, progress));
  }

  async toolBestOfN(sessionID: string, agent: string | undefined, input: { task?: unknown; n?: unknown; agent?: unknown }, signal: AbortSignal, progress: (m: string) => void): Promise<string> {
    const state = await this.requireOrchestrator(sessionID, agent);
    if (typeof input.task !== "string" || input.task.trim().length === 0) throw new FigrError("figr_best_of_n braucht task.");
    return runBestOfN(this, state, { task: input.task, ...(typeof input.n === "number" ? { n: input.n } : {}), ...(typeof input.agent === "string" ? { agent: input.agent } : {}) }, this.toolRun(signal, progress));
  }

  // ───────────────────────── Befehle ─────────────────────────

  /** Slash-Befehle (plan.md 12). Rückgabe = Text, der als Nachricht in der Session erscheint. */
  async command(name: string, sessionID: string, args: string): Promise<string> {
    const arg = args.trim();
    if (!this.config) return `FiGr: ${this.configProblem ?? "nicht konfiguriert"}`;
    switch (name) {
      case "figr": {
        if (arg === "on") {
          const state = await this.guide(sessionID);
          state.enabled = true;
          this.store.touch(state);
          return `FiGr ist für diese Session an (Profil ${this.profileName(state)}).`;
        }
        if (arg === "off") {
          const resolved = await this.resolve(sessionID);
          if (!resolved || resolved.role.kind !== "orchestrator") return "FiGr führt diese Session nicht.";
          resolved.state.enabled = false;
          this.audit.write(sessionID, "override", { kind: "off" });
          this.store.touch(resolved.state);
          return "FiGr ist für diese Session aus. Regeln werden nicht mehr durchgesetzt (/figr on schaltet wieder ein).";
        }
        const resolved = await this.resolve(sessionID);
        if (!resolved) return `FiGr führt diese Session nicht.${this.configProblem ? ` ${this.configProblem}` : ""} (/figr on aktiviert FiGr hier.)`;
        const views = await this.views(resolved.state);
        const reportPath = this.writeReport(resolved.state, views);
        return `${statusText({ profileName: this.profileName(resolved.state), profile: this.profile(resolved.state), views, state: resolved.state })}${reportPath ? `\nBericht: ${reportPath}` : ""}${this.warnings.length ? `\nWarnungen:\n${this.warnings.map((w) => `- ${w}`).join("\n")}` : ""}`;
      }
      case "figr-profile": {
        const resolved = await this.resolve(sessionID);
        if (!resolved || resolved.role.kind !== "orchestrator") return "FiGr führt diese Session nicht.";
        if (!arg) return `Profile: ${Object.keys(this.config.profiles).join(", ")} (aktiv: ${this.profileName(resolved.state)})`;
        if (!this.config.profiles[arg]) return `Unbekanntes Profil „${arg}“. Verfügbar: ${Object.keys(this.config.profiles).join(", ")}.`;
        resolved.state.profile = arg;
        this.audit.write(sessionID, "override", { kind: "profile", profile: arg });
        this.store.touch(resolved.state);
        return `Profil „${arg}“ aktiv.\n${compactStatus(await this.views(resolved.state))}`;
      }
      case "figr-skip":
      case "figr-reset": {
        const resolved = await this.resolve(sessionID);
        if (!resolved || resolved.role.kind !== "orchestrator") return "FiGr führt diese Session nicht.";
        const state = resolved.state;
        const gates = this.profile(state).gates;
        if (!arg || !gates[arg]) return `Gate angeben: ${Object.keys(gates).join(", ")}.`;
        if (name === "figr-skip") {
          const answer = await this.ask(state, `FiGr: Gate „${arg}“ überspringen?`, `Das Gate „${arg}“ gilt danach als erfüllt. Der Override wird protokolliert.`);
          if (!answer.approved) return `Gate „${arg}“ wird nicht übersprungen.`;
          this.gateState(state, arg).skipped = true;
          state.overrides.push({ gate: arg, kind: "skip", by: "user", at: this.ports.clock.now() });
          this.audit.write(sessionID, "override", { gate: arg, kind: "skip" });
          this.store.touch(state);
          return `Gate „${arg}“ übersprungen (protokolliert).\n${compactStatus(await this.views(state))}`;
        }
        state.gates[arg] = emptyGateState();
        state.overrides.push({ gate: arg, kind: "reset", by: "user", at: this.ports.clock.now() });
        this.audit.write(sessionID, "override", { gate: arg, kind: "reset" });
        this.store.touch(state);
        return `Gate „${arg}“ zurückgesetzt.\n${compactStatus(await this.views(state))}`;
      }
      case "figr-findings": {
        const resolved = await this.resolve(sessionID);
        if (!resolved) return "FiGr führt diese Session nicht.";
        const views = await this.views(resolved.state);
        const lines: string[] = [];
        for (const v of views) {
          if (!v.round) continue;
          const f = roundFindings(v.round);
          if (f.length === 0) continue;
          lines.push(`${v.name} ${v.round.short} (Runde ${v.round.index}, ${v.status}):`, ...f.map((x) => `- [${x.severity}] ${x.location ? `${x.location}: ` : ""}${x.message}${x.suggestion ? ` → ${x.suggestion}` : ""} (${x.from.join(", ")})`));
        }
        return lines.length ? lines.join("\n") : "Keine offenen Befunde.";
      }
      default:
        return `Unbekannter Befehl ${name}.`;
    }
  }

  // ───────────────────────── TUI-Schnittstelle, Bericht ─────────────────────────

  toast(message: string): void {
    this.toasts.push({ at: this.ports.clock.now(), message });
    if (this.toasts.length > 20) this.toasts.splice(0, this.toasts.length - 20);
  }

  /** Statusdatei für den TUI-Teil (`workDir/<sid>/status.json`), plan.md 12/S10. */
  private readonly statusTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private writeStatusFile(state: SessionState): void {
    if (!this.config || this.statusTimers.has(state.sessionID)) return;
    const timer = setTimeout(() => {
      this.statusTimers.delete(state.sessionID);
      void this.writeStatusNow(state);
    }, 250);
    timer.unref();
    this.statusTimers.set(state.sessionID, timer);
  }

  async writeStatusNow(state: SessionState): Promise<void> {
    await (async () => {
      try {
        const views = await this.views(state);
        const file = join(this.sessionDir(state.sessionID), "status.json");
        mkdirSync(dirname(file), { recursive: true });
        const snapshot = {
          sessionID: state.sessionID,
          profile: this.profileName(state),
          enabled: state.enabled,
          gates: views.map((v) => ({ name: v.name, status: v.status, line: gateLine(v) })),
          compact: compactStatus(views),
          fanouts: state.fanouts.map((f) => ({ kind: f.kind, gate: f.gate, jobs: f.jobs.map((j) => ({ label: j.label, agent: j.agent, status: j.status })) })),
          lastBlock: state.lastBlock ?? null,
          next: nextStep(views),
          toasts: this.toasts.slice(-10),
          complete: isComplete(views),
          updatedAt: this.ports.clock.now(),
        };
        writeFileSync(file, JSON.stringify(snapshot, null, 2));
      } catch {
        // Anzeige ist optional.
      }
    })();
  }

  writeReport(state: SessionState, views: readonly GateView[]): string | undefined {
    try {
      const file = join(this.sessionDir(state.sessionID), "report.md");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderReport({ profileName: this.profileName(state), views, state }));
      return relativeTo(this.ports.directory, file);
    } catch {
      return undefined;
    }
  }

  /** `evidence.check` für noch nicht erfüllte Nachweis-Gates ausführen (beim Status und beim Stop-Guard). */
  async refreshEvidenceChecks(state: SessionState): Promise<void> {
    for (const [name, gate] of Object.entries(this.profile(state).gates)) {
      const cmd = gate.evidence?.check;
      const gs = this.gateState(state, name);
      if (!cmd || gs.evidencePassed) continue;
      const r = await runCheck(cmd, this.ports.directory);
      gs.evidenceFlags.check = r.ok;
      this.store.touch(state);
    }
  }
}
