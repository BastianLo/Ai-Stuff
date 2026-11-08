/** Erwartbarer Fehler, dessen Text direkt an das Modell bzw. den Nutzer geht. */
export class FigrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigrError";
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertNever(value: never): never {
  throw new Error(`Unerwarteter Wert: ${JSON.stringify(value)}`);
}
