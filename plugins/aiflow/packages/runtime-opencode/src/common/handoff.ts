import type { JsonSchema } from "@aiflow/core";

export function finalizePrompt(schema: JsonSchema, mode: "format" | "tool"): string {
  const how =
    mode === "tool"
      ? "Rufe jetzt genau einmal das Tool `aiflow_handoff` auf. Seine Eingabe ist deine Übergabe."
      : "Antworte jetzt ausschließlich mit deiner Übergabe als JSON-Objekt.";
  return [
    "Deine Arbeit in diesem Schritt ist abgeschlossen. Erstelle jetzt die strukturierte Übergabe.",
    how,
    "Fasse in `summary` knapp zusammen, was du getan bzw. entschieden hast. Halte dich an das Schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

/** Fallback: sucht das letzte JSON-Objekt in einem Text (Codeblock bevorzugt). */
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const candidate of [...blocks.reverse(), text]) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* nächster Kandidat */
    }
  }
  return undefined;
}
