import { AiflowError } from "./errors.js";
import { getPath } from "./util.js";

const TOKEN = /\{\{\s*([a-zA-Z0-9_.\-]+)\s*\}\}/g;

/** Alle Variablenpfade in einem Template. */
export function templateVariables(template: string): string[] {
  return [...template.matchAll(TOKEN)].map((m) => m[1] ?? "");
}

export interface RenderOptions {
  /** Unbekannte Variablen werfen einen Fehler (Standard) oder werden leer ersetzt. */
  strict?: boolean;
}

/** Logikfreies Rendering: `{{pfad.zum.wert}}`. Objekte werden als JSON eingefügt. */
export function renderTemplate(template: string, vars: Record<string, unknown>, options: RenderOptions = {}): string {
  const strict = options.strict ?? true;
  return template.replace(TOKEN, (_match, path: string) => {
    const value = getPath(vars, path);
    if (value === undefined || value === null) {
      if (strict) throw new AiflowError("TEMPLATE", `Unbekannte Template-Variable „${path}“.`);
      return "";
    }
    return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value, null, 2);
  });
}

/** Präfixe, die in Workflow-Templates erlaubt sind (für die statische Prüfung). */
export const TEMPLATE_ROOTS = ["input", "vars", "run", "node", "script", "join", "docs", "workspace", "edge", "loop", "item", "index"] as const;

export function unknownTemplateRoots(template: string, extraRoots: readonly string[] = []): string[] {
  const roots = new Set<string>([...TEMPLATE_ROOTS, ...extraRoots]);
  return templateVariables(template).filter((v) => !roots.has(v.split(".")[0] ?? ""));
}
