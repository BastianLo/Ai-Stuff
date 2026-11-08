/**
 * FiGr – Fixed Guardrails für opencode v2.
 * opencode 2 lädt `<paket>/server` und ruft `setup(ctx)` auf.
 */
import type { Plugin } from "@opencode/plugin";
import { setupV2 } from "./src/host/v2.ts";

const plugin: Plugin.Plugin = {
  id: "figr",
  setup: (ctx) => setupV2(ctx),
};

export default plugin;
