import { OpenCode } from "@opencode/client";
import { basicAuth } from "../common/util.js";
import type { V2Client } from "./driver.js";

/** Bindet den offiziellen v2-Client an die schmale Schnittstelle des Treibers. */
export function createV2Client(baseUrl: string, password: string): V2Client {
  const client = OpenCode.make({ baseUrl, headers: { authorization: basicAuth(password) } });
  // Der generierte Client bietet dieselben Methoden mit präziseren Typen; der Treiber liest Antworten tolerant.
  return client as unknown as V2Client;
}
