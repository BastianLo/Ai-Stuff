import { test } from "node:test";
import assert from "node:assert/strict";
import { health } from "../src/server.js";

test("health", () => {
  assert.deepEqual(health(), { ok: true });
});
