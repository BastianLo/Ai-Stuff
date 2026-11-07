import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { examplesDir } from "./harness.js";

/** Legt eine git-Kopie von `examples/demo-repo` an (für Tests, Demos und Screenshots). */
export function createDemoProject(target = mkdtempSync(join(tmpdir(), "aiflow-demo-"))): string {
  cpSync(join(examplesDir, "demo-repo"), target, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...args], { cwd: target, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Initialer Stand");
  return target;
}
