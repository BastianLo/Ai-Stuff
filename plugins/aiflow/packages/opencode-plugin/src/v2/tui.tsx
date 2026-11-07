/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createSignal, For, Show } from "solid-js";
import { TuiState, type TuiSnapshot } from "../core/tui-state.js";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/** TUI-Teil für opencode v2: Slash-Commands, Seitenleiste, Statuszeile, Session-Panel, Dialoge (PLAN.md 10). */
export async function setupTuiV2(context: Context): Promise<() => void> {
  const state = new TuiState(context.options, context.location?.directory ?? process.cwd());
  const [snapshot, setSnapshot] = createSignal<TuiSnapshot>(state.current);
  state.onChange((s) => setSnapshot({ ...s }));
  state.onAttention = (title, message) => {
    context.ui.toast.show({ title, message, variant: "info" });
    void context.attention.notify({ title, message, notification: { when: "blurred" }, sound: { name: "done", when: "blurred" } });
  };
  await state.start();

  const answerInbox = async (): Promise<void> => {
    const items = snapshot().inbox;
    if (items.length === 0) {
      context.ui.toast.show({ message: "AiFlow: Nichts offen.", variant: "info" });
      return;
    }
    const item = await context.ui.dialog.select({ title: "AiFlow · Offene Punkte", options: items.map((i) => ({ title: i.title, value: i, description: i.question })) });
    if (!item) return;
    if (item.kind === "review") {
      const action = await context.ui.dialog.select({
        title: `Review · ${item.question}`,
        options: [
          { title: "Übernehmen", value: "apply" },
          { title: "Im Browser reviewen", value: "browser" },
          { title: "Als Branch behalten", value: "branch" },
          { title: "Verwerfen", value: "discard" },
        ],
      });
      if (!action) return;
      if (action === "browser") state.bridge.openBrowser(`${await state.bridge.configureUrl()}&next=/runs/${item.runId}/review`);
      else await state.bridge.client.review(item.runId, { action: action as "apply" | "branch" | "discard" });
    } else {
      const option = await context.ui.dialog.select({ title: item.question, options: item.options.map((o) => ({ title: o, value: o })) });
      if (!option) return;
      const text = item.allowFreeText ? await context.ui.dialog.prompt({ title: "Anmerkung (optional)", placeholder: "Freitext" }) : undefined;
      await state.bridge.client.answer(item.runId, item.id, option, text || undefined);
    }
    await state.refresh();
  };

  const startWorkflow = async (workflowId: string, prompt: string | undefined): Promise<void> => {
    const text = prompt?.trim() || (await context.ui.dialog.prompt({ title: "AiFlow · Auftrag", placeholder: "Was soll umgesetzt werden?" }));
    if (!text) return;
    const runId = await state.bridge.start(workflowId, text);
    context.ui.toast.show({ title: "AiFlow", message: `Run ${runId} gestartet`, variant: "success" });
    await state.refresh();
  };

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "aiflow.configure",
        title: "AiFlow: Konfiguration öffnen",
        palette: true,
        slash: { name: "aiflow-configure" },
        run: async () => state.bridge.openBrowser(await state.bridge.configureUrl()),
      },
      { id: "aiflow.status", title: "AiFlow: Status", palette: true, slash: { name: "aiflow-status" }, run: () => void context.ui.panel.open("aiflow.run") },
      { id: "aiflow.inbox", title: "AiFlow: Offene Punkte", palette: true, slash: { name: "aiflow-inbox" }, run: () => answerInbox() },
      {
        id: "aiflow.run",
        title: "AiFlow: Workflow starten",
        palette: true,
        slash: { name: "aiflow-run", arguments: true },
        run: async (input) => {
          const workflow = await context.ui.dialog.select({ title: "Workflow", options: snapshot().workflows.map((w) => ({ title: w.name, value: w.id, description: w.description })) });
          if (workflow) await startWorkflow(workflow, input);
        },
      },
      {
        id: "aiflow.cancel",
        title: "AiFlow: Run abbrechen",
        palette: true,
        slash: { name: "aiflow-cancel" },
        run: async () => {
          const run = snapshot().run;
          if (run && (await context.ui.dialog.confirm({ title: "Run abbrechen?", message: run.workflow.name }))) await state.bridge.client.cancelRun(run.id);
        },
      },
      // Ein Slash-Command pro Workflow; der Prompt geht unverändert an AiFlow (kein LLM-Aufruf).
      ...snapshot().workflows.map((w) => ({
        id: `aiflow.wf.${w.id}`,
        title: `AiFlow: ${w.name}`,
        slash: { name: w.command, arguments: true as const },
        run: (input?: string) => startWorkflow(w.id, input),
      })),
    ],
  }));

  const Lines = (props: { limit?: number }) => (
    <box flexDirection="column">
      <For each={snapshot().lines.slice(0, props.limit ?? 30)}>{(line) => <text fg={context.theme.text.base}>{line}</text>}</For>
    </box>
  );

  const disposers = [
    context.ui.slot({ append: "sidebar.content", render: () => <Lines limit={14} /> }),
    context.ui.slot({ append: "prompt.footer.status", render: () => <text fg={context.theme.text.muted}>{state.compactStatus()}</text> }),
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "aiflow.run"}>
          <box flexDirection="column" padding={1}>
            <Lines />
            <Show when={snapshot().run}>{(run) => <text fg={context.theme.text.muted}>{`Web-Ansicht: ${state.bridge.options.url}/runs/${run().id}`}</text>}</Show>
          </box>
        </Show>
      ),
    }),
  ];
  return () => {
    for (const d of disposers) d();
    state.dispose();
  };
}
