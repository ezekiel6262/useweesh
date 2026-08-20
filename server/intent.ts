import type { VercelRequest, VercelResponse } from "@vercel/node";
import { statusLabel } from "@intentos/sdk";
import { send } from "./_lib/json.js";
import { loadLiveDeployment, reader } from "./_lib/runtime.js";

const KINDS = ["SWAP", "BASKET", "REBALANCE", "RWA_ONBOARD", "BATCH"];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    const id = String(req.query.id ?? "");
    if (!id.startsWith("0x") || id.length !== 66) return send(res, 400, { error: "missing intent id" });
    const client = reader();
    const deployment = loadLiveDeployment();
    const record = await client.getIntent(id as `0x${string}`);
    if (!record.status) return send(res, 404, { error: "intent not on this deployment" });
    const bids = await client.getBids(id as `0x${string}`);
    send(res, 200, {
      ...record,
      kindLabel: KINDS[record.kind] ?? String(record.kind),
      statusLabel: statusLabel(record.status),
      bids: bids.map((b) => ({
        bidId: b.bidId,
        solver: b.solver,
        feeBps: b.feeBps,
        etaSeconds: b.etaSeconds,
        withdrawn: b.withdrawn,
        guaranteedOut: b.guaranteedOut,
      })),
      explorer: "https://web3.okx.com/explorer/xlayer-testnet",
      contracts: deployment.contracts,
      chainId: deployment.chainId,
    });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
