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
  submitDomain,
  SUBMIT_TYPES,
  SESSION_TYPES,
  PERMIT_TYPES,
  IntentKind,
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
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "nonces", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
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
  {
    type: "function",
    name: "submitFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "kind", type: "uint8" },
      { name: "outcomeHash", type: "bytes32" },
      { name: "policyHash", type: "bytes32" },
      { name: "legCount", type: "uint16" },
      { name: "auctionEndsAt", type: "uint64" },
      { name: "deadline", type: "uint64" },
      { name: "integrator", type: "address" },
      { name: "metadataURI", type: "string" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "intentId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "sessionNonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "authorizeSession",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "key", type: "address" },
      { name: "expiresAt", type: "uint64" },
      { name: "kinds", type: "uint32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "challengeSelection",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intentId", type: "bytes32" },
      { name: "dominatingBidId", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

const VAULT = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface DeploymentInfo {
  chainId: number;
  rpc: string;
  explorer: string;
  contracts: { intentRegistry: Address; settlement: Address; [k: string]: Address };
  tokens: Record<string, Address>;
  roles?: { coordinator?: Address; [k: string]: Address | undefined };
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
  const hash = await sendTx({
    account,
    rpc: deployment.rpc,
    to: usdt,
    data: encodeFunctionData({ abi: ERC20, functionName: "mint", args: [account, amount] }),
  });
  const usdg = deployment.tokens.USDG;
  if (usdg) {
    await sendTx({
      account,
      rpc: deployment.rpc,
      to: usdg,
      data: encodeFunctionData({ abi: ERC20, functionName: "mint", args: [account, amount] }),
    });
  }
  const tsla = deployment.tokens.TSLAx;
  if (tsla) {
    await sendTx({
      account,
      rpc: deployment.rpc,
      to: tsla,
      data: encodeFunctionData({
        abi: ERC20,
        functionName: "mint",
        args: [account, 10n ** 21n],
      }),
    });
  }
  return hash;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

async function signTypedData(account: Address, payload: unknown): Promise<Hex> {
  return (await ethereum().request({
    method: "eth_signTypedData_v4",
    params: [account, JSON.stringify(payload)],
  })) as Hex;
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

  const now = Math.max(Math.floor(Date.now() / 1000), Number((await pub.getBlock()).timestamp));
  const stamped = retimeDraft(draft, { now: now + 8, auctionSeconds: 30, ttlSeconds: 180 });
  if (stamped.outcome.kind !== IntentKind.PAYMENT) {
    stamped.outcome = { ...stamped.outcome, recipient: account };
  }

  const settlement = deployment.contracts.settlement;
  const integrator =
    stamped.metadata.integratorControlled && deployment.roles?.coordinator
      ? deployment.roles.coordinator
      : ZERO;
  const metadata = (stamped.metadata.prompt ?? "").slice(0, 500);
  const outcomeHash = hashOutcome(stamped.outcome);
  const policyHash = hashPolicy(stamped.policy);

  let permit: {
    token: Address;
    owner: Address;
    spender: Address;
    value: string;
    deadline: string;
    signature: Hex;
  } | undefined;

  if (stamped.outcome.inputAmount > 0n) {
    const allowance = (await pub.readContract({
      address: stamped.outcome.inputToken,
      abi: ERC20,
      functionName: "allowance",
      args: [account, settlement],
    })) as bigint;
    if (allowance < stamped.outcome.inputAmount) {
      try {
        const token = stamped.outcome.inputToken;
        const [name, nonce] = await Promise.all([
          pub.readContract({ address: token, abi: ERC20, functionName: "name" }) as Promise<string>,
          pub.readContract({ address: token, abi: ERC20, functionName: "nonces", args: [account] }) as Promise<bigint>,
        ]);
        const permitDeadline = BigInt(now + 3_600);
        const signature = await signTypedData(account, {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            Permit: PERMIT_TYPES.Permit,
          },
          primaryType: "Permit",
          domain: { name, version: "1", chainId, verifyingContract: token },
          message: {
            owner: account,
            spender: settlement,
            value: stamped.outcome.inputAmount.toString(),
            nonce: nonce.toString(),
            deadline: permitDeadline.toString(),
          },
        });
        permit = {
          token,
          owner: account,
          spender: settlement,
          value: stamped.outcome.inputAmount.toString(),
          deadline: permitDeadline.toString(),
          signature,
        };
      } catch (error) {
        const okb = await pub.getBalance({ address: account });
        if (okb === 0n) {
          throw new Error(
            `Could not sign a gasless approval (${(error as Error).message}). Fund a little OKB for a one-time approve, or try again.`,
          );
        }
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
  }

  const nonce = (await pub.readContract({
    address: deployment.contracts.intentRegistry,
    abi: REGISTRY,
    functionName: "nonces",
    args: [account],
  })) as bigint;

  const signature = await signTypedData(account, {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Submit: SUBMIT_TYPES.Submit,
    },
    primaryType: "Submit",
    domain: submitDomain(chainId, deployment.contracts.intentRegistry),
    message: {
      owner: account,
      kind: stamped.outcome.kind,
      outcomeHash,
      policyHash,
      salt: stamped.salt,
      auctionEndsAt: stamped.auctionEndsAt.toString(),
      deadline: stamped.deadline.toString(),
      legCount: stamped.outcome.legs.length,
      integrator,
      metadataURI: metadata,
      nonce: nonce.toString(),
    },
  });

  const intentId = computeIntentId({
    chainId: deployment.chainId,
    registry: deployment.contracts.intentRegistry,
    owner: account,
    outcomeHash,
    policyHash,
    salt: stamped.salt,
    auctionEndsAt: stamped.auctionEndsAt,
    deadline: stamped.deadline,
  });

  try {
    const response = await fetch("/api/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner: account,
        salt: stamped.salt,
        kind: stamped.outcome.kind,
        outcomeHash,
        policyHash,
        legCount: stamped.outcome.legs.length,
        auctionEndsAt: stamped.auctionEndsAt.toString(),
        deadline: stamped.deadline.toString(),
        integrator,
        metadataURI: metadata,
        signature,
        permit,
      }),
    });
    const raw = await response.text();
    let payload: { hash?: Hex; error?: string } = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error((raw || "relay failed").replace(/\s+/g, " ").slice(0, 180));
    }
    if (!response.ok || !payload.hash) throw new Error(payload.error ?? "relay failed");
    await pub.waitForTransactionReceipt({ hash: payload.hash });
    return { intentId, hash: payload.hash, draft: stamped };
  } catch (error) {
    const okb = await pub.getBalance({ address: account });
    if (okb === 0n) {
      throw new Error(
        `${(error as Error).message}. Relay could not submit, and this wallet has 0 OKB so it cannot send the transaction itself.`,
      );
    }
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
          outcomeHash,
          policyHash,
          stamped.outcome.legs.length,
          stamped.auctionEndsAt,
          stamped.deadline,
          metadata,
        ],
      }),
    });
    return { intentId, hash, draft: stamped };
  }
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

export async function authorizeCoordinatorSession(
  deployment: DeploymentInfo,
  account: Address,
  days = 30,
): Promise<Hex> {
  const coordinator = deployment.roles?.coordinator;
  if (!coordinator) throw new Error("no coordinator on this deployment");
  const pub = publicClient(deployment.rpc);
  const chainId = Number(await pub.getChainId());
  const registry = deployment.contracts.intentRegistry;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + days * 86_400);
  const nonce = (await pub.readContract({
    address: registry,
    abi: REGISTRY,
    functionName: "sessionNonces",
    args: [account],
  })) as bigint;
  const signature = await signTypedData(account, {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      Session: SESSION_TYPES.Session,
    },
    primaryType: "Session",
    domain: submitDomain(chainId, registry),
    message: {
      owner: account,
      key: coordinator,
      expiresAt: expiresAt.toString(),
      kinds: 0,
      nonce: nonce.toString(),
    },
  });
  try {
    const response = await fetch("/api/health", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "session",
        owner: account,
        key: coordinator,
        expiresAt: expiresAt.toString(),
        kinds: 0,
        signature,
      }),
    });
    const payload = (await response.json()) as { hash?: Hex; error?: string };
    if (!response.ok || !payload.hash) throw new Error(payload.error ?? "session relay failed");
    await pub.waitForTransactionReceipt({ hash: payload.hash });
    return payload.hash;
  } catch {
    return sendTx({
      account,
      rpc: deployment.rpc,
      to: registry,
      data: encodeFunctionData({
        abi: REGISTRY,
        functionName: "authorizeSession",
        args: [account, coordinator, expiresAt, 0, signature],
      }),
    });
  }
}

export async function challengeSelection(
  deployment: DeploymentInfo,
  account: Address,
  intentId: Hex,
  dominatingBidId: number,
): Promise<Hex> {
  return sendTx({
    account,
    rpc: deployment.rpc,
    to: deployment.contracts.intentRegistry,
    data: encodeFunctionData({
      abi: REGISTRY,
      functionName: "challengeSelection",
      args: [intentId, dominatingBidId],
    }),
  });
}

export async function vaultDeposit(
  deployment: DeploymentInfo,
  account: Address,
  amount: bigint,
): Promise<Hex> {
  const vault = deployment.contracts.tslaVault;
  if (!vault) throw new Error("no TSLAx vault on this deployment");
  const tsla = deployment.tokens.TSLAx;
  const allowance = (await publicClient(deployment.rpc).readContract({
    address: tsla,
    abi: ERC20,
    functionName: "allowance",
    args: [account, vault],
  })) as bigint;
  if (allowance < amount) {
    await sendTx({
      account,
      rpc: deployment.rpc,
      to: tsla,
      data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [vault, amount] }),
    });
  }
  return sendTx({
    account,
    rpc: deployment.rpc,
    to: vault,
    data: encodeFunctionData({ abi: VAULT, functionName: "deposit", args: [amount] }),
  });
}

export async function vaultWithdraw(
  deployment: DeploymentInfo,
  account: Address,
  amount: bigint,
): Promise<Hex> {
  const vault = deployment.contracts.tslaVault;
  if (!vault) throw new Error("no TSLAx vault on this deployment");
  return sendTx({
    account,
    rpc: deployment.rpc,
    to: vault,
    data: encodeFunctionData({ abi: VAULT, functionName: "withdraw", args: [amount] }),
  });
}

export async function vaultBalance(
  deployment: DeploymentInfo,
  account: Address,
): Promise<bigint> {
  const vault = deployment.contracts.tslaVault;
  if (!vault) return 0n;
  return publicClient(deployment.rpc).readContract({
    address: vault,
    abi: VAULT,
    functionName: "balanceOf",
    args: [account],
  }) as Promise<bigint>;
}
