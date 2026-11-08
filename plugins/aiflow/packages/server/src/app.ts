import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { AiflowError, parseWithSchema, TERMINAL_RUN_STATUSES, workflowSchema, type RunEvent } from "@aiflow/core";
import type { RunState } from "@aiflow/engine";
import type { DefinitionKind, Scope } from "@aiflow/store";
import { git } from "@aiflow/workspace-git";
import type { Daemon, GlobalEvent } from "./daemon.js";
import { WorkerJobs } from "./jobs.js";

const KINDS = new Set<DefinitionKind>(["agents", "workflows", "snippets"]);
const STATUS: Record<string, number> = { VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, INVALID_STATE: 409, FORBIDDEN: 403, LIMIT: 422, TIMEOUT: 504 };

export interface AppOptions {
  /** Verzeichnis der gebauten Web-UI (packages/web/dist). */
  webDir?: string;
  /** Nur für Tests: Host-Prüfung abschalten. */
  allowAnyHost?: boolean;
}

/** Run-Ansicht für Clients (siehe @aiflow/client RunView). */
export function toRunView(state: RunState, children: string[] = []) {
  return {
    id: state.id,
    status: state.status,
    outcome: state.outcome,
    error: state.error,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    workflow: state.spec.workflow,
    agents: state.spec.agents,
    input: state.spec.input,
    projectDir: state.spec.projectDir,
    origin: state.spec.origin,
    parentRunId: state.spec.parentRunId,
    steps: state.stepOrder.map((id) => state.steps[id]).filter(Boolean),
    activeNodes: state.tokens.filter((t) => t.status === "running" || t.status === "waiting" || t.status === "ready").map((t) => t.nodeId),
    edgeCounts: state.edgeCounts,
    inbox: state.inbox,
    review: state.review,
    children,
  };
}

/** Die HTTP-API des Daemons (PLAN.md 12). */
export function createApp(daemon: Daemon, options: AppOptions = {}): Hono {
  const app = new Hono();
  const port = daemon.options.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  app.onError((error, c) => {
    if (error instanceof AiflowError) {
      const details = error.details as { code?: string } | undefined;
      return c.json({ error: { code: details?.code ?? error.code, message: error.message, details: error.details } }, (STATUS[error.code] ?? 500) as 400);
    }
    if (error instanceof SyntaxError) return c.json({ error: { code: "VALIDATION", message: `Ungültiges JSON: ${error.message}` } }, 400);
    daemon.log(`Fehler: ${error.stack ?? error.message}`);
    return c.json({ error: { code: "INTERNAL", message: error.message } }, 500);
  });

  // DNS-Rebinding- und CSRF-Schutz (PLAN.md 12.2)
  app.use("*", async (c, next) => {
    if (!options.allowAnyHost && !allowedHosts.has(c.req.header("host") ?? "")) return c.json({ error: { code: "FORBIDDEN", message: "Unerlaubter Host-Header." } }, 403);
    const origin = c.req.header("origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && origin && !allowedOrigins.has(origin) && !options.allowAnyHost) {
      return c.json({ error: { code: "FORBIDDEN", message: "Unerlaubte Herkunft (Origin)." } }, 403);
    }
    await next();
  });

  // Login per Einmal-Link → HttpOnly-Cookie
  app.get("/login", (c) => {
    const result = daemon.consumeOtp(c.req.query("otp") ?? "");
    if (!result.ok) return c.html("<h1>Login-Link ungültig oder abgelaufen</h1><p>Bitte in opencode erneut <code>/aiflow-configure</code> ausführen oder <code>aiflow open</code> starten.</p>", 401);
    setCookie(c, "aiflow_session", daemon.token, { httpOnly: true, sameSite: "Strict", path: "/" });
    const next = c.req.query("next") ?? "/";
    const target = next.startsWith("/") && !next.startsWith("//") ? next : "/";
    const project = result.project ? `${target.includes("?") ? "&" : "?"}project=${encodeURIComponent(result.project)}` : "";
    return c.redirect(`${target}${project}`);
  });

  // Worker-API: nur mit Worker-Token (opencode-Plugin im Worker)
  const worker = new Hono();
  worker.use("*", async (c, next) => {
    if (c.req.header("x-aiflow-worker-token") !== daemon.workerToken) return c.json({ error: { code: "FORBIDDEN", message: "Ungültiges Worker-Token." } }, 403);
    await next();
  });
  worker.get("/sessions/:sid", (c) => {
    const sid = c.req.param("sid");
    if (!daemon.bridge.has(sid)) return c.json({ error: { code: "NOT_FOUND", message: "Keine AiFlow-Session." } }, 404);
    return c.json(daemon.bridge.info(sid));
  });
  worker.post("/sessions/:sid/handoff", async (c) => c.json(daemon.bridge.submitHandoff(c.req.param("sid"), (await c.req.json<{ input: unknown }>()).input)));
  // Delegation und Rückfragen können lange dauern: Auftrag starten, Ergebnis über /jobs/:id abholen.
  const jobs = new WorkerJobs();
  worker.post("/sessions/:sid/delegate", async (c) => {
    const sid = c.req.param("sid");
    const body = await c.req.json<{ tasks?: { agent: string; task: string; expectedResult?: string }[] }>();
    if (!daemon.bridge.has(sid)) throw new AiflowError("NOT_FOUND", "Keine AiFlow-Session.");
    return c.json({ job: jobs.start(() => daemon.bridge.delegate(sid, body.tasks ?? [])) });
  });
  worker.get("/jobs/:id", (c) => {
    const job = jobs.take(c.req.param("id"));
    return job ? c.json(job) : c.json({ error: { code: "NOT_FOUND", message: "Auftrag unbekannt (Daemon neu gestartet?)." } }, 404);
  });
  worker.post("/sessions/:sid/progress", async (c) => {
    daemon.bridge.progress(c.req.param("sid"), (await c.req.json<{ message: string }>()).message);
    return c.json({ ok: true });
  });
  worker.post("/sessions/:sid/ask", async (c) => {
    const body = await c.req.json<{ question?: unknown; options?: unknown }>();
    if (typeof body.question !== "string" || !body.question.trim()) return c.json({ error: { code: "VALIDATION", message: "question fehlt." } }, 400);
    const options = Array.isArray(body.options) ? body.options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
    const sid = c.req.param("sid");
    const question = body.question;
    if (!daemon.bridge.has(sid)) throw new AiflowError("NOT_FOUND", "Keine AiFlow-Session.");
    return c.json({ job: jobs.start(() => daemon.bridge.ask(sid, question, options)) });
  });
  worker.post("/sessions/:sid/context", async (c) => c.json({ text: daemon.bridge.context(c.req.param("sid"), (await c.req.json<{ query?: string }>()).query ?? "") }));
  app.route("/api/worker", worker);

  // Ab hier: Nutzer-API mit Token oder Session-Cookie
  const api = new Hono();
  api.use("*", async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (bearer !== daemon.token && getCookie(c as Context, "aiflow_session") !== daemon.token) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Nicht angemeldet. Login über /aiflow-configure in opencode oder `aiflow open`." } }, 401);
    }
    await next();
  });

  api.get("/health", (c) => c.json({ ok: true, version: "0.1.0", runtime: daemon.runtimeStatus }));
  api.post("/login-links", async (c) => {
    const body: { project?: string } = await c.req.json<{ project?: string }>().catch(() => ({}));
    const otp = daemon.createOtp(body.project);
    return c.json({ url: `http://127.0.0.1:${port}/login?otp=${otp}` });
  });

  // Projekte
  const projectInfo = (path: string, lastUsed = Date.now()) => ({ path, name: path.split(sep).pop() ?? path, trusted: daemon.definitions.isTrusted(path), lastUsed });
  api.get("/projects", (c) => c.json(daemon.projects.list().map((p) => projectInfo(p.path, p.lastUsed))));
  api.post("/projects", async (c) => {
    const { path } = await c.req.json<{ path: string }>();
    if (!path || !existsSync(path)) throw new AiflowError("VALIDATION", `Projektverzeichnis „${path}“ existiert nicht.`);
    const record = daemon.projects.touch(path);
    return c.json(projectInfo(record.path, record.lastUsed));
  });
  api.post("/projects/trust", async (c) => {
    const { path } = await c.req.json<{ path: string }>();
    daemon.definitions.trust(resolve(path));
    return c.json(projectInfo(resolve(path)));
  });

  // Definitionen
  const kindOf = (c: Context): DefinitionKind => {
    const kind = c.req.param("kind") as DefinitionKind;
    if (!KINDS.has(kind)) throw new AiflowError("NOT_FOUND", `Unbekannte Art „${kind}“.`);
    return kind;
  };
  const project = (c: Context): string | undefined => c.req.query("project") || undefined;
  api.get("/definitions/:kind", (c) => c.json(daemon.definitions.list(kindOf(c), project(c))));
  api.get("/definitions/:kind/:id", (c) => c.json(daemon.definitions.get(kindOf(c), c.req.param("id"), project(c))));
  api.get("/definitions/:kind/:id/versions", (c) => c.json(daemon.store.definitionVersions(kindOf(c), c.req.param("id"))));
  api.put("/definitions/:kind/:id", async (c) => {
    const kind = kindOf(c);
    const scope = (c.req.query("scope") ?? "global") as Scope;
    const body = await c.req.json<Record<string, unknown>>();
    if (body.id !== c.req.param("id")) throw new AiflowError("VALIDATION", "Die ID im Pfad und im Inhalt stimmen nicht überein.");
    const entry = daemon.definitions.save(kind, body, scope, project(c));
    if (scope === "project" && project(c)) daemon.definitions.trust(resolve(project(c) ?? ""));
    daemon.broadcast({ type: "definitions.changed", kind });
    return c.json(entry);
  });
  api.delete("/definitions/:kind/:id", (c) => {
    const kind = kindOf(c);
    daemon.definitions.delete(kind, c.req.param("id"), (c.req.query("scope") ?? "global") as Scope, project(c));
    daemon.broadcast({ type: "definitions.changed", kind });
    return c.json({ ok: true });
  });
  api.post("/workflows/validate", async (c) => {
    const body = await c.req.json<{ workflow: unknown; project?: string }>();
    return c.json(daemon.validate(body.workflow, body.project));
  });
  api.post("/workflows/:id/simulate", async (c) => {
    const body = await c.req.json<{ project?: string; workflow?: unknown; choices?: Record<string, string>; scriptExitCode?: number }>();
    const workflow = body.workflow ? parseWithSchema(workflowSchema, body.workflow, "Workflow") : daemon.resolveDefinitions(body.project).workflows[c.req.param("id")];
    if (!workflow) throw new AiflowError("NOT_FOUND", `Workflow „${c.req.param("id")}“ existiert nicht.`);
    return c.json(await daemon.simulate(workflow, body.project, body.choices ?? {}, body.scriptExitCode ?? 0));
  });
  api.post("/agents/:id/playground", async (c) => {
    const body = await c.req.json<{ project: string; prompt: string }>();
    return c.json({ runId: daemon.playground(c.req.param("id"), body.project, body.prompt) });
  });

  // Runs
  api.post("/runs", async (c) => {
    const body = await c.req.json<{ workflowId: string; projectDir: string; input: Record<string, unknown>; origin?: "web" | "cli" | "tui" | "api" }>();
    return c.json({ id: daemon.startRun({ workflowId: body.workflowId, projectDir: body.projectDir, input: body.input ?? {}, origin: body.origin ?? "api" }) });
  });
  api.get("/runs", (c) =>
    c.json(
      daemon.store.listRuns({
        ...(c.req.query("project") ? { projectDir: resolve(c.req.query("project") ?? "") } : {}),
        ...(c.req.query("status") ? { status: c.req.query("status") } : {}),
        ...(c.req.query("workflow") ? { workflowId: c.req.query("workflow") } : {}),
        ...(c.req.query("q") ? { query: c.req.query("q") } : {}),
        limit: Number(c.req.query("limit") ?? 200),
      }),
    ),
  );
  api.get("/runs/:id", (c) => {
    const state = daemon.state(c.req.param("id"));
    const children = daemon.store.listRuns({ includeChildren: true, limit: 500 }).filter((r) => r.parentRunId === state.id).map((r) => r.id);
    return c.json(toRunView(state, children));
  });
  api.get("/runs/:id/events", (c) => c.json(daemon.store.events(c.req.param("id"), Number(c.req.query("after") ?? 0))));
  api.get("/runs/:id/stream", (c) => {
    const runId = c.req.param("id");
    daemon.state(runId);
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    return streamSSE(c, async (stream) => {
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const off = daemon.onRun(runId, (e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      let seq = after;
      for (const e of daemon.store.events(runId, after)) {
        await stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
        seq = e.seq;
      }
      while (!stream.aborted) {
        const e = queue.shift();
        if (!e) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000);
          });
          wake = undefined;
          if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        if (e.seq <= seq) continue;
        seq = e.seq;
        await stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
      }
      off();
    });
  });
  api.get("/runs/:id/documents", async (c) => {
    const state = daemon.state(c.req.param("id"));
    const docs = await Promise.all(
      Object.entries(state.spec.workflow.documents).map(async ([name, spec]) => ({
        name,
        description: spec.description,
        content: await daemon.documents.read(state.id, name),
        versions: await daemon.documents.versions(state.id, name),
      })),
    );
    return c.json(docs);
  });
  api.get("/runs/:id/steps/:stepId/diff", async (c) => {
    const state = daemon.state(c.req.param("id"));
    const step = state.steps[c.req.param("stepId")];
    if (!step?.checkpointBefore || !step.checkpointAfter) return c.json([]);
    const ws = state.tokens.find((t) => t.workspace.id === step.workspaceId)?.workspace ?? state.finalWorkspace ?? state.baseWorkspace;
    if (!ws) return c.json([]);
    try {
      const out = await git(ws.path, ["diff", "--no-renames", step.checkpointBefore, step.checkpointAfter]);
      return c.json(splitPatch(out.stdout));
    } catch {
      return c.json([]);
    }
  });
  for (const action of ["pause", "resume", "cancel"] as const) {
    api.post(`/runs/:id/${action}`, (c) => {
      daemon.engine[action](c.req.param("id"));
      return c.json({ ok: true });
    });
  }
  api.delete("/runs/:id", (c) => {
    const state = daemon.state(c.req.param("id"));
    if (!TERMINAL_RUN_STATUSES.includes(state.status)) throw new AiflowError("INVALID_STATE", "Laufende Runs zuerst abbrechen.");
    daemon.store.deleteRun(state.id);
    daemon.engine.forget(state.id);
    return c.json({ ok: true });
  });
  api.post("/runs/:id/review", async (c) => {
    const id = c.req.param("id");
    await daemon.engine.decideReview(id, await c.req.json());
    return c.json({ ok: true, status: daemon.state(id).status });
  });

  // Inbox
  api.get("/inbox", (c) => c.json(daemon.inbox(project(c))));
  api.post("/inbox/:runId/:itemId", async (c) => {
    const body = await c.req.json<{ option: string; text?: string }>();
    daemon.engine.answer(c.req.param("runId"), c.req.param("itemId"), body.option, body.text);
    daemon.broadcast({ type: "inbox.changed", runId: c.req.param("runId") });
    return c.json({ ok: true });
  });

  api.get("/runtime", async (c) => c.json(await daemon.runtimeInfo(c.req.query("project"))));

  // Globale Events (Run-Status, Definitionen, Inbox)
  api.get("/events", (c) => {
    const filter = c.req.query("project") ? resolve(c.req.query("project") ?? "") : undefined;
    return streamSSE(c, async (stream) => {
      const queue: GlobalEvent[] = [{ type: "hello" }];
      let wake: (() => void) | undefined;
      const off = daemon.onGlobal((e) => {
        if (filter && e.projectDir && e.projectDir !== filter) return;
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        off();
        wake?.();
      });
      while (!stream.aborted) {
        const e = queue.shift();
        if (e) {
          await stream.writeSSE({ data: JSON.stringify(e) });
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 15_000);
        });
        wake = undefined;
        if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
      off();
    });
  });

  app.route("/api", api);

  // Web-UI (statisch, SPA-Fallback)
  const webDir = options.webDir;
  if (webDir && existsSync(webDir)) {
    const root = resolve(webDir);
    app.get("*", (c) => {
      const path = normalize(decodeURIComponent(new URL(c.req.url).pathname));
      const file = resolve(join(root, path));
      const target = file.startsWith(root + sep) && existsSync(file) && extname(file) ? file : join(root, "index.html");
      const type = MIME[extname(target)] ?? "application/octet-stream";
      return c.body(readFileSync(target), 200, { "content-type": type, "cache-control": target.endsWith("index.html") ? "no-store" : "public, max-age=3600" });
    });
  }
  return app;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function splitPatch(patch: string) {
  return patch
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => {
      const text = `diff --git ${chunk}`;
      const path = /^diff --git a\/(\S+) b\//.exec(text)?.[1] ?? "?";
      const lines = text.split("\n");
      return {
        path,
        status: text.includes("new file mode") ? ("added" as const) : text.includes("deleted file mode") ? ("deleted" as const) : ("modified" as const),
        additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
        deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
        patch: text,
      };
    });
}
