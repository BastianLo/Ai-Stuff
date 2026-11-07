/**
 * Kombinierter Einstiegspunkt für opencode v1 und v2 (PLAN.md 5.5.4):
 * v2 liest `id` und ruft `setup()` auf, v1 (≥ 1.18.29) ruft `server()` auf.
 * Versionsspezifischer Code wird erst im jeweiligen Pfad dynamisch geladen.
 */
const plugin = {
  id: "aiflow",
  async setup(ctx: unknown) {
    const { setupV2 } = await import("./v2/server.js");
    return setupV2(ctx as Parameters<typeof setupV2>[0]);
  },
  async server(input: unknown, options?: unknown) {
    const { serverV1 } = await import("./v1/server.js");
    return serverV1(input as Parameters<typeof serverV1>[0], options);
  },
};

export default plugin;
