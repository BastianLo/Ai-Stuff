import type { GateConfig, ProfileConfig } from "../config/schema.ts";

/** Agenten, die ein Gate erzeugen bzw. ändern dürfen (Phase-Agenten inkl. Erzeugungsmuster). */
export function phaseAgents(gate: GateConfig): string[] {
  const out = new Set(gate.agents);
  const p = gate.produce;
  if (p?.pattern === "multi-plan") {
    for (const a of p.planners) out.add(a);
    out.add(p.synthesizer);
  } else if (p?.pattern === "single" || p?.pattern === "best-of-n") out.add(p.agent);
  return [...out];
}

/** Topologische Reihenfolge der Gates; wirft bei Zyklen nicht, sondern meldet sie. */
export function gateOrder(profile: ProfileConfig): { order: string[]; cycle?: string[] } {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  let cycle: string[] | undefined;
  const visit = (name: string, trail: string[]): void => {
    const s = state.get(name);
    if (s === "done") return;
    if (s === "visiting") {
      cycle ??= [...trail.slice(trail.indexOf(name)), name];
      return;
    }
    state.set(name, "visiting");
    for (const r of profile.gates[name]?.requires ?? []) if (profile.gates[r]) visit(r, [...trail, name]);
    state.set(name, "done");
    order.push(name);
  };
  for (const name of Object.keys(profile.gates)) visit(name, []);
  return cycle ? { order, cycle } : { order };
}
