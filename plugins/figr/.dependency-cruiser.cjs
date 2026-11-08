/** Schichtgrenzen aus plan.md, Abschnitt 14.2 */
const forbid = (name, from, to) => ({ name, severity: "error", from: { path: from }, to: { path: to } });
module.exports = {
  forbidden: [
    forbid("core-is-pure", "^src/core/", "^src/(?!core/|util/(hash|text|pattern|errors)\\.ts|config/schema\\.ts)"),
    forbid("core-no-node-io", "^src/core/", "^(node:)?(fs|child_process|net|http|https)$"),
    forbid("config-no-host", "^src/config/", "^src/(host|state|patterns|fanout|workspace)/"),
    forbid("only-host-knows-opencode", "^src/(?!host/)", "@opencode/plugin"),
    forbid("patterns-no-host-adapter", "^src/(patterns|fanout|state)/", "^src/host/(v2|tools)\\.ts"),
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
  },
};
