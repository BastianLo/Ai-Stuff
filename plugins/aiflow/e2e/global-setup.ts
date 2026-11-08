import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, ROOT, stateFile } from "./env";

/** Startet den Daemon (Simulations-Runtime) mit frischem Demo-Projekt. */
export default async function globalSetup(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const { createDemoProject } = (await import(join(repo, "packages/testkit/dist/index.js"))) as { createDemoProject: (t?: string) => string };
  const project = createDemoProject(join(ROOT, "shop"));
  const env = { ...process.env, AIFLOW_CONFIG_DIR: join(ROOT, "config"), AIFLOW_DATA_DIR: join(ROOT, "data") };
  const child = spawn(process.execPath, [join(repo, "packages/cli/dist/index.js"), "serve", "--runtime", "simulation", "--simulation-speed", "0.15", "--port", "5788"], { env, stdio: "ignore", detached: true });
  child.unref();
  for (let i = 0; i < 100; i++) {
    try {
      const token = readFileSync(join(ROOT, "config", "auth-token"), "utf8").trim();
      const res = await fetch(`${BASE}/api/health`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        await fetch(`${BASE}/api/projects`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path: project }) });
        writeFileSync(stateFile, JSON.stringify({ project, token, pid: child.pid }));
        return;
      }
    } catch {
      /* noch nicht bereit */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Daemon für E2E startet nicht");
}
