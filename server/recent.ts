import type { VercelRequest, VercelResponse } from "@vercel/node";
import { statusLabel, type Hex } from "@intentos/sdk";
import { send } from "./_lib/json.js";
import { reader } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const client = reader();
    const limit = Math.min(20, Number(req.query.limit ?? 8) || 8);
    const ids = await client.listIntentIds(limit);
    const intents = await Promise.all(
      ids.map(async (intentId: Hex) => {
        const record = await client.getIntent(intentId);
        const bids = await client.getBids(intentId);
        return {
          intentId,
          owner: record.owner,
          status: record.status,
          statusLabel: statusLabel(record.status),
          kind: record.kind,
          selectedSolver: record.selectedSolver,
          bidCount: bids.filter((b) => !b.withdrawn).length,
          auctionEndsAt: Number(record.auctionEndsAt),
          deadline: Number(record.deadline),
        };
      }),
    );
    send(res, 200, { intents });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
