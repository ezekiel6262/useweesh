import type { VercelRequest, VercelResponse } from "@vercel/node";
import { statusLabel } from "@intentos/sdk";
import { send } from "./_lib/json.js";
import { reader } from "./_lib/runtime.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const id = String(req.query.id ?? "");
    if (!id.startsWith("0x")) return send(res, 400, { error: "missing id" });
    const client = reader();
    const record = await client.getIntent(id as `0x${string}`);
    const bids = await client.getBids(id as `0x${string}`);
    send(res, 200, {
      ...record,
      statusLabel: statusLabel(record.status),
      bids,
    });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
