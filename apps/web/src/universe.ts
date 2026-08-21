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
    USDG: "0x00000000000000000000000000000000pre0002" as `0x${string}`,
    TSLAx: "0x00000000000000000000000000000000pre0021" as `0x${string}`,
    NVDAx: "0x00000000000000000000000000000000pre0022" as `0x${string}`,
    AAPLx: "0x00000000000000000000000000000000pre0023" as `0x${string}`,
    SPYx: "0x00000000000000000000000000000000pre0024" as `0x${string}`,
    GOOGLx: "0x00000000000000000000000000000000pre0025" as `0x${string}`,
    METAx: "0x00000000000000000000000000000000pre0026" as `0x${string}`,
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

export interface PreviewAsset {
  symbol: string;
  name: string;
  kind: "base" | "xstock";
  decimals: number;
  usdPrice: number;
  assetRef: string;
  attested: boolean;
  class: "cash" | "equity" | "etf";
}

export const PREVIEW_ASSETS: PreviewAsset[] = [
  { symbol: "USDT", name: "Tether USD", kind: "base", decimals: 6, usdPrice: 1, assetRef: "FIAT:USD", attested: true, class: "cash" },
  { symbol: "USDG", name: "Global Dollar", kind: "base", decimals: 6, usdPrice: 1, assetRef: "FIAT:USD", attested: true, class: "cash" },
  { symbol: "TSLAx", name: "Tesla xStock", kind: "xstock", decimals: 18, usdPrice: 330, assetRef: "ISIN:US88160R1014", attested: true, class: "equity" },
  { symbol: "NVDAx", name: "NVIDIA xStock", kind: "xstock", decimals: 18, usdPrice: 180, assetRef: "ISIN:US67066G1040", attested: true, class: "equity" },
  { symbol: "AAPLx", name: "Apple xStock", kind: "xstock", decimals: 18, usdPrice: 230, assetRef: "ISIN:US0378331005", attested: true, class: "equity" },
  { symbol: "SPYx", name: "S&P 500 xStock", kind: "xstock", decimals: 18, usdPrice: 640, assetRef: "ISIN:US78462F1030", attested: true, class: "etf" },
  { symbol: "GOOGLx", name: "Alphabet xStock", kind: "xstock", decimals: 18, usdPrice: 200, assetRef: "ISIN:US02079K3059", attested: true, class: "equity" },
  { symbol: "METAx", name: "Meta xStock", kind: "xstock", decimals: 18, usdPrice: 520, assetRef: "ISIN:US30303M1027", attested: true, class: "equity" },
];

export const PREVIEW_VENUES = [
  {
    name: "OKX-DEX-sim",
    feeBps: 30,
    depthMultiplier: { TSLAx: 1.4, NVDAx: 1.5, AAPLx: 1.3, SPYx: 0.8, GOOGLx: 0.9, METAx: 1.1 } as Record<string, number>,
    priceSkewBps: { TSLAx: 0, NVDAx: -8, AAPLx: 0, SPYx: 12, GOOGLx: 6, METAx: 4 } as Record<string, number>,
  },
  {
    name: "XSwap-sim",
    feeBps: 20,
    depthMultiplier: { TSLAx: 0.9, NVDAx: 0.8, AAPLx: 1.0, SPYx: 1.6, GOOGLx: 1.2, METAx: 0.95 } as Record<string, number>,
    priceSkewBps: { TSLAx: 10, NVDAx: 4, AAPLx: 6, SPYx: -14, GOOGLx: -6, METAx: -8 } as Record<string, number>,
  },
];

export const PREVIEW_SOLVERS = [
  { name: "aggressive", reputationBps: 7200, fulfilled: 18, failed: 1, feeBps: 8, style: "AI / RWA / gasless: tight guarantees, wins on price" },
  { name: "conservative", reputationBps: 9100, fulfilled: 11, failed: 0, feeBps: 15, style: "KYB-attested / RWA / agent: leaves headroom, rarely fails a win" },
  { name: "balanced", reputationBps: 5000, fulfilled: 0, failed: 0, feeBps: 12, style: "default; not yet bonded in this preview" },
];
