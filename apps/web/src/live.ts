import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import {
  computeIntentId,
  hashOutcome,
  hashPolicy,
  retimeDraft,
  type IntentDraft,
} from "@intentos/intent-schema";

export const XLAYER_TESTNET = defineChain({
  id: 1952,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKX", url: "https://web3.okx.com/explorer/xlayer-testnet" } },
  testnet: true,
});

const ERC20 = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const REGISTRY = [
  {
    type: "function",
    name: "submit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "kind", type: "uint8" },
      { name: "outcomeHash", type: "bytes32" },
      { name: "policyHash", type: "bytes32" },
      { name: "legCount", type: "uint16" },
      { name: "auctionEndsAt", type: "uint64" },
      { name: "deadline", type: "uint64" },
      { name: "metadataURI", type: "string" },
    ],
    outputs: [{ name: "intentId", type: "bytes32" }],
  },
] as const;

export interface DeploymentInfo {
  chainId: number;
  rpc: string;
  explorer: string;
  contracts: { intentRegistry: Address; settlement: Address; [k: string]: Address };
  tokens: Record<string, Address>;
}

function ethereum(): any {
  const w = window as any;
  const listed: any[] = w.ethereum?.providers ?? [];
  const okx =
    w.okxwallet ??
    listed.find((p) => p?.isOkxWallet || p?.isOKXWallet) ??
    (w.ethereum?.isOkxWallet || w.ethereum?.isOKXWallet ? w.ethereum : null);
  const eth = okx ?? w.ethereum;
  if (!eth) throw new Error("No injected wallet. Open this page in OKX Wallet or MetaMask.");
  return eth;
}

/** Send via eth_sendTransaction so OKX Wallet does not wrap the call as a third-party executor. */
async function sendTx(args: {
  account: Address;
  to: Address;
  data: Hex;
  rpc: string;
}): Promise<Hex> {
  const pub = publicClient(args.rpc);
  const from = args.account;
  try {
    await pub.call({ to: args.to, data: args.data, account: from });
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (/insufficient funds|gas/i.test(message)) {
      throw new Error("Not enough testnet OKB for gas. Fund this wallet from the X Layer faucet, then retry.");
    }
    throw new Error(humanRevert(message));
  }

  let gas: Hex | undefined;
  try {
    const estimate = await pub.estimateGas({ to: args.to, data: args.data, account: from });
    gas = `0x${(estimate * 12n / 10n).toString(16)}` as Hex;
  } catch {
    gas = "0x7a120" as Hex;
  }

  try {
    const hash = (await ethereum().request({
      method: "eth_sendTransaction",
      params: [{ from, to: args.to, data: args.data, value: "0x0", ...(gas ? { gas } : {}) }],
    })) as Hex;
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  } catch (error) {
    throw new Error(humanRevert((error as Error).message ?? String(error)));
  }
}

function humanRevert(message: string): string {
  if (/BadTiming/i.test(message)) return "The auction window was already closed against chain time. Parse again and submit immediately.";
  if (/IntentExists/i.test(message)) return "That intent was already submitted. Parse again to get a new salt.";
  if (/BadLegCount/i.test(message)) return "The intent has no acquisition legs.";
  if (/execution reverted/i.test(message) && /0x/i.test(message)) return `Contract reverted. ${message.slice(0, 180)}`;
  if (/user rejected|denied/i.test(message)) return "Signature rejected in the wallet.";
  if (/Third party execution/i.test(message)) {
    return "The wallet blocked this as a third-party execution. Use OKX Wallet’s in-app browser, switch to X Layer Testnet (1952), and keep a little OKB for gas.";
  }
  return message;
}

export async function connectWallet(): Promise<Address> {
  const accounts = (await ethereum().request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("wallet returned no account");
  await ensureChain();
  return accounts[0] as Address;
}

export async function ensureChain(): Promise<void> {
  const id = "0x7a0";
  try {
    await ethereum().request({ method: "wallet_switchEthereumChain", params: [{ chainId: id }] });
  } catch (error: any) {
    if (error?.code !== 4902 && !/unrecognized chain/i.test(String(error?.message))) throw error;
    await ethereum().request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: id,
          chainName: "X Layer Testnet",
          nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
          rpcUrls: ["https://testrpc.xlayer.tech"],
          blockExplorerUrls: ["https://web3.okx.com/explorer/xlayer-testnet"],
        },
      ],
    });
  }
}

function publicClient(rpc: string) {
  return createPublicClient({
    chain: XLAYER_TESTNET,
    transport: http(rpc),
  });
}

export async function mintTestUsdt(deployment: DeploymentInfo, account: Address, amount = 100_000_000_000n) {
  const usdt = deployment.tokens.USDT;
  if (!usdt) throw new Error("USDT is not on this deployment");
  return sendTx({
    account,
    rpc: deployment.rpc,
    to: usdt,
    data: encodeFunctionData({ abi: ERC20, functionName: "mint", args: [account, amount] }),
  });
}

export async function submitDraft(
  deployment: DeploymentInfo,
  account: Address,
  draft: IntentDraft,
): Promise<{ intentId: Hex; hash: Hex; draft: IntentDraft }> {
  await ensureChain();
  const pub = publicClient(deployment.rpc);
  const chainId = Number(await pub.getChainId());
  if (chainId !== 1952) {
    throw new Error(`Wallet is on chain ${chainId}, not X Layer Testnet (1952). Switch networks and retry.`);
  }
  const okb = await pub.getBalance({ address: account });
  if (okb === 0n) {
    throw new Error("This wallet has 0 OKB. The faucet must fund YOUR connected address, not the deployer, or submit cannot pay gas.");
  }

  const now = Math.max(Math.floor(Date.now() / 1000), Number((await pub.getBlock()).timestamp));
  const stamped = retimeDraft(draft, { now: now + 8, auctionSeconds: 30, ttlSeconds: 180 });
  stamped.outcome = { ...stamped.outcome, recipient: account };

  const settlement = deployment.contracts.settlement;
  if (stamped.outcome.inputAmount > 0n) {
    const allowance = (await pub.readContract({
      address: stamped.outcome.inputToken,
      abi: ERC20,
      functionName: "allowance",
      args: [account, settlement],
    })) as bigint;
    if (allowance < stamped.outcome.inputAmount) {
      await sendTx({
        account,
        rpc: deployment.rpc,
        to: stamped.outcome.inputToken,
        data: encodeFunctionData({
          abi: ERC20,
          functionName: "approve",
          args: [settlement, stamped.outcome.inputAmount],
        }),
      });
    }
  }

  const metadata = (stamped.metadata.prompt ?? "").slice(0, 500);
  const hash = await sendTx({
    account,
    rpc: deployment.rpc,
    to: deployment.contracts.intentRegistry,
    data: encodeFunctionData({
      abi: REGISTRY,
      functionName: "submit",
      args: [
        stamped.salt,
        stamped.outcome.kind,
        hashOutcome(stamped.outcome),
        hashPolicy(stamped.policy),
        stamped.outcome.legs.length,
        stamped.auctionEndsAt,
        stamped.deadline,
        metadata,
      ],
    }),
  });

  const intentId = computeIntentId({
    chainId: deployment.chainId,
    registry: deployment.contracts.intentRegistry,
    owner: account,
    outcomeHash: hashOutcome(stamped.outcome),
    policyHash: hashPolicy(stamped.policy),
    salt: stamped.salt,
    auctionEndsAt: stamped.auctionEndsAt,
    deadline: stamped.deadline,
  });

  return { intentId, hash, draft: stamped };
}

export async function balanceOf(rpc: string, token: Address, account: Address): Promise<bigint> {
  return publicClient(rpc).readContract({
    address: token,
    abi: ERC20,
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}

export async function readBalances(
  deployment: DeploymentInfo,
  account: Address,
): Promise<{ symbol: string; token: Address; balance: bigint }[]> {
  const rows = [];
  for (const [symbol, token] of Object.entries(deployment.tokens)) {
    rows.push({ symbol, token, balance: await balanceOf(deployment.rpc, token, account) });
  }
  return rows;
}
