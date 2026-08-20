import type { DeploymentFile } from "@intentos/sdk";

/** Baked into the serverless bundle so Vercel does not have to find the JSON on disk. */
export const XLAYER_TESTNET_DEPLOYMENT = {
  network: "xlayerTestnet",
  chainId: 1952,
  contracts: {
    solverRegistry: "0x4129073bf0B0c9b612fA33F8687DbF555646D515",
    rwaRegistry: "0x44F2b8b18Acdc3c68fB419Fb4D6f413be9167DFd",
    policyEngine: "0xB0E513aF4c9fd7bD1Ea0f66e62c8edCcF2A09766",
    intentRegistry: "0x2E6Be30A537AA45f16BB47617481745198453382",
    settlement: "0xFDd64293C369ea1bD93274a521dF430442FD0cA6",
  },
  roles: {
    treasury: "0xD9ac4CA5d5b931d645D5309bEE7b18db536245E8",
    coordinator: "0x583fdb73aEF1390647b64778349D289d4783Dd72",
    solverA: "0xE7Cb0ECa2ab4bAEeA92940865CC0dA7998E1eb22",
    solverB: "0x1ccCc3162EBc37855cb4F4a304267dE3C391c4DF",
  },
  tokens: {
    USDT: "0x761E498d52f71F5E51E6F2C5B91c641C91982b5e",
    TSLAx: "0x2D62AcFa7b795C1d11181813D0B18480209cb7A1",
    NVDAx: "0xd34fE2b0BCe70b8698e73c699913471ecBB5c297",
    AAPLx: "0x4061A288E23998213f6Fae07CbCB503AC5945C43",
    SPYx: "0x78a3bFaD89A4Daf2C63b2f3974e990E53DA8a811",
    GOOGLx: "0x7AdC7417e7CdD140aD2235A13e9a9320a96A6793",
  },
  routers: [
    { name: "OKX-DEX-sim", address: "0xAee94f7d62DDE5d1D67910dc27A3FeD206650aA3" },
    { name: "XSwap-sim", address: "0x75BAa6DE3b456A04cFB60Ba6741409804f993C20" },
  ],
} as DeploymentFile;
