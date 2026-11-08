import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export class JsoncError extends Error {}

/** Parst JSONC (Kommentare, abschließende Kommas) und wirft bei Syntaxfehlern mit Zeilenangabe. */
export function parseJsonc(text: string, file: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first) {
    const line = text.slice(0, first.offset).split("\n").length;
    throw new JsoncError(`${file}:${line}: ${printParseErrorCode(first.error)}`);
  }
  return value;
}
