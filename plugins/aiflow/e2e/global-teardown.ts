import { state } from "./env";

export default function globalTeardown(): void {
  try {
    process.kill(state().pid, "SIGTERM");
  } catch {
    /* bereits beendet */
  }
}
