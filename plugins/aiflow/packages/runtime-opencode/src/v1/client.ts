import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { basicAuth } from "../common/util.js";
import type { V1Client } from "./driver.js";

/** Bindet den offiziellen v1-Client an die schmale Schnittstelle des Treibers. */
export function createV1Client(baseUrl: string, password: string): V1Client {
  const client = createOpencodeClient({ baseUrl, headers: { authorization: basicAuth(password) } });
  // Der generierte Client hat dieselben Methoden mit präziseren Typen; die schmale Schnittstelle genügt dem Treiber.
  return client as unknown as V1Client;
}
