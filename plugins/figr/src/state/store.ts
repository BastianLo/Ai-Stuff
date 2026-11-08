import { SessionStateSchema, STATE_VERSION, type SessionState } from "../core/types.ts";
import type { Logger, StoragePort } from "../host/ports.ts";

const key = (sessionID: string): string => `figr/session/${sessionID}`;

/** Migration älterer Zustände. Bisher nur Version 1; unbekannte Versionen werden verworfen. */
export function migrate(raw: unknown): SessionState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const version = (raw as { stateVersion?: unknown }).stateVersion;
  if (version !== STATE_VERSION) return undefined;
  const parsed = SessionStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Zustand pro geführter Session in `ctx.storage` (plan.md 13). Schreibt debounced (200 ms), `flush()` sofort.
 * Nach dem Laden gelten laufende Fan-outs als abgebrochen; ihre Runden bleiben offen.
 */
export class StateStore {
  private readonly cache = new Map<string, SessionState>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners: ((s: SessionState) => void)[] = [];

  constructor(
    private readonly storage: StoragePort,
    private readonly log: Logger,
    private readonly debounceMs = 200,
  ) {}

  onChange(fn: (s: SessionState) => void): void {
    this.listeners.push(fn);
  }

  peek(sessionID: string): SessionState | undefined {
    return this.cache.get(sessionID);
  }

  async load(sessionID: string): Promise<SessionState | undefined> {
    const cached = this.cache.get(sessionID);
    if (cached) return cached;
    let raw: unknown;
    try {
      raw = await this.storage.get(key(sessionID));
    } catch (error) {
      this.log.warn("Zustand nicht lesbar", { sessionID, error: String(error) });
      return undefined;
    }
    if (raw === undefined) return undefined;
    const state = migrate(raw);
    if (!state) {
      this.log.warn("Zustand verworfen (unbekannte Version oder ungültig)", { sessionID });
      return undefined;
    }
    // Wiederaufnahme: laufende Fan-outs sind mit dem Prozess beendet.
    if (state.fanouts.length > 0) {
      for (const gate of Object.values(state.gates)) for (const r of gate.rounds) if (state.fanouts.some((f) => f.kind === "review")) r.interrupted = true;
      state.fanouts = [];
    }
    this.cache.set(sessionID, state);
    return state;
  }

  /** Legt den Zustand an bzw. ersetzt ihn. */
  put(state: SessionState): void {
    this.cache.set(state.sessionID, state);
    this.touch(state);
  }

  /** Markiert als geändert und speichert verzögert. */
  touch(state: SessionState): void {
    this.dirty.add(state.sessionID);
    for (const l of this.listeners) l(state);
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const ids = [...this.dirty];
    this.dirty.clear();
    await Promise.all(
      ids.map(async (id) => {
        const s = this.cache.get(id);
        if (!s) return;
        try {
          await this.storage.set(key(id), JSON.parse(JSON.stringify(s)) as unknown);
        } catch (error) {
          this.log.error("Zustand nicht gespeichert", { sessionID: id, error: String(error) });
        }
      }),
    );
  }
}
