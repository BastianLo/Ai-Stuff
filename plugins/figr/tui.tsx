/** @jsxImportSource @opentui/solid */
import type { Plugin } from "@opencode/plugin/tui";
import { createSignal, For, Show } from "solid-js";
import { readStatus, resolveWorkDir, sidebarLines, type StatusSnapshot } from "./src/tui/status-file.ts";

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/**
 * TUI-Teil von FiGr (plan.md 12): Seitenleiste, Prompt-Zeile und Toasts.
 * Der Zustand kommt aus `workDir/<sid>/status.json`, den der Server-Teil schreibt. Befehle registriert der Server-Teil.
 */
async function setup(context: Context): Promise<() => void> {
  const options = (context.options ?? {}) as { config?: string };
  const project = context.location?.directory ?? process.cwd();
  const workDir = resolveWorkDir(project, options.config ? { config: options.config } : {});
  const [tick, setTick] = createSignal(0);
  const seenToasts = new Map<string, number>();

  const snapshotFor = (sessionID: string | undefined): StatusSnapshot | undefined => {
    tick();
    if (!sessionID) return undefined;
    const root = context.data.session.root(sessionID);
    return readStatus(workDir, root);
  };

  const timer = setInterval(() => {
    setTick((n) => n + 1);
    for (const s of context.data.session.list()) {
      if (s.parentID) continue;
      const snap = readStatus(workDir, s.id);
      if (!snap) continue;
      const last = seenToasts.get(s.id) ?? snap.updatedAt - 1;
      for (const t of snap.toasts) if (t.at > last) context.ui.toast.show({ title: "FiGr", message: t.message.replace(/^FiGr:\s*/, ""), variant: "info", sessionID: s.id });
      seenToasts.set(s.id, Math.max(last, ...snap.toasts.map((t) => t.at)));
    }
  }, 1000);

  const disposers = [
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => (
        <Show when={snapshotFor(props.sessionID)}>
          {(snap) => (
            <box flexDirection="column">
              <For each={sidebarLines(snap())}>{(line) => <text fg={context.theme.text.base}>{line}</text>}</For>
            </box>
          )}
        </Show>
      ),
    }),
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => (
        <Show when={snapshotFor(props.sessionID)}>{(snap) => <text fg={context.theme.text.muted}>{snap().compact}</text>}</Show>
      ),
    }),
  ];
  return () => {
    clearInterval(timer);
    for (const d of disposers) d();
  };
}

export default { id: "figr", setup };
