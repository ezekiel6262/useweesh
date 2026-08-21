import type { VercelRequest, VercelResponse } from "@vercel/node";
import { catalogFromDeployment } from "@intentos/sdk";
import { XLAYER_TESTNET_DEPLOYMENT } from "../server/_lib/xlayerTestnet";

export const config = { maxDuration: 60 };

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const deployment = XLAYER_TESTNET_DEPLOYMENT;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.status(200).send(
    JSON.stringify(
      {
        network: deployment.network,
        chainId: deployment.chainId,
        rpc: process.env.INTENTOS_RPC ?? process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech",
        explorer: "https://web3.okx.com/explorer/xlayer-testnet",
        contracts: deployment.contracts,
        tokens: deployment.tokens,
        routers: deployment.routers,
        roles: deployment.roles ?? {},
        assets: catalogFromDeployment(deployment).all(),
        now: Math.floor(Date.now() / 1000),
      },
      (_k, v) => (typeof v === "bigint" ? `n:${v}` : v),
    ),
  );
}
