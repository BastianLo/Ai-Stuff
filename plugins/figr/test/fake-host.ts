import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config/load.ts";
import type { AgentInfo } from "../src/config/validate.ts";
import { Figr } from "../src/figr.ts";
import type { HostPorts, SessionInfo } from "../src/host/ports.ts";

export interface ChildContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly prompt: string;
  readonly directory: string;
  readonly figr: Figr;
  /** Wie viele Prompts diese Session bereits bekommen hat (1 = erster). */
  readonly turn: number;
}

export type Behavior = (c: ChildContext) => Promise<void> | void;

export const AGENTS: AgentInfo[] = [
  { id: "orchestrator", mode: "primary" },
  { id: "build", mode: "primary" },
  { id: "explore", mode: "subagent" },
  { id: "planner", mode: "subagent" },
  { id: "planner-a", mode: "subagent" },
  { id: "planner-b", mode: "subagent" },
  { id: "plan-synthesizer", mode: "subagent" },
  { id: "implementer", mode: "subagent" },
  { id: "code-judge", mode: "subagent" },
  { id: "architect-reviewer", mode: "subagent", permissions: [{ action: "edit", resource: "*", effect: "deny" }] },
  { id: "security-reviewer", mode: "subagent" },
  { id: "standards-reviewer", mode: "subagent" },
];

/** Konfiguration ähnlich plan.md 6.2, aber klein genug für Tests. */
export function testConfigRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    defaultProfile: "strict",
    orchestrators: ["orchestrator"],
    profiles: {
      strict: {
        gates: {
          research: { evidence: { subagents: { agents: ["explore"], min: 1 } } },
          plan: {
            requires: ["research"],
            artifact: { type: "file", path: "plan.md" },
            produce: { pattern: "multi-plan", planners: ["planner-a", "planner-b"], synthesizer: "plan-synthesizer" },
            agents: ["planner"],
            approve: { reviewers: ["architect-reviewer", "security-reviewer"], quorum: "all", veto: true, maxRounds: 3 },
          },
          implementation: {
            requires: ["plan"],
            artifact: { type: "diff" },
            produce: { pattern: "best-of-n", agent: "implementer", n: 2, judge: "code-judge", checks: [] },
            agents: ["implementer"],
            approve: { reviewers: ["standards-reviewer"], quorum: 1 },
          },
          done: { requires: ["implementation"], final: true },
        },
        rules: { stopGuard: { enabled: true, maxNudges: 2 } },
      },
      quick: {
        extends: "strict",
        gates: { plan: { produce: { pattern: "single", agent: "planner" }, approve: { reviewers: ["architect-reviewer"], quorum: 1 } } },
      },
    },
    ...overrides,
  };
}

export function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "figr-test-"));
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  writeFileSync(join(dir, "app.js"), "export const x = 1;\n");
  writeFileSync(join(dir, ".gitignore"), ".opencode/figr/\n");
  run("add", "-A");
  run("commit", "-q", "-m", "init");
  return dir;
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
}

/** In-Memory-Host: simulierte Kind-Sessions führen pro Agent ein Skript aus. */
export class FakeHost {
  readonly storage = new Map<string, unknown>();
  readonly sessions = new Map<string, SessionInfo & { prompts: string[] }>();
  readonly synthetic: { sessionID: string; text: string }[] = [];
  readonly asked: { title: string; detail: string }[] = [];
  readonly behaviors = new Map<string, Behavior>();
  answer: (q: { title: string; detail: string }) => { approved: boolean; feedback?: string } = () => ({ approved: true });
  lastAssistant: { text: string; tools: string[] } | undefined;
  now = 1_000_000;
  private seq = 0;
  figr!: Figr;
  readonly ports: HostPorts;

  constructor(readonly directory: string) {
    this.ports = {
      directory,
      clock: { now: () => ++this.now },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      storage: { get: async (k) => structuredClone(this.storage.get(k)), set: async (k, v) => void this.storage.set(k, structuredClone(v)) },
      agents: { list: async () => AGENTS },
      permission: {
        ask: async (q) => {
          this.asked.push({ title: q.title, detail: q.detail });
          return this.answer(q);
        },
      },
      sessions: {
        create: async ({ parentID, agent, directory: dir }) => {
          const id = `child-${++this.seq}`;
          this.sessions.set(id, { id, parentID, agent, directory: dir ?? directory, prompts: [] });
          await this.figr.onSessionCreated(id, parentID, agent);
          return id;
        },
        prompt: async (sessionID, text) => {
          const s = this.sessions.get(sessionID);
          if (!s) throw new Error(`unknown session ${sessionID}`);
          s.prompts.push(text);
          const behavior = s.agent ? this.behaviors.get(s.agent) : undefined;
          await behavior?.({ sessionID, agent: s.agent ?? "", prompt: text, directory: s.directory, figr: this.figr, turn: s.prompts.length });
        },
        wait: async () => undefined,
        interrupt: async () => undefined,
        get: async (sessionID) => {
          const s = this.sessions.get(sessionID);
          if (!s) throw new Error(`unknown session ${sessionID}`);
          return s;
        },
        synthetic: async (sessionID, text) => void this.synthetic.push({ sessionID, text }),
        lastAssistant: async () => this.lastAssistant,
      },
    };
  }

  /** Root-Session anlegen (z. B. Orchestrator). */
  root(agent = "orchestrator", id = `root-${++this.seq}`): string {
    this.sessions.set(id, { id, agent, directory: this.directory, prompts: [] });
    return id;
  }

  /** Direkter `subagent`-Aufruf wie durch opencodes Tool: before-Hook, Kind-Session, Skript, after-Hook. */
  async subagent(parentID: string, agent: string, prompt = "do it"): Promise<{ sessionID?: string; error?: string; prompt?: string }> {
    const input = { agent, description: agent, prompt };
    let finalInput: unknown = input;
    try {
      const r = await this.figr.beforeTool(parentID, this.sessions.get(parentID)?.agent, "subagent", input);
      if (r.input !== undefined) finalInput = r.input;
    } catch (error) {
      return { error: (error as Error).message };
    }
    const id = await this.ports.sessions.create({ parentID, agent, title: agent });
    await this.ports.sessions.prompt(id, (finalInput as { prompt: string }).prompt);
    await this.figr.afterTool(parentID, this.sessions.get(parentID)?.agent, "subagent", finalInput, true, `<subagent sessionID="${id}" state="completed">ok</subagent>`);
    return { sessionID: id, prompt: (finalInput as { prompt: string }).prompt };
  }

  static async create(directory: string, raw: Record<string, unknown> = testConfigRaw()): Promise<FakeHost> {
    const host = new FakeHost(directory);
    host.figr = new Figr(host.ports, { inlineConfig: resolveConfig(raw), watch: false });
    await host.figr.start();
    return host;
  }
}

export const signal = (): AbortSignal => new AbortController().signal;
export const noProgress = (): void => undefined;
