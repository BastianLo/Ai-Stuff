import type { AgentInfo } from "../config/validate.ts";

/**
 * Schmale Schnittstellen zum Host (plan.md 14.3). Nur `host/v2.ts` kennt `@opencode/plugin`;
 * alles andere spricht über diese Ports und lässt sich mit einem In-Memory-FakeHost testen.
 */
export interface SessionInfo {
  readonly id: string;
  readonly parentID?: string;
  readonly agent?: string;
  readonly directory: string;
}

export interface SessionPort {
  create(o: { parentID: string; agent: string; title: string; directory?: string }): Promise<string>;
  prompt(sessionID: string, text: string): Promise<void>;
  /** Wartet, bis die Session idle ist. */
  wait(sessionID: string, signal: AbortSignal): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  get(sessionID: string): Promise<SessionInfo>;
  /** Nachricht ohne Nutzer, z. B. Statusausgaben von Befehlen (`resume: false`) oder Fortsetzungen (`resume: true`). */
  synthetic(sessionID: string, text: string, opts?: { resume?: boolean }): Promise<void>;
  /** Letzte Antwort des Modells (Text und aufgerufene Tools), für die Fragen-Heuristik des Stop-Guards. */
  lastAssistant(sessionID: string): Promise<{ text: string; tools: string[] } | undefined>;
}

export interface PermissionPort {
  /** Zeigt den nativen Freigabedialog und wartet. `feedback` = Freitext bei Ablehnung. */
  ask(o: { sessionID: string; title: string; detail: string }): Promise<{ approved: boolean; feedback?: string }>;
}

export interface StoragePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface AgentPort {
  list(): Promise<AgentInfo[]>;
}

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface Clock {
  now(): number;
}

export interface HostPorts {
  readonly sessions: SessionPort;
  readonly permission: PermissionPort;
  readonly storage: StoragePort;
  readonly agents: AgentPort;
  readonly log: Logger;
  readonly clock: Clock;
  /** Projektverzeichnis (Arbeitskopie). */
  readonly directory: string;
}

export const consoleLogger: Logger = {
  info: () => undefined,
  warn: (m, e) => console.warn(`[figr] ${m}`, e ?? ""),
  error: (m, e) => console.error(`[figr] ${m}`, e ?? ""),
};

export const systemClock: Clock = { now: () => Date.now() };
