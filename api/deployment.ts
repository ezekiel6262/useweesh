export const config = { maxDuration: 60 };

const deployment = {
  network: "xlayerTestnet",
  chainId: 1952,
  rpc: "https://testrpc.xlayer.tech",
  explorer: "https://web3.okx.com/explorer/xlayer-testnet",
  contracts: {
    solverRegistry: "0x66874911ffFe383AB6E5fD1e3daFEE896bf2A0Db",
    rwaRegistry: "0x96061d44DFe85AB7e045645Cf7B7436854F77E3E",
    policyEngine: "0xBc8963621E0333f3ABD3FC1B5a7A716D119f6B58",
    intentRegistry: "0xba5e77ea6DC930c0A41F2d962AB3Efd6ffC3250A",
    settlement: "0xcDA3E1eaCF05B55cB04D781Fe6a0Cf365777073a",
    recurringRegistry: "0xcE91d813251EbdCc75Bc320690cE5b1A6dA54FEF",
    tslaVault: "0x7147Da6E8a2C785C72662bE65FCF8d11D2Bf01Af",
  },
  roles: {
    treasury: "0xD9ac4CA5d5b931d645D5309bEE7b18db536245E8",
    coordinator: "0x583fdb73aEF1390647b64778349D289d4783Dd72",
    solverA: "0xE7Cb0ECa2ab4bAEeA92940865CC0dA7998E1eb22",
    solverB: "0x1ccCc3162EBc37855cb4F4a304267dE3C391c4DF",
    solverC: "0x24579f8EDab97795D8BF577f7aDc8A8BB17d8aE8",
    solverD: "0x027308b460b26F305c2AC3642DE7beA3D9272655",
  },
  tokens: {
    USDT: "0x07255931c80A9cc1B104065a9D13da6AcdC16215",
    USDG: "0x0B986b0E84365556cfFc689c4182ad6794C11754",
    TSLAx: "0xc28EAaF75E6E6488A727098665fdE2382C7adbC9",
    NVDAx: "0x8fbfeC138C2E12548c4972748099b4b22dD2b903",
    AAPLx: "0xb96aC54f416B6d998F797CE97Ffc917C54FbBe21",
    SPYx: "0x8412Ac7F068E7e749Cd8Dee6782309522AD08aB6",
    GOOGLx: "0x5592c291e95BE4fadb43568c0b13cBAaB79234a1",
    METAx: "0x23E3E488802F841FE9113C9dec445f32C9C92c5B",
  },
  routers: [
    { name: "OKX-DEX-sim", address: "0x941a75afb85E3fA20D0211843614888273269B3A" },
    { name: "XSwap-sim", address: "0x31ffED20457e33Ea6048AE64A4e8802FBBed959b" },
  ],
};

export default async function handler(_req: unknown, res?: { statusCode: number; setHeader: Function; end: Function }) {
  const tokens = deployment.tokens as Record<string, string>;
  const assets = Object.entries(tokens).map(([symbol, address]) => ({
    symbol,
    address,
    decimals: symbol === "USDT" || symbol === "USDG" ? 6 : 18,
    kind: symbol === "USDT" || symbol === "USDG" ? "base" : "xstock",
  }));
  const payload = JSON.stringify({ ...deployment, assets, now: Math.floor(Date.now() / 1000) });
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
