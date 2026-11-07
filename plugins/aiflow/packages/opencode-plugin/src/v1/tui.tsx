/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createSignal, For } from "solid-js";
import { TuiState, type TuiSnapshot } from "../core/tui-state.js";

/** TUI-Teil für opencode v1: Slash-Commands, Seitenleiste, Statuszeile, Dialoge (PLAN.md 10). */
export async function tuiV1(api: TuiPluginApi, options: unknown): Promise<void> {
  const state = new TuiState(options, api.state.path.worktree || api.state.path.directory);
  const [snapshot, setSnapshot] = createSignal<TuiSnapshot>(state.current);
  state.onChange((s) => setSnapshot({ ...s }));
  state.onAttention = (title, message) => {
    api.ui.toast({ title, message, variant: "info" });
    void api.attention.notify({ title, message, notification: { when: "blurred" } });
  };
  await state.start();
  api.lifecycle.onDispose(() => state.dispose());

  const prompt = (title: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      api.ui.dialog.replace(() => (
        <api.ui.DialogPrompt
          title={title}
          onConfirm={(value) => {
            api.ui.dialog.clear();
            resolve(value);
          }}
          onCancel={() => {
            api.ui.dialog.clear();
            resolve(undefined);
          }}
        />
      ));
    });

  const select = <T,>(title: string, options: { title: string; value: T; description?: string }[]): Promise<T | undefined> =>
    new Promise((resolve) => {
      api.ui.dialog.replace(
        () => (
          <api.ui.DialogSelect
            title={title}
            options={options}
            onSelect={(option) => {
              api.ui.dialog.clear();
              resolve(option.value);
            }}
          />
        ),
        () => resolve(undefined),
      );
    });

  const startWorkflow = async (workflowId: string): Promise<void> => {
    const text = await prompt("AiFlow · Auftrag");
    if (!text) return;
    const runId = await state.bridge.start(workflowId, text);
    api.ui.toast({ title: "AiFlow", message: `Run ${runId} gestartet`, variant: "success" });
  };

  const inbox = async (): Promise<void> => {
    const item = await select("AiFlow · Offene Punkte", snapshot().inbox.map((i) => ({ title: i.title, value: i, description: i.question })));
    if (!item) return;
    if (item.kind === "review") {
      const action = await select("Review", [
        { title: "Übernehmen", value: "apply" as const },
        { title: "Als Branch behalten", value: "branch" as const },
        { title: "Verwerfen", value: "discard" as const },
      ]);
      if (action) await state.bridge.client.review(item.runId, { action });
    } else {
      const option = await select(item.question, item.options.map((o) => ({ title: o, value: o })));
      if (option) await state.bridge.client.answer(item.runId, item.id, option, (await prompt("Anmerkung (optional)")) || undefined);
    }
    await state.refresh();
  };

  // Legacy-Command-API von v1 (Slash-Namen). Argumente unterstützt sie nicht: Der Auftrag kommt per Dialog.
  api.command?.register(() => [
    { title: "AiFlow: Konfiguration öffnen", value: "aiflow.configure", slash: { name: "aiflow-configure" }, onSelect: () => void state.bridge.configureUrl().then((u) => state.bridge.openBrowser(u)) },
    { title: "AiFlow: Offene Punkte", value: "aiflow.inbox", slash: { name: "aiflow-inbox" }, onSelect: () => void inbox() },
    ...snapshot().workflows.map((w) => ({ title: `AiFlow: ${w.name}`, value: `aiflow.wf.${w.id}`, slash: { name: w.command }, onSelect: () => void startWorkflow(w.id) })),
  ]);

  api.slots.register({
    slots: {
      sidebar_content: () => (
        <box flexDirection="column">
          <For each={snapshot().lines.slice(0, 14)}>{(line) => <text>{line}</text>}</For>
        </box>
      ),
      session_prompt_right: () => <text>{state.compactStatus()}</text>,
    },
  });
}
