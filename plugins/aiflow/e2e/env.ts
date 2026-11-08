import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const PORT = 5788;
export const BASE = `http://127.0.0.1:${PORT}`;
export const ROOT = join(tmpdir(), "aiflow-e2e");
export const stateFile = join(ROOT, "state.json");

export function state(): { project: string; token: string; pid: number } {
  return JSON.parse(readFileSync(stateFile, "utf8")) as { project: string; token: string; pid: number };
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${state().token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
