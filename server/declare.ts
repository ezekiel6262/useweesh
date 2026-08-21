// @ts-nocheck
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeFunctionData, type Address } from "viem";
import {
  INTENT_REGISTRY_ABI,
  SUBMIT_TYPES,
  computeIntentId,
  explainDraft,
  hashOutcome,
  hashPolicy,
  parseIntent,
  retimeDraft,
  submitDomain,
} from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { catalog, loadLiveDeployment, reader, rpcUrl } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

/**
 * Agent entry: sentence in, calldata out. The agent (or a wallet) still signs.
 * Nothing here submits on the agent's behalf.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as { prompt?: string; recipient?: string };
    const prompt = String(body.prompt ?? "").trim();
    const recipient = body.recipient as Address | undefined;
    if (!prompt) return send(res, 400, { error: "missing prompt" });
    if (!recipient?.startsWith("0x") || recipient.length !== 42) {
      return send(res, 400, { error: "recipient must be the signing account" });
    }

    const deployment = loadLiveDeployment();
    const client = reader();
    const parsed = await parseIntent(prompt, {
      catalog: catalog(),
      recipient,
      now: await client.chainNow(),
      auctionSeconds: 30,
      ttlSeconds: 180,
    });
    const draft = retimeDraft(parsed.draft, {
      now: (await client.chainNow()) + 8,
      auctionSeconds: 30,
      ttlSeconds: 180,
    });
    draft.outcome.recipient = recipient;

    const outcomeHash = hashOutcome(draft.outcome);
    const policyHash = hashPolicy(draft.policy);
    const metadataURI = (draft.metadata.prompt ?? "").slice(0, 500);
    const registry = deployment.contracts.intentRegistry!;
    const data = encodeFunctionData({
      abi: INTENT_REGISTRY_ABI,
      functionName: "submit",
      args: [
        draft.salt,
        draft.outcome.kind,
        outcomeHash,
        policyHash,
        draft.outcome.legs.length,
        draft.auctionEndsAt,
        draft.deadline,
        metadataURI,
      ],
    });
    const intentId = computeIntentId({
      chainId: deployment.chainId,
      registry,
      owner: recipient,
      outcomeHash,
      policyHash,
      salt: draft.salt,
      auctionEndsAt: draft.auctionEndsAt,
      deadline: draft.deadline,
    });
    const nonce = (await client.publicClient.readContract({
      address: registry,
      abi: INTENT_REGISTRY_ABI,
      functionName: "nonces",
      args: [recipient],
    })) as bigint;
    const integrator = "0x0000000000000000000000000000000000000000" as Address;

    send(res, 200, {
      explanation: explainDraft(draft, { catalog: catalog() }),
      clarifications: parsed.clarifications,
      draft,
      outcomeHash,
      policyHash,
      intentId,
      chainId: deployment.chainId,
      rpc: rpcUrl(),
      submit: {
        to: registry,
        data,
        value: "0x0",
      },
      /** Wallet-abstraction path: sign this typed data, then POST /api/relay. */
      submitFor: {
        relay: "/api/relay",
        domain: submitDomain(deployment.chainId, registry),
        types: SUBMIT_TYPES,
        primaryType: "Submit",
        message: {
          owner: recipient,
          kind: draft.outcome.kind,
          outcomeHash,
          policyHash,
          salt: draft.salt,
          auctionEndsAt: draft.auctionEndsAt,
          deadline: draft.deadline,
          legCount: draft.outcome.legs.length,
          integrator,
          metadataURI,
          nonce,
        },
      },
    });
  } catch (error) {
    send(res, 400, { error: (error as Error).message });
  }
}
