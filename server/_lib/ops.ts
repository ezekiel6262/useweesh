// @ts-nocheck
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { INTENT_REGISTRY_ABI } from "@intentos/sdk";
import { readBody, send } from "./json.js";
import { liveObservations } from "./observations.js";
import { handleRecurring, tickDueJobs } from "./recurring.js";
import { loadLiveDeployment, operatorClient } from "./runtime.js";

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
    if (kind === "slashes") {
      const deployment = loadLiveDeployment();
      const client = reader();
      const latest = await client.publicClient.getBlockNumber();
      const fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
      const logs = await client.publicClient.getLogs({
        address: deployment.contracts.solverRegistry as Address,
        fromBlock,
        toBlock: "latest",
        event: {
          type: "event",
          name: "SolverSlashed",
          inputs: [
            { name: "solver", type: "address", indexed: true },
            { name: "amount", type: "uint256", indexed: false },
            { name: "recipient", type: "address", indexed: true },
            { name: "reason", type: "string", indexed: false },
          ],
        },
      });
      return send(res, 200, {
        slashes: logs.slice(-12).reverse().map((log) => ({
          solver: log.args.solver,
          amount: (log.args.amount as bigint).toString(),
          recipient: log.args.recipient,
          reason: log.args.reason,
          txHash: log.transactionHash,
          blockNumber: log.blockNumber?.toString(),
        })),
      });
    }
    if (kind === "bundler") {
      // Live path is coordinator-paid submitFor + ERC-1271 / session keys.
      // There is no canonical ERC-4337 EntryPoint on this 1952 deployment.
      return send(res, 200, {
        entryPoint: null,
        mode: "submitFor+erc1271",
        relay: "/api/relay",
        session: "/api/health?kind=session",
        declare: "/api/declare",
        note: "POST EIP-712 Submit (and optional permit) to /api/relay. Smart-account owners are verified with ERC-1271 on IntentRegistry.submitFor. Authorize a session key via kind=session for recurring jobs.",
      });
    }
    return send(res, 400, { error: "unknown kind" });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
