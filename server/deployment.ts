import type { VercelRequest, VercelResponse } from "@vercel/node";
import { send } from "./_lib/json.js";
import { catalog, loadLiveDeployment, reader, rpcUrl } from "./_lib/runtime.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const deployment = loadLiveDeployment();
    const client = reader();
    const assets = catalog().all();
    send(res, 200, {
      network: deployment.network,
      chainId: deployment.chainId,
      rpc: rpcUrl(),
      explorer: "https://web3.okx.com/explorer/xlayer-testnet",
      contracts: deployment.contracts,
      tokens: deployment.tokens,
      routers: deployment.routers,
      roles: deployment.roles ?? {},
      assets,
      now: await client.chainNow(),
    });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
