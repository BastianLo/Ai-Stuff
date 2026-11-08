/** Glob-ähnliches Muster wie in opencode-Rechten: `*` beliebig viele Zeichen, `?` genau eins. */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(value);
}

export function matchesAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchesPattern(p, value));
}
