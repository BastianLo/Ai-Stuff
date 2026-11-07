/** Paketgrenzen aus PLAN.md, Kapitel 6.1 */
const pkg = (n) => `^packages/${n}/`;
const forbid = (name, from, to) => ({ name, severity: "error", from: { path: from }, to: { path: to } });
module.exports = {
  forbidden: [
    forbid("core-is-leaf", pkg("core"), "^packages/(?!core/)"),
    forbid("engine-only-core", pkg("engine"), "^packages/(?!engine/|core/)"),
    forbid("store-only-core", pkg("store"), "^packages/(?!store/|core/)"),
    forbid("workspace-only-core", pkg("workspace-git"), "^packages/(?!workspace-git/|core/)"),
    forbid("runtime-only-core-engine", pkg("runtime-opencode"), "^packages/(?!runtime-opencode/|core/|engine/)"),
    forbid("runtime-v1-not-v2", "^packages/runtime-opencode/src/v1/", "^packages/runtime-opencode/src/v2/"),
    forbid("runtime-v2-not-v1", "^packages/runtime-opencode/src/v2/", "^packages/runtime-opencode/src/v1/"),
    forbid("client-only-core", pkg("client"), "^packages/(?!client/|core/)"),
    forbid("cli-only-client", pkg("cli"), "^packages/(?!cli/|client/|core/|server/)"),
    forbid("plugin-only-client", pkg("opencode-plugin"), "^packages/(?!opencode-plugin/|client/|core/)"),
    forbid("plugin-v1-not-v2", "^packages/opencode-plugin/src/v1/", "^packages/opencode-plugin/src/v2/"),
    forbid("plugin-v2-not-v1", "^packages/opencode-plugin/src/v2/", "^packages/opencode-plugin/src/v1/"),
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|dist|packages/web)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
  },
};
