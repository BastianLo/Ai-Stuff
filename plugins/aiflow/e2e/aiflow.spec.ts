import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { api, BASE, state } from "./env";

async function login(page: Page): Promise<string> {
  const { project } = state();
  const { url } = await api<{ url: string }>("POST", "/api/login-links", { project });
  await page.goto(url);
  await expect(page.getByText("AiFlow").first()).toBeVisible();
  return `?project=${encodeURIComponent(project)}`;
}

async function waitStatus(id: string, statuses: string[]): Promise<{ status: string }> {
  for (let i = 0; i < 300; i++) {
    const run = await api<{ status: string }>("GET", `/api/runs/${id}`);
    if (statuses.includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Run ${id} erreicht ${statuses.join("/")} nicht`);
}

test("ohne Login erscheint der Anmeldehinweis", async ({ page }) => {
  await page.goto(BASE);
  await expect(page.getByText("Anmeldung erforderlich")).toBeVisible();
});

test("Übersicht, Workflows, Agenten und Bausteine laden ohne Fehler", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const q = await login(page);
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
  await page.goto(`/workflows${q}`);
  await expect(page.getByText("Feature mit Multi-Review").first()).toBeVisible();
  await page.goto(`/agents${q}`);
  await expect(page.getByText("Security-Reviewer").first()).toBeVisible();
  await page.goto(`/snippets${q}`);
  await expect(page.getByText("Coding-Standards").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("Workflow per Drag & Drop bauen, verbinden, validieren und speichern", async ({ page }) => {
  const q = await login(page);
  await page.goto(`/workflows${q}`);
  await page.getByRole("button", { name: "Neuer Workflow" }).click();
  await page.getByLabel("ID (wird zum Command /aiflow-wf-<id>)").fill("e2e-flow");
  await page.getByLabel("Name").fill("E2E-Ablauf");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("/aiflow-wf-e2e-flow").first()).toBeVisible();
  await expect(page.getByText("Workflow ist gültig")).toBeVisible();

  // Agent aus der Palette auf das Canvas ziehen
  const canvas = page.locator(".react-flow__pane");
  await page.locator("aside").getByText("Implementer", { exact: true }).dragTo(canvas, { targetPosition: { x: 400, y: 450 } });
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  // Neuer Knoten ist unverbunden → Validierung meldet Fehler
  await expect(page.getByText(/Probleme: [1-9]/)).toBeVisible();

  // Alte Kante start→done löschen: Kante anklicken, im Inspector löschen
  await page.locator(".react-flow__edge").first().click({ force: true });
  await page.locator("aside").last().getByRole("button").first().click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);

  // start → implementer und implementer → done verbinden
  const connect = async (sourceNode: string, port: string, targetNode: string) => {
    const handle = page.locator(`.react-flow__node[data-id="${sourceNode}"] .react-flow__handle.source[data-handleid="${port}"]`);
    const target = page.locator(`.react-flow__node[data-id="${targetNode}"] .react-flow__handle.target`);
    const a = await handle.boundingBox();
    const b = await target.boundingBox();
    if (!a || !b) throw new Error("Handle nicht gefunden");
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  await connect("start", "next", "implementer");
  await connect("implementer", "next", "done");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.getByText("Workflow ist gültig")).toBeVisible();

  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("ungespeichert")).toHaveCount(0);
  const saved = await api<{ definition: { nodes: Record<string, unknown>; edges: { from: string; to: string }[] } }>("GET", "/api/definitions/workflows/e2e-flow");
  expect(Object.keys(saved.definition.nodes).sort()).toEqual(["done", "implementer", "start"]);
  expect(saved.definition.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "start", to: "implementer" }), expect.objectContaining({ from: "implementer", to: "done" })]));
});

test("Testlauf im Editor zeigt den simulierten Pfad", async ({ page }) => {
  const q = await login(page);
  await page.goto(`/workflows/feature-triage${q}`);
  await page.getByRole("button", { name: "Testlauf" }).click();
  await page.locator("select").filter({ has: page.locator("option[value=klein]") }).selectOption("klein");
  await page.getByRole("button", { name: "Simulieren" }).click();
  await expect(page.getByText("Ergebnis:")).toBeVisible();
  await expect(page.locator(".rounded.bg-slate-100", { hasText: "Implementer (klein)" })).toBeVisible();
});

test("Run aus der Web-UI starten, live verfolgen, reviewen und übernehmen", async ({ page }) => {
  const q = await login(page);
  const { project } = state();
  await page.goto(`/workflows${q}`);
  await page.locator("section", { hasText: "Feature mit Multi-Review" }).getByRole("button", { name: "Starten" }).click();
  await page.getByLabel("Auftrag *").fill("Newsletter-Anmeldung mit Double-Opt-in");
  await page.getByRole("button", { name: "Starten", exact: true }).last().click();
  await expect(page).toHaveURL(/\/runs\/run_/);
  const id = /\/runs\/(run_[a-z0-9]+)/.exec(page.url())?.[1] ?? "";
  await expect(page.getByText("Newsletter-Anmeldung mit Double-Opt-in")).toBeVisible();
  await waitStatus(id, ["review_pending"]);
  await expect(page.getByText("Review ausstehend").first()).toBeVisible();
  await page.getByRole("link", { name: "Review" }).click();
  await expect(page.getByText("Geänderte Dateien", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /src\/newsletter/ }).click();
  await expect(page.locator(".diff-line").first()).toBeVisible();
  await page.getByRole("button", { name: "Alles übernehmen" }).click();
  await expect(page.getByText(/Entschieden: übernommen/)).toBeVisible();
  expect(existsSync(join(project, "src/newsletter-anmeldung-mit-double-opt-in.js"))).toBe(true);
  expect(readFileSync(join(project, "src/newsletter-anmeldung-mit-double-opt-in.js"), "utf8")).not.toContain("console.log");
});

test("Freigabe über die Inbox beantworten", async ({ page }) => {
  const q = await login(page);
  const { project } = state();
  const { id } = await api<{ id: string }>("POST", "/api/runs", { workflowId: "big-feature", projectDir: project, input: { prompt: "Bestellhistorie" }, origin: "api" });
  await waitStatus(id, ["waiting_input"]);
  await page.goto(`/inbox${q}`);
  await expect(page.getByText("Plan freigeben?")).toBeVisible();
  await page.getByRole("button", { name: "freigegeben" }).click();
  await waitStatus(id, ["review_pending", "failed"]);
  const run = await api<{ status: string; steps: { nodeType: string }[] }>("GET", `/api/runs/${id}`);
  expect(run.status).toBe("review_pending");
  expect(run.steps.filter((s) => s.nodeType === "map-item")).toHaveLength(3);
});

test("Agent bearbeiten und speichern", async ({ page }) => {
  const q = await login(page);
  await page.goto(`/agents/security-reviewer${q}`);
  await page.getByLabel("Beschreibung").fill("Prüft Änderungen auf Sicherheitslücken – geändert im E2E-Test.");
  await page.getByRole("button", { name: "Werkzeuge & Rechte" }).click();
  await page.getByRole("button", { name: "Regel" }).click();
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText(/Gespeichert \(Version/)).toBeVisible();
  const saved = await api<{ definition: { description: string; permissions: { rules: unknown[] } } }>("GET", "/api/definitions/agents/security-reviewer");
  expect(saved.definition.description).toContain("E2E-Test");
  expect(saved.definition.permissions.rules).toHaveLength(1);
});
