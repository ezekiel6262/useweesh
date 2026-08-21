import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { INTENT_REGISTRY_ABI } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { liveObservations } from "./_lib/observations.js";
import { handleRecurring, tickDueJobs } from "./_lib/recurring.js";
import { loadLiveDeployment, operatorClient } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

/**
 * Hobby plan allows 12 serverless functions. Extra protocol surfaces share this one route.
 * kind = observations | recurring | session | challenge | tick
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const body = req.method === "POST" ? ((readBody(req) ?? {}) as Record<string, unknown>) : {};
  const kind = String(req.query.kind ?? body.kind ?? (req.method === "GET" ? "observations" : ""));

  try {
    if (!kind && req.method === "GET") {
      const tick = await tickDueJobs().catch(() => ({ ran: [] }));
      const observations = await liveObservations();
      return send(res, 200, { ...observations, ...tick });
    }
    if (kind === "observations") {
      return send(res, 200, await liveObservations());
    }
    if (kind === "recurring" || kind === "tick") {
      if (kind === "tick") {
        return send(res, 200, await tickDueJobs());
      }
      return handleRecurring(req, res);
    }
    if (kind === "session") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const owner = body.owner as Address;
      const key = body.key as Address;
      const expiresAt = String(body.expiresAt ?? "");
      const signature = body.signature as Hex;
      if (!owner || !key || !expiresAt || !signature) return send(res, 400, { error: "missing session fields" });
      const client = operatorClient("COORDINATOR_PRIVATE_KEY");
      const hash = await client.write(client.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "authorizeSession", [
        owner,
        key,
        BigInt(expiresAt),
        Number(body.kinds ?? 0),
        signature,
      ]);
      return send(res, 200, { ok: true, hash });
    }
    if (kind === "challenge") {
      if (req.method !== "POST") return send(res, 405, { error: "POST only" });
      const intentId = body.intentId as Hex;
      const bidId = Number(body.bidId);
      if (!intentId || Number.isNaN(bidId)) return send(res, 400, { error: "intentId and bidId required" });
      const deployment = loadLiveDeployment();
      const data = encodeFunctionData({
        abi: INTENT_REGISTRY_ABI,
        functionName: "challengeSelection",
        args: [intentId, bidId],
      });
      return send(res, 200, { to: deployment.contracts.intentRegistry, data, value: "0x0" });
    }
    return send(res, 400, { error: "unknown kind" });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
