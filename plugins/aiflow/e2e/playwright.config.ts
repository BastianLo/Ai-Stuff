import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  use: { baseURL: "http://127.0.0.1:5788", viewport: { width: 1440, height: 900 }, trace: "off" },
});
