import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export interface ProjectRecord {
  path: string;
  name: string;
  lastUsed: number;
}

/** Bekannte Projekte (per Pfad registriert, z. B. durch die Bridge oder die CLI). */
export class ProjectRegistry {
  private readonly file: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "projects.json");
  }

  list(): ProjectRecord[] {
    if (!existsSync(this.file)) return [];
    return (JSON.parse(readFileSync(this.file, "utf8")) as ProjectRecord[]).sort((a, b) => b.lastUsed - a.lastUsed);
  }

  touch(path: string): ProjectRecord {
    const abs = resolve(path);
    const list = this.list().filter((p) => p.path !== abs);
    const record = { path: abs, name: basename(abs), lastUsed: Date.now() };
    writeFileSync(this.file, JSON.stringify([record, ...list], null, 2));
    return record;
  }
}
