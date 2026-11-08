#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { AiflowClient, ApiError, type RunView } from "@aiflow/client";
import { TERMINAL_RUN_STATUSES } from "@aiflow/core";
import { ensureToken, examplesDir, readSettings, resolvePaths, settingsSchema, startDaemon, type AiflowPaths, type AiflowSettings } from "@aiflow/server";

let resolved: AiflowPaths | undefined;
/** Verzeichnisse nach globalen Optionen, Umgebung und `config.json` (erst nach dem Parsen der Optionen gültig). */
function paths(): AiflowPaths {
  if (resolved) return resolved;
  const o = program.opts<{ dataDir?: string; opencodeConfig?: string }>();
  try {
    resolved = resolvePaths({ dataDir: o.dataDir, opencodeConfig: o.opencodeConfig });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return resolved;
}
const DEFAULT_PORT = 5739;

function client(port: number): AiflowClient {
  return new AiflowClient({ baseUrl: `http://127.0.0.1:${port}`, token: ensureToken(paths().config) });
}

function fail(message: string): never {
  process.stderr.write(`✖ ${message}\n`);
  process.exit(1);
}

async function guard<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError) fail(`${error.message} (${error.code})`);
    if (error instanceof Error && /fetch failed|ECONNREFUSED/.test(error.message + String(error.cause))) fail("AiFlow-Daemon läuft nicht. Starte ihn mit `aiflow serve --detach`.");
    throw error;
  }
}

const program = new Command().name("aiflow").description("AiFlow – feste Umsetzungs-Workflows aus KI-Agenten").version("0.1.0");
program.option("-p, --port <port>", "Port des Daemons", (v) => Number(v), DEFAULT_PORT);
program.option("--data-dir <dir>", "Datenverzeichnis (Datenbank, Worktrees, Dokumente, Logs)");
program.option("--opencode-config <file>", "opencode-Konfigurationsdatei für die Agenten (z. B. ~/.config/opencode.jsonc)");
const port = (): number => program.opts<{ port: number }>().port;

program
  .command("serve")
  .description("Daemon starten")
  .option("--detach", "im Hintergrund starten")
  .option("--runtime <runtime>", "opencode | simulation", "opencode")
  .option("--opencode <binary>", "Pfad zum opencode-Binary")
  .option("--api <api>", "opencode-API: auto | v1 | v2", "auto")
  .option("--simulation-speed <factor>", "Geschwindigkeit der Simulation (1 = realistisch)", (v) => Number(v), 1)
  .option("--no-seed", "keine Beispiel-Definitionen übernehmen")
  .action(async (opts: { detach?: boolean; runtime: "opencode" | "simulation"; opencode?: string; api: "auto" | "v1" | "v2"; simulationSpeed: number; seed: boolean }) => {
    if (opts.detach) {
      const logDir = join(paths().data, "logs");
      mkdirSync(logDir, { recursive: true });
      const out = openSync(join(logDir, "daemon.log"), "a");
      const args = process.argv.slice(1).filter((a) => a !== "--detach");
      const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await client(port()).health().then(() => true, () => false)) {
          process.stdout.write(`✔ AiFlow läuft auf http://127.0.0.1:${port()} (PID ${child.pid ?? "?"})\n`);
          return;
        }
      }
      fail(`Daemon startet nicht. Log: ${join(logDir, "daemon.log")}`);
    }
    const running = await startDaemon({
      paths: paths(),
      port: port(),
      runtime: opts.runtime,
      ...(opts.opencode ? { opencodeBinary: opts.opencode } : {}),
      opencodeApi: opts.api,
      simulationSpeed: opts.simulationSpeed,
      ...(opts.seed ? { seedFrom: examplesDir } : {}),
      log: (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`),
    });
    process.stdout.write(`AiFlow läuft auf ${running.url} (Runtime: ${opts.runtime})\n`);
    const shutdown = () => void running.close().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("stop")
  .description("Daemon beenden")
  .action(() => {
    const lock = join(paths().data, "daemon.lock");
    if (!existsSync(lock)) fail("Kein laufender Daemon gefunden.");
    process.kill(Number(readFileSync(lock, "utf8")), "SIGTERM");
    process.stdout.write("✔ Daemon beendet\n");
  });

program
  .command("status")
  .description("Zustand von Daemon und Runtime")
  .action(async () => {
    const h = await guard(client(port()).health());
    process.stdout.write(`AiFlow ${h.version} · Runtime ${h.runtime.id}${h.runtime.api ? ` (${h.runtime.api} ${h.runtime.version ?? ""})` : ""} · ${h.runtime.ready ? "bereit" : `nicht bereit: ${h.runtime.error ?? ""}`}\n`);
  });

program
  .command("open")
  .description("Web-UI im Browser öffnen")
  .option("--project <path>", "Projekt", process.cwd())
  .action(async (opts: { project: string }) => {
    const { url } = await guard(client(port()).createLogin(resolve(opts.project)));
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
    process.stdout.write(`${url}\n`);
  });

program
  .command("run <workflow> <prompt>")
  .description("Workflow starten")
  .option("--project <path>", "Projektverzeichnis", process.cwd())
  .option("--param <k=v...>", "weitere Eingaben", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--follow", "Fortschritt live anzeigen")
  .action(async (workflow: string, prompt: string, opts: { project: string; param: string[]; follow?: boolean }) => {
    const c = client(port());
    const input: Record<string, unknown> = { prompt };
    for (const p of opts.param) {
      const [k, ...rest] = p.split("=");
      if (k) input[k] = rest.join("=");
    }
    await guard(c.registerProject(resolve(opts.project)));
    const { id } = await guard(c.startRun({ workflowId: workflow, projectDir: resolve(opts.project), input, origin: "cli" }));
    process.stdout.write(`▶ Run ${id} gestartet\n`);
    if (!opts.follow) return;
    const stop = new AbortController();
    let last = "";
    const render = async (): Promise<RunView> => {
      const run = await c.run(id);
      const text = followLines(run).join("\n");
      if (text !== last) {
        process.stdout.write(`\x1b[2J\x1b[H${text}\n`);
        last = text;
      }
      return run;
    };
    void c.subscribeRun(id, () => void render(), stop.signal);
    for (;;) {
      const run = await render();
      if ([...TERMINAL_RUN_STATUSES, "review_pending", "waiting_input"].includes(run.status)) {
        stop.abort();
        if (run.status === "review_pending") process.stdout.write(`\nReview: aiflow open  (oder http://127.0.0.1:${port()}/runs/${id}/review)\n`);
        if (run.status === "waiting_input") process.stdout.write("\nWartet auf Eingabe: aiflow inbox\n");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

function followLines(run: RunView): string[] {
  const lines = [`AiFlow · ${run.workflow.name} · ${run.status}`];
  for (const s of run.steps.filter((x) => !x.parentStepId && x.nodeType !== "start")) {
    const icon = s.status === "completed" ? "✔" : s.status === "running" ? "▶" : s.status === "failed" ? "✖" : s.status === "waiting" ? "⏸" : "■";
    lines.push(`${icon} ${s.label}${s.visit > 1 ? ` #${s.visit}` : ""}${s.port && s.port !== "next" ? ` → ${s.port}` : ""}${s.handoff?.summary ? `  ${s.handoff.summary.slice(0, 80)}` : ""}`);
    for (const sub of run.steps.filter((x) => x.parentStepId === s.id)) lines.push(`    ${sub.status === "completed" ? "✔" : sub.status === "running" ? "▶" : "✖"} ${sub.label}`);
  }
  if (run.error) lines.push(`✖ ${run.error}`);
  return lines;
}

const runs = program.command("runs").description("Runs anzeigen und steuern");
runs
  .command("ls")
  .option("--project <path>")
  .action(async (opts: { project?: string }) => {
    for (const r of await guard(client(port()).runs(opts.project ? { project: resolve(opts.project) } : {}))) {
      process.stdout.write(`${r.id}  ${new Date(r.createdAt).toLocaleString("de-DE")}  ${r.status.padEnd(15)} ${r.workflowId.padEnd(20)} ${r.prompt.slice(0, 50)}\n`);
    }
  });
runs.command("show <id>").action(async (id: string) => {
  process.stdout.write(`${followLines(await guard(client(port()).run(id))).join("\n")}\n`);
});
runs.command("cancel <id>").action(async (id: string) => {
  await guard(client(port()).cancelRun(id));
});
runs.command("resume <id>").action(async (id: string) => {
  await guard(client(port()).resumeRun(id));
});
runs.command("apply <id>").action(async (id: string) => {
  await guard(client(port()).review(id, { action: "apply" }));
});
runs.command("discard <id>").action(async (id: string) => {
  await guard(client(port()).review(id, { action: "discard" }));
});

const workflows = program.command("workflows").description("Workflows");
workflows
  .command("ls")
  .option("--project <path>")
  .action(async (opts: { project?: string }) => {
    for (const w of await guard(client(port()).workflows(opts.project ? resolve(opts.project) : undefined))) {
      process.stdout.write(`${w.id.padEnd(22)} ${w.scope.padEnd(8)} ${w.error ? `✖ ${w.error}` : (w.definition?.name ?? "")}\n`);
    }
  });
workflows
  .command("validate <file>")
  .action(async (file: string) => {
    const { parse } = await import("yaml");
    const result = await guard(client(port()).validateWorkflow(parse(readFileSync(file, "utf8"))));
    for (const i of result.issues) process.stdout.write(`${i.severity === "error" ? "✖" : "⚠"} ${i.message}\n`);
    process.stdout.write(result.ok ? "✔ gültig\n" : "");
    if (!result.ok) process.exit(1);
  });

program
  .command("agents")
  .description("Agenten auflisten")
  .action(async () => {
    for (const a of await guard(client(port()).agents())) process.stdout.write(`${a.id.padEnd(24)} ${a.scope.padEnd(8)} ${a.definition?.name ?? a.error ?? ""}\n`);
  });

program
  .command("inbox")
  .description("Offene Freigaben, Rückfragen und Reviews")
  .argument("[itemId]", "zu beantwortender Eintrag")
  .argument("[option]", "Antwort")
  .action(async (itemId?: string, option?: string) => {
    const c = client(port());
    const items = await guard(c.inbox());
    if (itemId && option) {
      const item = items.find((i) => i.id === itemId);
      if (!item) fail(`Eintrag ${itemId} nicht gefunden.`);
      if (item.kind === "review") await guard(c.review(item.runId, { action: option as "apply" | "discard" | "branch" }));
      else await guard(c.answer(item.runId, item.id, option));
      process.stdout.write("✔ beantwortet\n");
      return;
    }
    for (const i of items) process.stdout.write(`${i.id}  [${i.kind}] ${i.title}: ${i.question}  (${i.options.join(" | ")})\n`);
    if (items.length === 0) process.stdout.write("Nichts offen.\n");
  });

const setup = program.command("setup").description("Integration einrichten");
setup
  .command("opencode")
  .description("AiFlow-Plugin global in opencode eintragen (v1 oder v2 wird erkannt)")
  .option("--api <api>", "auto | v1 | v2", "auto")
  .option("--yes", "ohne Rückfrage schreiben")
  .option("--opencode <binary>", "opencode-Binary", "opencode")
  .action(async (opts: { api: string; yes?: boolean; opencode: string }) => {
    const api = opts.api !== "auto" ? opts.api : await detectApi(opts.opencode);
    const pluginDir = fileURLToPath(new URL("../../opencode-plugin", import.meta.url));
    const global = program.opts<{ dataDir?: string; opencodeConfig?: string }>();
    // Eigene opencode-Konfiguration: Plugin dort eintragen, damit es auch im Agent-Worker aktiv ist
    const file = paths().opencodeConfig ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "opencode.json");
    const options = {
      url: `http://127.0.0.1:${port()}`,
      autoStart: true,
      ...(global.dataDir ? { dataDir: global.dataDir } : {}),
      ...(global.opencodeConfig ? { opencodeConfig: global.opencodeConfig } : {}),
    };
    const entry = api === "v2" ? { package: pluginDir, options } : [join(pluginDir, "src", "index.ts"), options];
    const key = api === "v2" ? "plugins" : "plugin";
    let config: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        config = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        fail(`${file} enthält Kommentare oder ist kein reines JSON. Bitte manuell eintragen:\n"${key}": [${JSON.stringify(entry)}]`);
      }
    }
    const list = Array.isArray(config[key]) ? (config[key] as unknown[]) : [];
    if (JSON.stringify(list).includes("opencode-plugin")) {
      process.stdout.write("✔ AiFlow-Plugin ist bereits eingetragen.\n");
      return;
    }
    process.stdout.write(`opencode ${api} erkannt. Eintrag in ${file}:\n  "${key}": [${JSON.stringify(entry)}]\n`);
    if (!opts.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("Schreiben? [j/N] ");
      rl.close();
      if (!/^j|^y/i.test(answer)) return;
    }
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...config, [key]: [...list, entry] }, null, 2)}\n`);
    process.stdout.write("✔ eingetragen. opencode neu starten.\n");
  });

const SETTING_KEYS = Object.keys(settingsSchema.shape) as (keyof AiflowSettings)[];

const configCmd = program.command("config").description("Dauerhafte Einstellungen (config.json im Konfigurationsverzeichnis)");
configCmd
  .command("show", { isDefault: true })
  .description("Wirksame Pfade und gespeicherte Einstellungen anzeigen")
  .action(() => {
    const p = paths();
    process.stdout.write(`Datei:                 ${join(p.config, "config.json")}\n`);
    process.stdout.write(`Gespeichert:           ${JSON.stringify(readSettings(p.config))}\n`);
    process.stdout.write(`Datenverzeichnis:      ${p.data}\n`);
    process.stdout.write(`opencode-Konfiguration: ${p.opencodeConfig ?? "(Standard von opencode)"}\n`);
  });
configCmd
  .command("set <key> <value>")
  .description(`Einstellung setzen (${SETTING_KEYS.join(", ")})`)
  .action((key: string, value: string) => writeSetting(key, value));
configCmd
  .command("unset <key>")
  .description("Einstellung entfernen")
  .action((key: string) => writeSetting(key, undefined));

function writeSetting(key: string, value: string | undefined): void {
  if (!(SETTING_KEYS as string[]).includes(key)) fail(`Unbekannte Einstellung „${key}“. Erlaubt: ${SETTING_KEYS.join(", ")}`);
  const dir = paths().config;
  const next: Record<string, string> = { ...readSettings(dir) };
  if (value === undefined) Reflect.deleteProperty(next, key);
  else next[key] = value;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(settingsSchema.parse(next), null, 2)}\n`);
  process.stdout.write(`✔ ${key} ${value === undefined ? "entfernt" : `= ${value}`}. Ein laufender Daemon übernimmt das erst nach Neustart (aiflow stop && aiflow serve --detach).\n`);
}

async function detectApi(binary: string): Promise<"v1" | "v2"> {
  const version = await new Promise<string>((res) => execFile(binary, ["--version"], (e, out) => res(e ? "" : out.trim())));
  if (!version) fail(`opencode nicht gefunden („${binary} --version“). Mit --api v1|v2 angeben.`);
  return Number(version.replace(/^v/, "").split(".")[0]) >= 2 ? "v2" : "v1";
}

program
  .command("doctor")
  .description("Umgebung prüfen")
  .action(async () => {
    const check = (ok: boolean, text: string) => process.stdout.write(`${ok ? "✔" : "✖"} ${text}\n`);
    const gitVersion = await new Promise<string>((res) => execFile("git", ["--version"], (e, out) => res(e ? "" : out.trim())));
    check(Boolean(gitVersion), gitVersion || "git nicht gefunden");
    const oc = await new Promise<string>((res) => execFile("opencode", ["--version"], (e, out) => res(e ? "" : out.trim())));
    check(Boolean(oc), oc ? `opencode ${oc} (${Number(oc.replace(/^v/, "").split(".")[0]) >= 2 ? "v2" : "v1"})` : "opencode nicht gefunden (Simulation weiterhin möglich)");
    check(Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.versions.node}`);
    const health = await client(port()).health().catch(() => undefined);
    check(Boolean(health), health ? `Daemon auf Port ${port()} · Runtime ${health.runtime.id} ${health.runtime.ready ? "bereit" : (health.runtime.error ?? "nicht bereit")}` : `Daemon auf Port ${port()} nicht erreichbar`);
    if (health) {
      const info = await client(port()).runtime().catch(() => undefined);
      if (info && info.id !== "simulation") check(info.plugins.some((p) => p.includes("aiflow")), "AiFlow-Plugin im Worker aktiv");
    }
    const p = paths();
    check(true, `Konfiguration: ${p.config} · Daten: ${p.data}`);
    if (p.opencodeConfig) check(existsSync(p.opencodeConfig), `opencode-Konfiguration für Agenten: ${p.opencodeConfig}${existsSync(p.opencodeConfig) ? "" : " (fehlt)"}`);
  });

await program.parseAsync(process.argv);
