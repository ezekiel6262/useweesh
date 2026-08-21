// @ts-nocheck
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { explainDraft, hashOutcome, hashPolicy, parseIntent, retimeDraft, type Address } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { catalog, reader } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as { prompt?: string; recipient?: string };
    const prompt = String(body.prompt ?? "").trim();
    const recipient = (body.recipient ?? "0x0000000000000000000000000000000000000001") as Address;
    if (!prompt) return send(res, 400, { error: "missing prompt" });

    const client = reader();
    const parsed = await parseIntent(prompt, {
      catalog: catalog(),
      recipient,
      now: await client.chainNow(),
      auctionSeconds: 20,
      ttlSeconds: 180,
      quote: makeQuoter(client),
    });

    const draft = retimeDraft(parsed.draft, {
      now: await client.chainNow(),
      auctionSeconds: 20,
      ttlSeconds: 180,
    });

    send(res, 200, {
      parser: parsed.parser,
      model: parsed.model,
      fallbackReason: parsed.fallbackReason,
      assumptions: parsed.assumptions,
      clarifications: parsed.clarifications,
      explanation: explainDraft(draft, { catalog: catalog() }),
      spec: parsed.spec,
      draft,
      outcomeHash: hashOutcome(draft.outcome),
      policyHash: hashPolicy(draft.policy),
    });
  } catch (error) {
    send(res, 400, { error: (error as Error).message });
  }
}

function makeQuoter(client: ReturnType<typeof reader>) {
  const routers = client.deployment.routers;
  return async (tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> => {
    let best = 0n;
    for (const router of routers) {
      try {
        const amounts = (await client.publicClient.readContract({
          address: router.address,
          abi: [
            {
              type: "function",
              name: "getAmountsOut",
              stateMutability: "view",
              inputs: [
                { name: "amountIn", type: "uint256" },
                { name: "path", type: "address[]" },
              ],
              outputs: [{ name: "amounts", type: "uint256[]" }],
            },
          ] as const,
          functionName: "getAmountsOut",
          args: [amountIn, [tokenIn, tokenOut]],
        } as any)) as readonly bigint[];
        const out = amounts[amounts.length - 1]!;
        if (out > best) best = out;
      } catch {
        /* pair not listed */
      }
    }
    if (best === 0n) throw new Error("no venue prices this leg");
    return best;
  };
}
