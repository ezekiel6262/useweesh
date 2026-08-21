import {
  http,
  createPublicClient,
  createWalletClient,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ERC20_ABI,
  INTENT_REGISTRY_ABI,
  PERMIT_TYPES,
  RWA_REGISTRY_ABI,
  SETTLEMENT_ABI,
  SOLVER_REGISTRY_ABI,
  SUBMIT_TYPES,
  type IntentDraft,
  type IntentRecord,
  type Route,
  type SolverBid,
  computeIntentId,
  hashOutcome,
  hashPolicy,
  retimeDraft,
  submitDomain,
} from "@intentos/intent-schema";
import { type AssetCatalog, catalogFromDeployment, type DeploymentFile } from "@intentos/intent-ai";
import { chainById } from "./chain.js";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * The IntentOS client: everything an agent, a solver or a dashboard needs to talk to the
 * deployment. One class covers all three roles because they are the same protocol seen from
 * different sides — an agent that submits intents can also serve them.
 */

export interface ClientOptions {
  deployment: DeploymentFile;
  rpcUrl?: string;
  /** Private key for anything that writes. Read-only clients can leave it out. */
  privateKey?: Hex;
  account?: Account;
}

export class IntentOSClient {
  readonly deployment: DeploymentFile;
  readonly catalog: AssetCatalog;
  readonly publicClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly account?: Account;

  constructor(options: ClientOptions) {
    this.deployment = options.deployment;
    this.catalog = catalogFromDeployment(options.deployment);

    const chain = chainById(options.deployment.chainId);
    const transport = http(options.rpcUrl ?? chain.rpcUrls.default.http[0]);
    this.publicClient = createPublicClient({ chain, transport });

    this.account = options.account ?? (options.privateKey ? privateKeyToAccount(options.privateKey) : undefined);
    if (this.account) {
      this.walletClient = createWalletClient({ chain, transport, account: this.account });
    }
  }

  get address(): Address {
    if (!this.account) throw new Error("this client is read-only — construct it with a private key");
    return this.account.address;
  }

  get addresses() {
    return this.deployment.contracts;
  }

  /**
   * The chain's current time.
   *
   * Intent deadlines are checked against block timestamps, and a chain's clock can sit ahead of
   * the machine's — a local node advances a second per block, and an L2's sequencer has its own
   * drift. Building an intent's timing off the chain's clock is what keeps a short auction
   * window from being already closed by the time the submission lands.
   */
  async chainNow(): Promise<number> {
    const [latest, pending] = await Promise.all([
      this.publicClient.getBlock({ blockTag: "latest" }),
      this.publicClient.getBlock({ blockTag: "pending" }).catch(() => null),
    ]);

    // What the *next* block will be stamped with, not what the last one was. Three sources
    // disagree in practice and the latest of them is the safe read: an idle chain's head can be
    // minutes stale, a node that mined a burst of blocks carries a positive offset from the wall
    // clock ever after, and a read-only call is evaluated against the head rather than the
    // block a transaction will actually land in. Timing an intent off the head alone produces
    // an auction window that is already closed by the time the submission is mined.
    return Math.max(
      Number(latest.timestamp),
      pending ? Number(pending.timestamp) : 0,
      Math.floor(Date.now() / 1000),
    );
  }

  // ------------------------------------------------------------------ intents

  /** The id an intent will have once submitted, computed the same way the registry does. */
  async previewIntentId(draft: IntentDraft, owner?: Address): Promise<Hex> {
    return computeIntentId({
      chainId: this.deployment.chainId,
      registry: this.addresses.intentRegistry!,
      owner: owner ?? this.address,
      outcomeHash: hashOutcome(draft.outcome),
      policyHash: hashPolicy(draft.policy),
      salt: draft.salt,
      auctionEndsAt: draft.auctionEndsAt,
      deadline: draft.deadline,
    });
  }

  /**
   * Submit an intent, approving the settlement contract for whatever it will need to pull.
   * Returns the id and the transaction hash.
   */
  /**
   * Submit an intent: approve whatever settlement will pull, then commit the outcome.
   *
   * The draft is re-stamped with the chain's clock immediately before submission. Approvals mine
   * blocks and RPC round-trips take time, and an intent commits to its own auction window — so a
   * draft built even a few seconds earlier can arrive with the window already closed.
   */
  async submitIntent(
    draft: IntentDraft,
    options: { metadataURI?: string; auctionSeconds?: number; ttlSeconds?: number } = {},
  ): Promise<{ intentId: Hex; hash: Hex; draft: IntentDraft }> {
    await this.ensureApprovals(draft);

    const settleWindow = Number(draft.deadline - draft.auctionEndsAt);
    const auctionSeconds = options.auctionSeconds ?? 20;
    const submitted = retimeDraft(draft, {
      now: await this.chainNow(),
      auctionSeconds,
      ttlSeconds: options.ttlSeconds ?? auctionSeconds + settleWindow,
    });

    const intentId = await this.previewIntentId(submitted);
    const hash = await this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "submit", [
      submitted.salt,
      submitted.outcome.kind,
      hashOutcome(submitted.outcome),
      hashPolicy(submitted.policy),
      submitted.outcome.legs.length,
      submitted.auctionEndsAt,
      submitted.deadline,
      options.metadataURI ?? "",
    ]);

    return { intentId, hash, draft: submitted };
  }

  /**
   * Wallet-abstraction submit. The owner signs EIP-712 `Submit` (and ERC-20 `permit` when
   * settlement needs an allowance). The coordinator pays gas via `/api/relay` → `submitFor`.
   * Exact-amount permit — never an unlimited approval.
   */
  async submitIntentGasless(
    draft: IntentDraft,
    options: {
      relayUrl: string;
      metadataURI?: string;
      auctionSeconds?: number;
      ttlSeconds?: number;
      integrator?: Address;
    },
  ): Promise<{ intentId: Hex; hash: Hex; draft: IntentDraft }> {
    if (!this.walletClient || !this.account) {
      throw new Error("this client is read-only — construct it with a private key");
    }

    const settleWindow = Number(draft.deadline - draft.auctionEndsAt);
    const auctionSeconds = options.auctionSeconds ?? 20;
    const submitted = retimeDraft(draft, {
      now: await this.chainNow(),
      auctionSeconds,
      ttlSeconds: options.ttlSeconds ?? auctionSeconds + settleWindow,
    });

    const owner = this.address;
    const registry = this.addresses.intentRegistry!;
    const settlement = this.addresses.settlement!;
    const chainId = this.deployment.chainId;
    const coordinator = this.deployment.roles?.coordinator;
    const pinIntegrator = Boolean(submitted.metadata.integratorControlled) && Boolean(coordinator);
    const integrator = options.integrator ?? (pinIntegrator && coordinator ? coordinator : ZERO);
    const metadataURI = (options.metadataURI ?? submitted.metadata.prompt ?? "").slice(0, 500);
    const outcomeHash = hashOutcome(submitted.outcome);
    const policyHash = hashPolicy(submitted.policy);
    const now = await this.chainNow();

    let permit:
      | {
          token: Address;
          owner: Address;
          spender: Address;
          value: string;
          deadline: string;
          signature: Hex;
        }
      | undefined;

    if (submitted.outcome.inputAmount > 0n) {
      const allowance = (await this.publicClient.readContract({
        address: submitted.outcome.inputToken,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, settlement],
      })) as bigint;
      if (allowance < submitted.outcome.inputAmount) {
        const token = submitted.outcome.inputToken;
        const [name, nonce] = await Promise.all([
          this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }) as Promise<string>,
          this.publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "nonces",
            args: [owner],
          }) as Promise<bigint>,
        ]);
        const permitDeadline = BigInt(now + 3_600);
        const signature = await this.walletClient.signTypedData({
          account: this.account,
          domain: { name, version: "1", chainId, verifyingContract: token },
          types: PERMIT_TYPES,
          primaryType: "Permit",
          message: {
            owner,
            spender: settlement,
            value: submitted.outcome.inputAmount,
            nonce,
            deadline: permitDeadline,
          },
        });
        permit = {
          token,
          owner,
          spender: settlement,
          value: submitted.outcome.inputAmount.toString(),
          deadline: permitDeadline.toString(),
          signature,
        };
      }
    }

    const nonce = (await this.publicClient.readContract({
      address: registry,
      abi: INTENT_REGISTRY_ABI,
      functionName: "nonces",
      args: [owner],
    })) as bigint;

    const signature = await this.walletClient.signTypedData({
      account: this.account,
      domain: submitDomain(chainId, registry),
      types: SUBMIT_TYPES,
      primaryType: "Submit",
      message: {
        owner,
        kind: submitted.outcome.kind,
        outcomeHash,
        policyHash,
        salt: submitted.salt,
        auctionEndsAt: submitted.auctionEndsAt,
        deadline: submitted.deadline,
        legCount: submitted.outcome.legs.length,
        integrator,
        metadataURI,
        nonce,
      },
    });

    const intentId = await this.previewIntentId(submitted);
    const response = await fetch(options.relayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        owner,
        salt: submitted.salt,
        kind: submitted.outcome.kind,
        outcomeHash,
        policyHash,
        legCount: submitted.outcome.legs.length,
        auctionEndsAt: submitted.auctionEndsAt.toString(),
        deadline: submitted.deadline.toString(),
        integrator,
        metadataURI,
        signature,
        permit,
      }),
    });
    const payload = (await response.json()) as { hash?: Hex; error?: string };
    if (!response.ok || !payload.hash) throw new Error(payload.error ?? "relay failed");
    await this.publicClient.waitForTransactionReceipt({ hash: payload.hash });
    return { intentId, hash: payload.hash, draft: submitted };
  }

  /** Approve settlement for the input asset and every position a rebalance will sell. */
  async ensureApprovals(draft: IntentDraft): Promise<Hex[]> {
    const settlement = this.addresses.settlement!;
    const needed = new Map<Address, bigint>();

    if (draft.outcome.inputAmount > 0n) {
      needed.set(draft.outcome.inputToken, draft.outcome.inputAmount);
    }
    for (const exit of draft.outcome.exits) {
      needed.set(exit.token, (needed.get(exit.token) ?? 0n) + exit.amountIn);
    }

    const hashes: Hex[] = [];
    for (const [token, amount] of needed) {
      const allowance = await this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [this.address, settlement],
      });
      if ((allowance as bigint) >= amount) continue;
      hashes.push(await this.write(token, ERC20_ABI, "approve", [settlement, amount]));
    }
    return hashes;
  }

  async cancelIntent(intentId: Hex) {
    return this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "cancel", [intentId]);
  }

  async expireIntent(intentId: Hex) {
    return this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "expire", [intentId]);
  }

  async getIntent(intentId: Hex): Promise<IntentRecord> {
    const record = (await this.publicClient.readContract({
      address: this.addresses.intentRegistry!,
      abi: INTENT_REGISTRY_ABI,
      functionName: "getIntent",
      args: [intentId],
    })) as any;
    return { intentId, ...record };
  }

  /** Intents submitted by `owner`, newest first. */
  async listIntentsOf(owner: Address, limit = 50): Promise<Hex[]> {
    const ids = (await this.publicClient.readContract({
      address: this.addresses.intentRegistry!,
      abi: INTENT_REGISTRY_ABI,
      functionName: "intentsOf",
      args: [owner],
    })) as Hex[];
    const newest = [...ids].reverse();
    return newest.slice(0, limit);
  }

  async listIntentIds(limit = 50): Promise<Hex[]> {
    const count = (await this.publicClient.readContract({
      address: this.addresses.intentRegistry!,
      abi: INTENT_REGISTRY_ABI,
      functionName: "intentCount",
    })) as bigint;

    const start = count > BigInt(limit) ? count - BigInt(limit) : 0n;
    const ids: Hex[] = [];
    for (let i = count - 1n; i >= start; i--) {
      ids.push(
        (await this.publicClient.readContract({
          address: this.addresses.intentRegistry!,
          abi: INTENT_REGISTRY_ABI,
          functionName: "intentIdAt",
          args: [i],
        })) as Hex,
      );
      if (i === 0n) break;
    }
    return ids;
  }

  // ------------------------------------------------------------------ bidding

  async placeBid(intentId: Hex, bid: { feeBps: number; etaSeconds: number; planHash: Hex; guaranteedOut: bigint[] }) {
    return this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "placeBid", [
      intentId,
      bid.feeBps,
      bid.etaSeconds,
      bid.planHash,
      bid.guaranteedOut,
    ]);
  }

  async getBids(intentId: Hex): Promise<SolverBid[]> {
    const count = (await this.publicClient.readContract({
      address: this.addresses.intentRegistry!,
      abi: INTENT_REGISTRY_ABI,
      functionName: "bidCount",
      args: [intentId],
    })) as bigint;

    const bids: SolverBid[] = [];
    for (let i = 0; i < Number(count); i++) {
      const bid = (await this.publicClient.readContract({
        address: this.addresses.intentRegistry!,
        abi: INTENT_REGISTRY_ABI,
        functionName: "getBid",
        args: [intentId, i],
      })) as any;
      bids.push({ bidId: i, ...bid, guaranteedOut: [...bid.guaranteedOut] });
    }
    return bids;
  }

  async selectWinner(intentId: Hex, bidId: number, policy?: IntentDraft["policy"]) {
    if (policy) {
      try {
        return await this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "selectWinnerChecked", [
          intentId,
          bidId,
          policy,
        ]);
      } catch (error) {
        const message = (error as Error).message ?? "";
        // Missing selector on a pre-upgrade registry. Do not swallow SolverNotCompliant.
        if (!/does not (exist|have)|encoded function signature|function selector/i.test(message)) throw error;
      }
    }
    return this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "selectWinner", [intentId, bidId]);
  }

  async challengeSelection(intentId: Hex, dominatingBidId: number) {
    return this.write(this.addresses.intentRegistry!, INTENT_REGISTRY_ABI, "challengeSelection", [
      intentId,
      dominatingBidId,
    ]);
  }

  // --------------------------------------------------------------- settlement

  async settle(intentId: Hex, draft: IntentDraft, entryRoutes: Route[], exitRoutes: Route[]) {
    return this.write(this.addresses.settlement!, SETTLEMENT_ABI, "settle", [
      intentId,
      draft.outcome,
      draft.policy,
      entryRoutes,
      exitRoutes,
    ]);
  }

  async reportFailure(intentId: Hex, reason: string) {
    return this.write(this.addresses.settlement!, SETTLEMENT_ABI, "reportFailure", [intentId, reason]);
  }

  // ------------------------------------------------------------------ solvers

  async registerSolver(metadataURI: string, bond: bigint) {
    return this.write(this.addresses.solverRegistry!, SOLVER_REGISTRY_ABI, "register", [metadataURI], bond);
  }

  async getSolver(address: Address) {
    return this.publicClient.readContract({
      address: this.addresses.solverRegistry!,
      abi: SOLVER_REGISTRY_ABI,
      functionName: "getSolver",
      args: [address],
    }) as Promise<{
      registered: boolean;
      bond: bigint;
      reputationBps: number;
      fulfilled: number;
      failed: number;
      notionalSettled: bigint;
      metadataURI: string;
    }>;
  }

  async listSolvers(): Promise<Address[]> {
    const count = (await this.publicClient.readContract({
      address: this.addresses.solverRegistry!,
      abi: SOLVER_REGISTRY_ABI,
      functionName: "solverCount",
    })) as bigint;

    const solvers: Address[] = [];
    for (let i = 0; i < Number(count); i++) {
      solvers.push(
        (await this.publicClient.readContract({
          address: this.addresses.solverRegistry!,
          abi: SOLVER_REGISTRY_ABI,
          functionName: "solverAt",
          args: [BigInt(i)],
        })) as Address,
      );
    }
    return solvers;
  }

  // ---------------------------------------------------------------------- RWA

  async isAttested(token: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.addresses.rwaRegistry!,
      abi: RWA_REGISTRY_ABI,
      functionName: "isAttested",
      args: [token],
    }) as Promise<boolean>;
  }

  async attestationOf(token: Address) {
    return this.publicClient.readContract({
      address: this.addresses.rwaRegistry!,
      abi: RWA_REGISTRY_ABI,
      functionName: "attestationOf",
      args: [token],
    }) as Promise<any>;
  }

  async requestRwaOnboarding(args: {
    token?: Address;
    assetClass: number;
    assetRef: string;
    documentURI: string;
  }) {
    return this.write(this.addresses.rwaRegistry!, RWA_REGISTRY_ABI, "requestOnboarding", [
      args.token ?? "0x0000000000000000000000000000000000000000",
      args.assetClass,
      args.assetRef,
      args.documentURI,
    ]);
  }

  // -------------------------------------------------------------------- ERC20

  async balanceOf(token: Address, owner?: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner ?? this.address],
    }) as Promise<bigint>;
  }

  // ------------------------------------------------------------------ helpers

  /** Send a transaction and wait for it, surfacing reverts as errors rather than silent failures. */
  async write(address: Address, abi: readonly unknown[], functionName: string, args: unknown[], value?: bigint) {
    if (!this.walletClient || !this.account) {
      throw new Error("this client is read-only — construct it with a private key");
    }

    const { request } = await this.publicClient.simulateContract({
      address,
      abi: abi as any,
      functionName,
      args,
      account: this.account,
      ...(value === undefined ? {} : { value }),
    });

    const hash = await this.walletClient.writeContract(request as any);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${functionName} reverted (tx ${hash})`);
    }
    return hash;
  }
}
