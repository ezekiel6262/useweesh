import type { VercelRequest, VercelResponse } from "@vercel/node";
import { type Address, type Hex } from "viem";
import { INTENT_REGISTRY_ABI } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { operatorClient } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  try {
    const body = (readBody(req) ?? {}) as {
      owner?: Address;
      key?: Address;
      expiresAt?: string;
      kinds?: number;
      signature?: Hex;
    };
    if (!body.owner || !body.key || !body.expiresAt || !body.signature) {
      return send(res, 400, { error: "missing session fields" });
    }
    const client = operatorClient("COORDINATOR_PRIVATE_KEY");
    const hash = await client.write(client.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "authorizeSession", [
      body.owner,
      body.key,
      BigInt(body.expiresAt),
      body.kinds ?? 0,
      body.signature,
    ]);
    send(res, 200, { ok: true, hash });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
