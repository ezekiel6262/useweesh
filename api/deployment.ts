import { catalogFromDeployment } from "@intentos/sdk";
import { XLAYER_TESTNET_DEPLOYMENT } from "../server/_lib/xlayerTestnet";

export const config = { maxDuration: 60 };

export default async function handler(_req: unknown, res?: { statusCode: number; setHeader: Function; end: Function }) {
  const deployment = XLAYER_TESTNET_DEPLOYMENT;
  const payload = JSON.stringify(
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
  );
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  };
  if (res && typeof res.end === "function") {
    res.statusCode = 200;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(payload);
    return;
  }
  return new Response(payload, { status: 200, headers });
}
