import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { configSources, loadConfig } from "../config/load.ts";

/** Inhalt von `workDir/<sid>/status.json`, den der Server-Teil schreibt (plan.md 12, Spike S10 Plan B). */
export const StatusSnapshotSchema = z.object({
  sessionID: z.string(),
  profile: z.string(),
  enabled: z.boolean(),
  gates: z.array(z.object({ name: z.string(), status: z.string(), line: z.string() })),
  compact: z.string(),
  fanouts: z.array(z.object({ kind: z.string(), gate: z.string(), jobs: z.array(z.object({ label: z.string(), agent: z.string(), status: z.string() })) })),
  lastBlock: z.object({ message: z.string(), at: z.number() }).nullable(),
  next: z.string(),
  toasts: z.array(z.object({ at: z.number(), message: z.string() })),
  complete: z.boolean(),
  updatedAt: z.number(),
});
export type StatusSnapshot = z.infer<typeof StatusSnapshotSchema>;

/** workDir aus der Konfiguration (Standard `.opencode/figr`). */
export function resolveWorkDir(projectDir: string, options: { config?: string; global?: boolean } = {}): string {
  let workDir = ".opencode/figr";
  try {
    workDir = loadConfig(configSources(projectDir, options))?.workDir ?? workDir;
  } catch {
    // Ungültige Konfiguration: Standardpfad.
  }
  return isAbsolute(workDir) ? workDir : resolve(projectDir, workDir);
}

export function readStatus(workDir: string, sessionID: string): StatusSnapshot | undefined {
  const file = join(workDir, sessionID.replace(/[^\w.-]/g, "_"), "status.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = StatusSnapshotSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Zeilen für die Seitenleiste. */
export function sidebarLines(s: StatusSnapshot): string[] {
  const lines = [`FiGr · ${s.profile}${s.enabled ? "" : " (aus)"}`, ...s.gates.map((g) => g.line.replace(/\s{2,}/g, " "))];
  for (const f of s.fanouts) lines.push(`… ${f.kind} ${f.gate}: ${f.jobs.map((j) => `${j.label} ${j.status}`).join(", ")}`);
  if (s.lastBlock) lines.push(`⨯ ${s.lastBlock.message.replace(/^FiGr:\s*/, "").slice(0, 90)}`);
  return lines;
}
