import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeFunctionData, type Hex } from "viem";
import { INTENT_REGISTRY_ABI } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { loadLiveDeployment } from "./_lib/runtime.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  try {
    const body = (readBody(req) ?? {}) as { intentId?: Hex; bidId?: number };
    if (!body.intentId || body.bidId === undefined) return send(res, 400, { error: "intentId and bidId required" });
    const deployment = loadLiveDeployment();
    const data = encodeFunctionData({
      abi: INTENT_REGISTRY_ABI,
      functionName: "challengeSelection",
      args: [body.intentId, body.bidId],
    });
    send(res, 200, { to: deployment.contracts.intentRegistry, data, value: "0x0" });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
