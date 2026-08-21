/**
 * Verified X Layer mainnet (196) addresses. Only tokens we read on-chain go here.
 * Uniswap V2 has no USDT/USDG or USDT/TSLAx pair; IntentOS allowlists V2 plus a
 * V3 adapter (SwapRouter02) so settlement can use the pools that actually exist.
 */
export const XLAYER_MAINNET = {
  chainId: 196,
  rpc: "https://rpc.xlayer.tech",
  explorer: "https://web3.okx.com/explorer/xlayer",
  wokb: "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
  tokens: {
    USDT: "0x1e4a5963abfd975d8c9021ce480b42188849d41d",
    USDG: "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8",
    TSLAx: "0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0",
  },
  uniswapV2Router: "0x182a927119d56008d921126764bf884221b10f59",
  uniswapV3: {
    factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
    swapRouter02: "0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca",
    quoterV2: "0xd1b797d92d87b688193a2b976efc8d577d204343",
  },
} as const;
