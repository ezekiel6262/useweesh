import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
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
      { name: "legCount", type: "uint8" },
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
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No injected wallet. Install OKX Wallet or MetaMask.");
  return eth;
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

function walletClient() {
  return createWalletClient({
    chain: XLAYER_TESTNET,
    transport: custom(ethereum()),
  });
}

export async function mintTestUsdt(deployment: DeploymentInfo, account: Address, amount = 100_000_000_000n) {
  const usdt = deployment.tokens.USDT;
  if (!usdt) throw new Error("USDT is not on this deployment");
  const wallet = walletClient();
  const hash = await wallet.writeContract({
    account,
    chain: XLAYER_TESTNET,
    address: usdt,
    abi: ERC20,
    functionName: "mint",
    args: [account, amount],
  });
  await publicClient(deployment.rpc).waitForTransactionReceipt({ hash });
  return hash;
}

export async function submitDraft(
  deployment: DeploymentInfo,
  account: Address,
  draft: IntentDraft,
): Promise<{ intentId: Hex; hash: Hex; draft: IntentDraft }> {
  const pub = publicClient(deployment.rpc);
  const wallet = walletClient();
  const now = Math.max(Math.floor(Date.now() / 1000), Number((await pub.getBlock()).timestamp));
  const stamped = retimeDraft(draft, { now: now + 2, auctionSeconds: 20, ttlSeconds: 180 });
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
      const approveHash = await wallet.writeContract({
        account,
        chain: XLAYER_TESTNET,
        address: stamped.outcome.inputToken,
        abi: ERC20,
        functionName: "approve",
        args: [settlement, stamped.outcome.inputAmount],
      });
      await pub.waitForTransactionReceipt({ hash: approveHash });
    }
  }

  const hash = await wallet.writeContract({
    account,
    chain: XLAYER_TESTNET,
    address: deployment.contracts.intentRegistry,
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
      stamped.metadata.prompt ?? "",
    ],
  });
  await pub.waitForTransactionReceipt({ hash });

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
