/**
 * X Layer mainnet (196) venue notes.
 *
 * Do not point IntentSettlement at an aggregator until it implements IDexRouter
 * (`getAmountsOut` + `swapExactTokensForTokens`). The OKX DEX router below is the
 * documented aggregator address; Uniswap is live on X Layer as of 2026-01 but is
 * not a V2 pair router. Fill `mainnet` token addresses in assets.ts from the issuer
 * before deploying.
 */
export const XLAYER_MAINNET = {
  chainId: 196,
  rpc: "https://rpc.xlayer.tech",
  explorer: "https://web3.okx.com/explorer/xlayer",
  routers: [
    {
      name: "OKX DEX",
      address: "0x69C236E021F5775B0D0328ded5EaC708E3B869DF",
      interface: "aggregator",
      allowlisted: false,
      source: "https://web3.okx.com/onchainos/dev-docs-v5/dex-api/dex-smart-contract",
    },
  ],
} as const;
