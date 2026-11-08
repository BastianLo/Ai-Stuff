import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OpencodeWorker } from "@aiflow/runtime-opencode";

const root = mkdtempSync(join(tmpdir(), "aiflow-worker-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Fake-`opencode`: meldet eine Version, startet bei `serve` einen HTTP-Server und hält die Umgebung fest. */
function fakeOpencode(version: string): { binary: string; envFile: string } {
  const binary = join(root, `opencode-${version}`);
  const envFile = join(root, `env-${version}.json`);
  writeFileSync(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("${version}"); process.exit(0); }
require("node:fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ OPENCODE_CONFIG: process.env.OPENCODE_CONFIG ?? null, AIFLOW_WORKER: process.env.AIFLOW_WORKER }));
const port = Number(args[args.indexOf("--port") + 1]);
require("node:http").createServer((_, res) => res.end("ok")).listen(port, "127.0.0.1");
`,
  );
  chmodSync(binary, 0o755);
  return { binary, envFile };
}

describe("opencode-Worker", () => {
  it.each(["1.19.5", "2.2.6"])("übergibt die konfigurierte opencode-Konfiguration als OPENCODE_CONFIG (v%s)", async (version) => {
    const { binary, envFile } = fakeOpencode(version);
    const configFile = join(root, "opencode.jsonc");
    writeFileSync(configFile, "{ /* mcp */ }");
    const worker = new OpencodeWorker({ binary, daemonUrl: "http://127.0.0.1:1", workerToken: "t", configFile });
    try {
      const info = await worker.start();
      expect(info.api).toBe(version.startsWith("2") ? "v2" : "v1");
      expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({ OPENCODE_CONFIG: configFile, AIFLOW_WORKER: "1" });
    } finally {
      worker.stop();
    }
  });

  it("startet nicht mit fehlender Konfigurationsdatei", async () => {
    const { binary } = fakeOpencode("1.19.6");
    const worker = new OpencodeWorker({ binary, daemonUrl: "http://127.0.0.1:1", workerToken: "t", configFile: join(root, "fehlt.json") });
    await expect(worker.start()).rejects.toThrow(/opencode-Konfiguration nicht gefunden/);
  });
});
