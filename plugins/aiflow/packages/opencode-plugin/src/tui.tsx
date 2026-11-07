/** @jsxImportSource @opentui/solid */
/**
 * Kombinierter TUI-Einstiegspunkt: v2 ruft `setup()` auf, v1 ruft `tui()` auf (PLAN.md 5.5.4, Spike S6).
 */
const tuiPlugin = {
  id: "aiflow.tui",
  async setup(context: unknown) {
    const { setupTuiV2 } = await import("./v2/tui.js");
    return setupTuiV2(context as Parameters<typeof setupTuiV2>[0]);
  },
  async tui(api: unknown, options: unknown) {
    const { tuiV1 } = await import("./v1/tui.js");
    return tuiV1(api as Parameters<typeof tuiV1>[0], options);
  },
};

export default tuiPlugin;
