import { AiflowError } from "./errors.js";
import { getPath } from "./util.js";

/**
 * Teilmenge von JSON Logic: var, ==, !=, ===, !==, <, <=, >, >=, !, !!, and, or, if, in, some, all, none,
 * count, matches (Regex), severityAtLeast. Kein eval, keine Seiteneffekte.
 */
export type JsonLogic = unknown;

const SEVERITY = ["info", "low", "medium", "high", "critical"];

export function evaluateCondition(rule: JsonLogic, data: unknown): unknown {
  if (rule === null || typeof rule !== "object") return rule;
  if (Array.isArray(rule)) return rule.map((r) => evaluateCondition(r, data));
  const entries = Object.entries(rule as Record<string, unknown>);
  if (entries.length !== 1) throw new AiflowError("VALIDATION", "Eine Bedingung muss genau einen Operator haben.");
  const [op, rawArgs] = entries[0] as [string, unknown];
  const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
  const ev = (i: number): unknown => evaluateCondition(args[i], data);

  switch (op) {
    case "var": {
      const path = ev(0);
      const value = getPath(data, typeof path === "number" ? String(path) : typeof path === "string" ? path : "");
      return value === undefined ? ev(1) : value;
    }
    case "==":
      // eslint-disable-next-line eqeqeq -- JSON-Logic-Semantik
      return ev(0) == ev(1);
    case "!=":
      // eslint-disable-next-line eqeqeq -- JSON-Logic-Semantik
      return ev(0) != ev(1);
    case "===":
      return ev(0) === ev(1);
    case "!==":
      return ev(0) !== ev(1);
    case "<":
      return Number(ev(0)) < Number(ev(1));
    case "<=":
      return Number(ev(0)) <= Number(ev(1));
    case ">":
      return Number(ev(0)) > Number(ev(1));
    case ">=":
      return Number(ev(0)) >= Number(ev(1));
    case "!":
      return !truthy(ev(0));
    case "!!":
      return truthy(ev(0));
    case "and": {
      let last: unknown = true;
      for (let i = 0; i < args.length; i++) {
        last = ev(i);
        if (!truthy(last)) return last;
      }
      return last;
    }
    case "or": {
      let last: unknown = false;
      for (let i = 0; i < args.length; i++) {
        last = ev(i);
        if (truthy(last)) return last;
      }
      return last;
    }
    case "if": {
      for (let i = 0; i + 1 < args.length; i += 2) if (truthy(ev(i))) return ev(i + 1);
      return args.length % 2 === 1 ? ev(args.length - 1) : null;
    }
    case "in": {
      const needle = ev(0);
      const hay = ev(1);
      if (typeof hay === "string") return typeof needle === "string" && hay.includes(needle);
      return Array.isArray(hay) && hay.includes(needle);
    }
    case "count": {
      const list = ev(0);
      return Array.isArray(list) ? list.length : 0;
    }
    case "some":
    case "all":
    case "none": {
      const list = ev(0);
      if (!Array.isArray(list)) return op === "none";
      const results = list.map((item) => truthy(evaluateCondition(args[1], item)));
      if (op === "some") return results.some(Boolean);
      if (op === "all") return results.length > 0 && results.every(Boolean);
      return !results.some(Boolean);
    }
    case "matches": {
      const value = ev(0);
      const pattern = ev(1);
      return typeof value === "string" && typeof pattern === "string" && new RegExp(pattern).test(value);
    }
    case "severityAtLeast": {
      const value = ev(0);
      const min = ev(1);
      return typeof value === "string" && typeof min === "string" && SEVERITY.indexOf(value) >= SEVERITY.indexOf(min) && SEVERITY.includes(value);
    }
    default:
      throw new AiflowError("VALIDATION", `Unbekannter Bedingungs-Operator „${op}“.`);
  }
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** Variablenpfade, die eine Bedingung liest (für die Validierung). */
export function conditionVariables(rule: JsonLogic): string[] {
  if (rule === null || typeof rule !== "object") return [];
  if (Array.isArray(rule)) return rule.flatMap(conditionVariables);
  const result: string[] = [];
  for (const [op, args] of Object.entries(rule as Record<string, unknown>)) {
    if (op === "var") {
      const first = Array.isArray(args) ? args[0] : args;
      if (typeof first === "string") result.push(first);
    } else result.push(...conditionVariables(args));
  }
  return result;
}
