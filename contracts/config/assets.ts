/**
 * Demo asset universe for IntentOS.
 *
 * On a local chain and on X Layer testnet the real tokenized equities do not exist, so the
 * deploy script mints stand-ins with the same decimals and roughly the right prices. Mainnet
 * addresses are intentionally left null rather than guessed — fill them from the issuer's own
 * documentation before pointing anything at X Layer mainnet (chainId 196).
 */
export interface DemoAsset {
  symbol: string;
  name: string;
  decimals: number;
  /** Reference price in USDT, used to seed the demo routers. */
  usdPrice: number;
  /** Offchain identifier published in the RWA attestation. */
  assetRef: string;
  /** X Layer mainnet address, once known. */
  mainnet: string | null;
}

export const BASE_ASSET: DemoAsset = {
  symbol: "USDT",
  name: "Tether USD",
  decimals: 6,
  usdPrice: 1,
  assetRef: "FIAT:USD",
  mainnet: null,
};

export const XSTOCKS: DemoAsset[] = [
  { symbol: "TSLAx", name: "Tesla xStock", decimals: 18, usdPrice: 330, assetRef: "ISIN:US88160R1014", mainnet: null },
  { symbol: "NVDAx", name: "NVIDIA xStock", decimals: 18, usdPrice: 180, assetRef: "ISIN:US67066G1040", mainnet: null },
  { symbol: "AAPLx", name: "Apple xStock", decimals: 18, usdPrice: 230, assetRef: "ISIN:US0378331005", mainnet: null },
  { symbol: "SPYx", name: "S&P 500 xStock", decimals: 18, usdPrice: 640, assetRef: "ISIN:US78462F1030", mainnet: null },
  { symbol: "GOOGLx", name: "Alphabet xStock", decimals: 18, usdPrice: 200, assetRef: "ISIN:US02079K3059", mainnet: null },
  { symbol: "METAx", name: "Meta xStock", decimals: 18, usdPrice: 520, assetRef: "ISIN:US30303M1027", mainnet: null },
];

/** ETF-class tickers get the ETF asset class in the RWA registry; the rest are equities. */
export const ETF_SYMBOLS = new Set(["SPYx"]);

export const VENUES = [
  {
    /** Deeper on the mega-caps, slightly higher fee. */
    name: "OKX-DEX-sim",
    feeBps: 30,
    depthMultiplier: { TSLAx: 1.4, NVDAx: 1.5, AAPLx: 1.3, SPYx: 0.8, GOOGLx: 0.9, METAx: 1.1 } as Record<string, number>,
    priceSkewBps: { TSLAx: 0, NVDAx: -8, AAPLx: 0, SPYx: 12, GOOGLx: 6, METAx: 4 } as Record<string, number>,
  },
  {
    /** Thinner overall but prices the index products better. */
    name: "XSwap-sim",
    feeBps: 20,
    depthMultiplier: { TSLAx: 0.9, NVDAx: 0.8, AAPLx: 1.0, SPYx: 1.6, GOOGLx: 1.2, METAx: 0.95 } as Record<string, number>,
    priceSkewBps: { TSLAx: 10, NVDAx: 4, AAPLx: 6, SPYx: -14, GOOGLx: -6, METAx: -8 } as Record<string, number>,
  },
];
