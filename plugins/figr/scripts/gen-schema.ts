/** Erzeugt figr.schema.json aus dem Zod-Schema (plan.md 6.2, M7). Aufruf: pnpm schema */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ProfileSchema, RawConfigSchema } from "../src/config/schema.ts";

const profile = z.toJSONSchema(ProfileSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
const root = z.toJSONSchema(RawConfigSchema, { io: "input", unrepresentable: "any" }) as { properties: Record<string, unknown> } & Record<string, unknown>;
delete profile.$schema;
/** Profile dürfen per extends nur Teile setzen: Pflichtfelder gelten erst nach dem Zusammenführen (FiGr prüft das beim Laden). */
const relax = (node: unknown): void => {
  if (Array.isArray(node)) node.forEach(relax);
  else if (node && typeof node === "object") {
    delete (node as Record<string, unknown>).required;
    Object.values(node).forEach(relax);
  }
};
relax(profile);
const profileProps = { ...(profile.properties as Record<string, unknown>), extends: { type: "string", description: "Name eines anderen Profils, von dem geerbt wird" } };
root.properties.profiles = { type: "object", additionalProperties: { ...profile, properties: profileProps, required: [] } };
root.title = "FiGr configuration (.opencode/figr.jsonc)";
writeFileSync(new URL("../figr.schema.json", import.meta.url), `${JSON.stringify(root, null, 2)}\n`);
console.log("figr.schema.json geschrieben");
