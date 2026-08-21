import type { VercelRequest, VercelResponse } from "@vercel/node";
import { type Address, type Hex } from "viem";
import { ERC20_ABI, INTENT_REGISTRY_ABI } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { loadLiveDeployment, operatorClient } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

/**
 * Coordinator-paid submit. The owner has already signed EIP-712 Submit (and optionally permit).
 * This is the gasless path: the connected wallet never sends a transaction.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as {
      owner?: Address;
      salt?: Hex;
      kind?: number;
      outcomeHash?: Hex;
      policyHash?: Hex;
      legCount?: number;
      auctionEndsAt?: string | number;
      deadline?: string | number;
      integrator?: Address;
      metadataURI?: string;
      signature?: Hex;
      permit?: {
        token: Address;
        owner: Address;
        spender: Address;
        value: string;
        deadline: string;
        signature: Hex;
      };
    };

    if (!body.owner || !body.salt || !body.outcomeHash || !body.policyHash || !body.signature) {
      return send(res, 400, { error: "missing submitFor fields" });
    }

    const client = operatorClient("COORDINATOR_PRIVATE_KEY");
    const deployment = loadLiveDeployment();
    const registry = deployment.contracts.intentRegistry!;
    const zero = "0x0000000000000000000000000000000000000000" as Address;

    if (body.permit?.signature) {
      const raw = body.permit.signature.replace(/^0x/, "");
      const r = `0x${raw.slice(0, 64)}` as Hex;
      const s = `0x${raw.slice(64, 128)}` as Hex;
      let v = parseInt(raw.slice(128, 130), 16);
      if (v < 27) v += 27;
      await client.write(body.permit.token, ERC20_ABI as any, "permit", [
        body.permit.owner,
        body.permit.spender,
        BigInt(body.permit.value),
        BigInt(body.permit.deadline),
        v,
        r,
        s,
      ]);
    }

    const hash = await client.write(registry, INTENT_REGISTRY_ABI, "submitFor", [
      body.owner,
      body.salt,
      body.kind ?? 0,
      body.outcomeHash,
      body.policyHash,
      body.legCount ?? 1,
      BigInt(body.auctionEndsAt ?? 0),
      BigInt(body.deadline ?? 0),
      body.integrator && body.integrator !== "0x" ? body.integrator : zero,
      body.metadataURI ?? "",
      body.signature,
    ]);

    send(res, 200, { ok: true, hash });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
