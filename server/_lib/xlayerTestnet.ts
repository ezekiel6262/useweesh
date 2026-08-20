import type { DeploymentFile } from "@intentos/sdk";

/** Baked into the serverless bundle so Vercel does not have to find the JSON on disk. */
export const XLAYER_TESTNET_DEPLOYMENT = {
  network: "xlayerTestnet",
  chainId: 1952,
  contracts: {
    solverRegistry: "0xa0d75b2BBBBf711764e0F0F5B7423E0B879257a3",
    rwaRegistry: "0x807F1Dec94d3a648351E369A0b032C26BAC7493b",
    policyEngine: "0xE320FB63BDda6c333B915E36B69d7968E91C6962",
    intentRegistry: "0x84E27EcE3Bb37e97C51EbE5438E4937ABD1e67F3",
    settlement: "0x0e20f8239A37Fe6E2231D834ea67305fcF294509",
  },
  roles: {
    treasury: "0xD9ac4CA5d5b931d645D5309bEE7b18db536245E8",
    coordinator: "0x583fdb73aEF1390647b64778349D289d4783Dd72",
    solverA: "0xE7Cb0ECa2ab4bAEeA92940865CC0dA7998E1eb22",
    solverB: "0x1ccCc3162EBc37855cb4F4a304267dE3C391c4DF",
  },
  tokens: {
    USDT: "0xFb6340d7Fd66E85d145d9f6478B6e1538d4b61a8",
    TSLAx: "0x955608172b71188e8A4205876C5bBC22ca07c535",
    NVDAx: "0xB6eBAE387FAf4924C88b7898054df59b0D5f0962",
    AAPLx: "0x1B58a2249522989b93A6921dD119Fd144520E39E",
    SPYx: "0xdcd7ca265503Beed7d2508Da6385339821095203",
    GOOGLx: "0x63Fe6eE63C5f32E6485E75Bd7c69679fa81DB8e4",
    METAx: "0xA56CeE53a52469aE0F935e0C4A1c4F97912FECFf",
  },
  routers: [
    { name: "OKX-DEX-sim", address: "0x2a514a6a76576290eddBf5A88759996dBE70b976" },
    { name: "XSwap-sim", address: "0xfF0e38Cd5de100316350f161DC3Ce369f7cA7857" },
  ],
} as DeploymentFile;
