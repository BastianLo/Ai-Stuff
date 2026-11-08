// Erzeugt die Screenshots in docs/screenshots mit der Simulations-Runtime (kein LLM nötig).
// Aufruf: pnpm build && node scripts/screenshots.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repo = fileURLToPath(new URL("..", import.meta.url));
const out = join(repo, "docs", "screenshots");
const root = join(tmpdir(), "aiflow-shots");
const port = 5790;
const base = `http://127.0.0.1:${port}`;
rmSync(root, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { createDemoProject } = await import(join(repo, "packages/testkit/dist/index.js"));
const project = createDemoProject(join(root, "demo-shop"));
const env = { ...process.env, AIFLOW_CONFIG_DIR: join(root, "config"), AIFLOW_DATA_DIR: join(root, "data") };
const daemon = spawn(process.execPath, [join(repo, "packages/cli/dist/index.js"), "serve", "--runtime", "simulation", "--simulation-speed", "1.2", "--port", String(port)], { env, stdio: "ignore" });
process.on("exit", () => daemon.kill("SIGTERM"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token;
for (let i = 0; i < 100 && !token; i++) {
  try {
    const t = readFileSync(join(root, "config", "auth-token"), "utf8").trim();
    if ((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${t}` } })).ok) token = t;
  } catch {}
  await sleep(200);
}
const api = async (method, path, body) => (await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const waitFor = async (id, statuses) => {
  for (let i = 0; i < 600; i++) {
    const r = await api("GET", `/api/runs/${id}`);
    if (statuses.includes(r.status)) return r;
    await sleep(250);
  }
};
const until = async (id, pred) => {
  for (let i = 0; i < 600; i++) {
    const r = await api("GET", `/api/runs/${id}`);
    if (pred(r)) return r;
    await sleep(150);
  }
};

await api("POST", "/api/projects", { path: project });
const q = `?project=${encodeURIComponent(project)}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto((await api("POST", "/api/login-links", { project })).url);
const shot = async (name, settle = 1200, zoomIn = 0) => {
  await sleep(settle);
  const fit = page.locator(".react-flow__controls-fitview");
  if (await fit.count()) {
    await fit.first().evaluate((b) => b.click());
    await sleep(400);
    for (let i = 0; i < zoomIn; i++) await page.locator(".react-flow__controls-zoomin").first().evaluate((b) => b.click());
    await sleep(400);
  }
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log("✔", name);
};

// 1) Ein abgeschlossener Run mit Veto-Schleife → Review
const feature = (await api("POST", "/api/runs", { workflowId: "feature-review", projectDir: project, input: { prompt: "Passwort-Reset per E-Mail" }, origin: "tui" })).id;
await page.goto(`${base}/runs/${feature}${q}`);
await until(feature, (r) => r.steps.some((s) => s.nodeId === "security" && s.status === "running"));
await shot("05-run-live-parallel-reviews", 1500, 2);
await waitFor(feature, ["review_pending"]);
await page.goto(`${base}/runs/${feature}${q}`);
await page.getByText("Verdict").first().waitFor();
await page.locator("aside button", { hasText: "Verdict" }).first().click();
await shot("06-run-step-detail-veto", 1200, 2);
await page.locator("aside button", { hasText: "Implementer" }).nth(1).click();
await page.getByRole("button", { name: "Prompt" }).click();
await shot("07-run-exact-prompt", 1200, 2);
await page.goto(`${base}/runs/${feature}/review${q}`);
await shot("09-review-report");
await page.getByRole("button", { name: /src\/passwort/ }).click();
await shot("10-review-diff");

// 2) Recherche-Orchestrator mit Sub-Agenten (live)
const research = (await api("POST", "/api/runs", { workflowId: "research-feature", projectDir: project, input: { prompt: "Rabattcodes im Checkout" }, origin: "web" })).id;
await page.goto(`${base}/runs/${research}${q}`);
await until(research, (r) => r.steps.filter((s) => s.nodeType === "subagent").length >= 2);
await shot("08-run-subagents-waves", 900);

// 3) Großes Feature wartet auf Freigabe → Inbox
const big = (await api("POST", "/api/runs", { workflowId: "big-feature", projectDir: project, input: { prompt: "Bestellhistorie mit Export" }, origin: "cli" })).id;
await waitFor(big, ["waiting_input"]);
await page.goto(`${base}/inbox${q}`);
await shot("11-inbox-approval");

// Editor, Agenten, Übersicht, History
await page.goto(`${base}/workflows/feature-review${q}`);
await shot("02-workflow-editor", 1800, 2);
await page.locator('.react-flow__node[data-id="verdict"]').click();
await shot("03-editor-join-inspector", 600, 2);
await page.locator('.react-flow__node[data-id="research"]').count();
await page.goto(`${base}/workflows/research-feature${q}`);
await page.locator('.react-flow__node[data-id="research"]').click();
await shot("04-editor-subagents", 1500);
await page.goto(`${base}/workflows/feature-triage${q}`);
await page.getByRole("button", { name: "Testlauf" }).click();
await page.getByRole("button", { name: "Simulieren" }).click();
await shot("12-editor-simulation", 1200);
await page.goto(`${base}/agents/security-reviewer${q}`);
await page.getByRole("button", { name: "Werkzeuge & Rechte" }).click();
await shot("13-agent-editor-permissions");
await page.goto(`${base}/agents${q}`);
await shot("14-agent-library");
await waitFor(research, ["review_pending", "failed"]);
await page.goto(`${base}/runs${q}`);
await shot("15-run-history");
await page.goto(`${base}/${q}`);
await shot("01-dashboard");
await page.evaluate(() => localStorage.setItem("aiflow.theme", "dark"));
await page.goto(`${base}/workflows/feature-review${q}`);
await shot("16-editor-dark", 1800, 2);
await page.evaluate(() => localStorage.setItem("aiflow.theme", "light"));

await browser.close();
daemon.kill("SIGTERM");
writeFileSync(join(out, "README.md"), "Erzeugt mit `node scripts/screenshots.mjs` (Simulations-Runtime, Demo-Projekt `examples/demo-repo`).\n");
