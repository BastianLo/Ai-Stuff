import { AiflowError } from "./errors.js";

export interface Clock {
  now(): number;
}
export interface IdGenerator {
  next(prefix: string): string;
}

export const systemClock: Clock = { now: () => Date.now() };

export function randomIds(): IdGenerator {
  return { next: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}` };
}

/** Deterministische IDs für Tests: `prefix_1`, `prefix_2`, … */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${n}`;
    },
  };
}

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/;

/** Wandelt „15m“, „3h“, „90s“ oder eine Zahl (ms) in Millisekunden um. */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return value;
  const match = DURATION.exec(value.trim());
  if (!match) throw new AiflowError("VALIDATION", `Ungültige Dauer „${value}“. Erlaubt: z. B. 500ms, 30s, 15m, 2h.`);
  const amount = Number(match[1]);
  const unit = match[2];
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(amount * factor);
}

/** Liest einen Wert über einen Punkt-Pfad (`a.b.0.c`). */
export function getPath(source: unknown, path: string): unknown {
  if (path === "") return source;
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 30) / 2);
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} Zeichen gekürzt] …\n${text.slice(-half)}`;
}
