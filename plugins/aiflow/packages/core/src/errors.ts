export type AiflowErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "TEMPLATE"
  | "RUNTIME"
  | "WORKSPACE"
  | "LIMIT"
  | "CANCELLED"
  | "TIMEOUT"
  | "FORBIDDEN";

/** Erwartbarer Fehler mit stabilem Code. Meldungen sollen sagen, was zu tun ist. */
export class AiflowError extends Error {
  constructor(
    readonly code: AiflowErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AiflowError";
  }
}

export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unerwarteter ${context}: ${JSON.stringify(value)}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
