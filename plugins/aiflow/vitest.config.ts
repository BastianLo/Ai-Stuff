import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@aiflow/core": pkg("core"),
      "@aiflow/engine": pkg("engine"),
      "@aiflow/store": pkg("store"),
      "@aiflow/workspace-git": pkg("workspace-git"),
      "@aiflow/runtime-opencode": pkg("runtime-opencode"),
      "@aiflow/testkit": pkg("testkit"),
      "@aiflow/server": pkg("server"),
      "@aiflow/client": pkg("client"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/web/**", "packages/opencode-plugin/src/v*/tui*"],
    },
  },
});
