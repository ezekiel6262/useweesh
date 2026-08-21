import type { VercelRequest, VercelResponse } from "@vercel/node";
import { INTENT_KIND_LABEL, statusLabel, type Address, type Hex } from "@intentos/sdk";
import { send } from "./_lib/json.js";
import { reader } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const owner = String(req.query.owner ?? "");
    if (!owner.startsWith("0x") || owner.length !== 42) {
      return send(res, 400, { error: "owner must be a 20-byte address" });
    }
    const client = reader();
    const limit = Math.min(50, Number(req.query.limit ?? 24) || 24);
    const ids = await client.listIntentsOf(owner as Address, limit);
    const intents = await Promise.all(
      ids.map(async (intentId: Hex) => {
        const record = await client.getIntent(intentId);
        const bids = await client.getBids(intentId);
        return {
          intentId,
          owner: record.owner,
          kind: record.kind,
          kindLabel: INTENT_KIND_LABEL[record.kind] ?? String(record.kind),
          status: record.status,
          statusLabel: statusLabel(record.status),
          selectedSolver: record.selectedSolver,
          bidCount: bids.filter((b) => !b.withdrawn).length,
          createdAt: Number(record.createdAt ?? 0),
          auctionEndsAt: Number(record.auctionEndsAt),
          deadline: Number(record.deadline),
        };
      }),
    );
    send(res, 200, { owner, intents });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
