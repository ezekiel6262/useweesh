import type { DeploymentFile } from "@intentos/intent-ai";

/**
 * The asset universe the hosted playground parses against.
 *
 * A live deployment is supplied through `INTENTOS_DEPLOYMENT_JSON`; without one the playground
 * falls back to this preview universe so the parser can still be exercised. The addresses below
 * are deterministic placeholders, **not** real token addresses — the parser needs something to
 * resolve symbols to, and inventing plausible-looking mainnet addresses would be worse than
 * obviously fake ones. Nothing here is ever signed or submitted.
 */
const RAW_PREVIEW: DeploymentFile = {
  network: "preview",
  chainId: 195,
  contracts: {},
  tokens: {
    USDT: "0x00000000000000000000000000000000pre0001" as `0x${string}`,
    TSLAx: "0x00000000000000000000000000000000pre0021" as `0x${string}`,
    NVDAx: "0x00000000000000000000000000000000pre0022" as `0x${string}`,
    AAPLx: "0x00000000000000000000000000000000pre0023" as `0x${string}`,
    SPYx: "0x00000000000000000000000000000000pre0024" as `0x${string}`,
    GOOGLx: "0x00000000000000000000000000000000pre0025" as `0x${string}`,
  },
  routers: [],
};

/** Placeholder addresses must still be valid hex, or the schema rejects every draft. */
export function normalise(deployment: DeploymentFile): DeploymentFile {
  const tokens: Record<string, `0x${string}`> = {};
  let index = 1;
  for (const symbol of Object.keys(deployment.tokens)) {
    const given = deployment.tokens[symbol]!;
    tokens[symbol] = /^0x[0-9a-fA-F]{40}$/.test(given)
      ? given
      : (`0x${index.toString(16).padStart(40, "0")}` as `0x${string}`);
    index += 1;
  }
  return { ...deployment, tokens };
}

export const PREVIEW_UNIVERSE = normalise(RAW_PREVIEW);
