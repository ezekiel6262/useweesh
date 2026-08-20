import { defineChain, type Chain } from "viem";

/**
 * X Layer — OKX's zkEVM L2, and the only chain IntentOS targets.
 *
 * Staying single-chain is a design choice, not a limitation: an intent settles in one atomic
 * transaction against one set of venues, so there is no bridge latency to model, no cross-chain
 * failure mode to unwind, and a solver's guarantee means exactly what it says.
 */

export const xLayerMainnet: Chain = defineChain({
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/x-layer" } },
});

export const xLayerTestnet: Chain = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKX Explorer", url: "https://web3.okx.com/explorer/xlayer-testnet" } },
  testnet: true,
});

/** Pre-OP-Stack X Layer testnet. Kept so old deployment files still load. */
export const xLayerTestnetLegacy: Chain = defineChain({
  id: 195,
  name: "X Layer Testnet (legacy)",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/x-layer-testnet" } },
  testnet: true,
});

/** The local Hardhat node the demos and tests run against. */
export const hardhatLocal: Chain = defineChain({
  id: 31337,
  name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

const CHAINS = [xLayerMainnet, xLayerTestnet, xLayerTestnetLegacy, hardhatLocal];

export function chainById(chainId: number): Chain {
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) throw new Error(`IntentOS does not know chain ${chainId}`);
  return chain;
}

export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const base = chainById(chainId).blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : undefined;
}
