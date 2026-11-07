import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DocumentStore, DocumentVersion } from "@aiflow/engine";

/** Workflow-Dokumente im Dateisystem: `<base>/runs/<runId>/docs/<name>`, Versionen als JSON daneben. */
export class FsDocumentStore implements DocumentStore {
  constructor(private readonly baseDir: string) {}

  private dir(runId: string): string {
    return join(this.baseDir, "runs", runId, "docs");
  }

  async init(runId: string, documents: { name: string; content: string }[]): Promise<void> {
    mkdirSync(this.dir(runId), { recursive: true });
    for (const d of documents) {
      const path = this.path(runId, d.name);
      if (!existsSync(path)) writeFileSync(path, d.content);
    }
    return Promise.resolve();
  }

  path(runId: string, name: string): string {
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Error(`Ungültiger Dokumentname „${name}“`);
    return join(this.dir(runId), name);
  }

  async read(runId: string, name: string): Promise<string> {
    try {
      return Promise.resolve(readFileSync(this.path(runId, name), "utf8"));
    } catch {
      return Promise.resolve("");
    }
  }

  async write(runId: string, name: string, content: string): Promise<void> {
    mkdirSync(this.dir(runId), { recursive: true });
    writeFileSync(this.path(runId, name), content);
    return Promise.resolve();
  }

  private versionFile(runId: string, name: string): string {
    return join(this.baseDir, "runs", runId, "doc-versions", `${name}.json`);
  }

  async recordVersion(runId: string, name: string, version: DocumentVersion): Promise<void> {
    const file = this.versionFile(runId, name);
    mkdirSync(join(this.baseDir, "runs", runId, "doc-versions"), { recursive: true });
    const list = await this.versions(runId, name);
    list.push(version);
    writeFileSync(file, JSON.stringify(list));
  }

  async versions(runId: string, name: string): Promise<DocumentVersion[]> {
    try {
      return Promise.resolve(JSON.parse(readFileSync(this.versionFile(runId, name), "utf8")) as DocumentVersion[]);
    } catch {
      return Promise.resolve([]);
    }
  }
}
