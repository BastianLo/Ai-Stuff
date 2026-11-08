import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ArtifactConfig } from "../config/schema.ts";
import { fullDiff, isRepo } from "../workspace/git.ts";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Normalisiert Zeilenenden, damit CRLF/LF keine neue Version erzeugen. */
export const normalizeText = (text: string): string => text.replace(/\r\n?/g, "\n");

export interface ArtifactLocation {
  /** Projektverzeichnis. */
  readonly project: string;
  /** workDir/<sid> (absolut). */
  readonly sessionDir: string;
  /** workDir relativ zum Projekt (für Diff-Ausschluss). */
  readonly workDirRel: string;
}

/** Absoluter Pfad eines Datei-Artefakts (plan.md 8). */
export function artifactPath(artifact: Extract<ArtifactConfig, { type: "file" }>, loc: ArtifactLocation): string {
  if (isAbsolute(artifact.path)) return artifact.path;
  return resolve(artifact.root === "project" ? loc.project : loc.sessionDir, artifact.path);
}

export function fileVersion(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return undefined;
  return sha256(normalizeText(text));
}

export function textVersion(text: string | undefined): string | undefined {
  return text && text.trim().length > 0 ? sha256(normalizeText(text)) : undefined;
}

/**
 * Version des Code-Stands: SHA-256 über `git diff --binary <base>` inkl. untracked Dateien.
 * Pfade aus workDir und `artifact.ignore` sind ausgeschlossen. Leerer Diff = kein Artefakt.
 */
export async function diffVersion(loc: ArtifactLocation, base: string | undefined, ignore: readonly string[]): Promise<string | undefined> {
  if (!base || !(await isRepo(loc.project))) return undefined;
  const patch = await fullDiff(loc.project, base, [loc.workDirRel, ...ignore]);
  return patch.trim().length === 0 ? undefined : sha256(patch);
}

/** Cache für Diff-Versionen: gültig, solange sich der Änderungszähler (edit/write/patch/shell) nicht ändert. */
export class DiffCache {
  private entry: { epoch: number; key: string; value: string | undefined } | undefined;
  epoch = 0;

  bump(): void {
    this.epoch++;
  }

  async get(key: string, compute: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.entry && this.entry.epoch === this.epoch && this.entry.key === key) return this.entry.value;
    const value = await compute();
    this.entry = { epoch: this.epoch, key, value };
    return value;
  }
}

export function relativeTo(project: string, path: string): string {
  const rel = relative(project, path);
  return rel.startsWith("..") ? path : rel;
}
