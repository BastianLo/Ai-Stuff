import type { JsonSchema } from "@aiflow/core";

export interface ToolSpec {
  name: string;
  description: string;
  input: JsonSchema;
}

export const HANDOFF_TOOL: ToolSpec = {
  name: "aiflow_handoff",
  description: "AiFlow: Übergabe dieses Schritts abschließen. Nur aufrufen, wenn AiFlow dich dazu auffordert.",
  input: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
};

export const DELEGATE_TOOL: ToolSpec = {
  name: "aiflow_delegate",
  description:
    "AiFlow: Startet eine Welle von Teilaufgaben bei Sub-Agenten und liefert alle Ergebnisse gesammelt zurück. Jede Teilaufgabe nennt einen erlaubten Agenten und einen präzisen Auftrag.",
  input: {
    type: "object",
    required: ["tasks"],
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["agent", "task"],
          properties: { agent: { type: "string" }, task: { type: "string" }, expectedResult: { type: "string" } },
        },
      },
    },
  },
};

export const PROGRESS_TOOL: ToolSpec = {
  name: "aiflow_progress",
  description: "AiFlow: Kurze Statusmeldung für den Nutzer, z. B. „schreibe Tests für AuthService“.",
  input: { type: "object", required: ["message"], properties: { message: { type: "string" } } },
};

export const CONTEXT_TOOL: ToolSpec = {
  name: "aiflow_context",
  description: "AiFlow: Abschnitte des Auftrags und der Übergaben nachschlagen (Suchbegriff, leer = alles).",
  input: { type: "object", properties: { query: { type: "string" } } },
};

export const ASK_TOOL: ToolSpec = {
  name: "aiflow_ask",
  description:
    "Stellt dem Nutzer eine Frage und wartet auf die Antwort (wie das question-Tool). Nur für Entscheidungen, die du nicht selbst treffen kannst. Gib sinnvolle Antwortoptionen an; der Nutzer kann auch frei antworten.",
  input: {
    type: "object",
    required: ["question"],
    properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
  },
};

export const LIST_WORKFLOWS_TOOL: ToolSpec = {
  name: "aiflow_list_workflows",
  description: "Listet die AiFlow-Workflows dieses Projekts.",
  input: { type: "object", properties: {} },
};

export const RUN_TOOL: ToolSpec = {
  name: "aiflow_run",
  description: "Startet einen AiFlow-Workflow mit einem Auftrag. Den Auftrag des Nutzers unverändert übernehmen.",
  input: { type: "object", required: ["workflow", "prompt"], properties: { workflow: { type: "string" }, prompt: { type: "string" } } },
};

export const WORKER_TOOL_NAMES = [HANDOFF_TOOL.name, DELEGATE_TOOL.name, PROGRESS_TOOL.name, CONTEXT_TOOL.name, ASK_TOOL.name];

/**
 * Welche AiFlow-Tools eine Session sieht. Kind-Sessions nativer Sub-Agenten dürfen fragen und Fortschritt melden,
 * aber weder übergeben noch delegieren – das gehört dem Schritt.
 */
export function visibleWorkerTools(info: { subSession: boolean; questions: boolean; delegation?: unknown } | null): Set<string> {
  if (!info) return new Set();
  const names = new Set<string>([PROGRESS_TOOL.name]);
  if (info.questions) names.add(ASK_TOOL.name);
  if (!info.subSession) {
    names.add(HANDOFF_TOOL.name);
    names.add(CONTEXT_TOOL.name);
    if (info.delegation) names.add(DELEGATE_TOOL.name);
  }
  return names;
}

/** Schema des Delegations-Tools mit den erlaubten Agenten als enum. */
export function delegateSchema(allowed: string[]): JsonSchema {
  return {
    ...DELEGATE_TOOL.input,
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        items: { type: "object", required: ["agent", "task"], properties: { agent: { enum: allowed }, task: { type: "string" }, expectedResult: { type: "string" } } },
      },
    },
  };
}
