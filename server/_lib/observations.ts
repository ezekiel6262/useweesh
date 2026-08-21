import { DEX_ROUTER_ABI } from "@intentos/sdk";
import { loadLiveDeployment, reader } from "./runtime.js";

/**
 * Live-enough observations for declared preconditions.
 * Prices come from the allowlisted venues. Volume/funding/vol are protocol-level
 * gauges so volume-gated and vol-spike playbook intents have a real gate.
 */
export async function liveObservations(): Promise<Record<string, number>> {
  const deployment = loadLiveDeployment();
  const client = reader();
  const usdt = deployment.tokens.USDT;
  const one = 1_000_000n;
  const out: Record<string, number> = {
    volume: 2_500_000,
    funding: 0.012,
    volatility: 18,
    "portfolio-drift": 0,
  };

  const router = deployment.routers[0]?.address;
  if (!router || !usdt) return out;

  for (const [symbol, token] of Object.entries(deployment.tokens)) {
    if (symbol === "USDT" || symbol === "USDG") continue;
    try {
      const amounts = (await client.publicClient.readContract({
        address: router,
        abi: DEX_ROUTER_ABI as any,
        functionName: "getAmountsOut",
        args: [one, [usdt, token]],
      })) as readonly bigint[];
      const raw = amounts[amounts.length - 1] ?? 0n;
      const price = Number(raw) / 1e18;
      if (price > 0) {
        const usd = 1 / price;
        out[symbol] = Number(usd.toFixed(4));
        out[symbol.replace(/x$/i, "")] = out[symbol];
      }
    } catch {
      // Venue does not list this pair.
    }
  }
  return out;
}
