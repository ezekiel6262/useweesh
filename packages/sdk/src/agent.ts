import type { Address, Hex } from "viem";
import {
  IntentStatus,
  type IntentDraft,
  type IntentRecord,
  type SolverBid,
} from "@intentos/intent-schema";
import { explainDraft, parseIntent, type ParsedIntent, type ParseOptions } from "@intentos/intent-ai";
import { IntentOSClient } from "./client.js";

/**
 * The agent-facing surface of IntentOS.
 *
 * An autonomous agent should be able to go from a sentence to a settled position without
 * knowing what a router is. `declare` parses and submits; `track` follows the intent to a
 * terminal state. Everything an agent signs is a validated draft it can also read back in
 * plain language, which is what makes unattended operation reasonable.
 */

export interface DeclareOptions extends Partial<Omit<ParseOptions, "catalog" | "recipient">> {
  /** Where acquired assets land. Defaults to the agent's own address. */
  recipient?: Address;
  /** Parse and explain, but do not send anything. */
  dryRun?: boolean;
  metadataURI?: string;
  /** Coordinator relay that pays `submitFor`. When set, declare prefers the gasless path. */
  relayUrl?: string;
  /** Force gasless (no fallback to a gas-paying `submit`). */
  gasless?: boolean;
}

export interface DeclarationResult {
  parsed: ParsedIntent;
  /** The draft as submitted — re-timed against the chain's clock, so it is what solvers must match. */
  draft: IntentDraft;
  explanation: string;
  intentId?: Hex;
  txHash?: Hex;
  submitted: boolean;
  /** True when the coordinator relayed `submitFor` instead of the agent paying gas. */
  gasless?: boolean;
  /** Set when the intent was held back because the parse needs a human answer. */
  heldFor?: string[];
}

export class IntentAgent {
  constructor(readonly client: IntentOSClient) {}

  /** Turn a request into a submitted intent. */
  async declare(request: string, options: DeclareOptions = {}): Promise<DeclarationResult> {
    const parsed = await parseIntent(request, {
      ...options,
      catalog: this.client.catalog,
      recipient: options.recipient ?? this.client.address,
      quote: options.quote,
      now: options.now ?? (await this.client.chainNow()),
    });

    const explanation = explainDraft(parsed.draft, { catalog: this.client.catalog });

    // A parse that still has open questions is not something to sign on the user's behalf.
    if (parsed.clarifications.length > 0) {
      return { parsed, draft: parsed.draft, explanation, submitted: false, heldFor: parsed.clarifications };
    }
    if (options.dryRun) {
      return { parsed, draft: parsed.draft, explanation, submitted: false };
    }

    const relayUrl = options.relayUrl;
    const preferGasless = Boolean(relayUrl) && options.gasless !== false;
    if (preferGasless && relayUrl) {
      try {
        const { intentId, hash, draft } = await this.client.submitIntentGasless(parsed.draft, {
          relayUrl,
          metadataURI: options.metadataURI ?? "",
          auctionSeconds: options.auctionSeconds,
          ttlSeconds: options.ttlSeconds,
        });
        return { parsed, draft, explanation, intentId, txHash: hash, submitted: true, gasless: true };
      } catch (error) {
        if (options.gasless === true) throw error;
      }
    }

    const { intentId, hash, draft } = await this.client.submitIntent(parsed.draft, {
      metadataURI: options.metadataURI ?? "",
      auctionSeconds: options.auctionSeconds,
      ttlSeconds: options.ttlSeconds,
    });
    return { parsed, draft, explanation, intentId, txHash: hash, submitted: true, gasless: false };
  }

  /**
   * Every intent this owner (human or agent) has submitted, newest first.
   * Same registry index the compose app and `/history` read.
   */
  async history(owner?: Address, limit = 50) {
    const who = owner ?? this.client.account?.address;
    if (!who) throw new Error("pass an owner address — this client has no signer");
    const ids = await this.client.listIntentsOf(who, limit);
    return Promise.all(
      ids.map(async (intentId) => {
        const record = await this.client.getIntent(intentId);
        const bids = await this.client.getBids(intentId);
        return { ...record, bidCount: bids.filter((b) => !b.withdrawn).length };
      }),
    );
  }

  /** Submit a draft that was built directly rather than parsed. */
  async submit(draft: IntentDraft, metadataURI = ""): Promise<{ intentId: Hex; txHash: Hex; draft: IntentDraft }> {
    const result = await this.client.submitIntent(draft, { metadataURI });
    return { intentId: result.intentId, txHash: result.hash, draft: result.draft };
  }

  /** Poll an intent until it settles, is cancelled, or runs out of time. */
  async track(
    intentId: Hex,
    options: { pollMs?: number; timeoutMs?: number; onUpdate?: (record: IntentRecord) => void } = {},
  ): Promise<IntentRecord> {
    const pollMs = options.pollMs ?? 1_000;
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    let lastStatus: IntentStatus | undefined;

    for (;;) {
      const record = await this.client.getIntent(intentId);
      if (record.status !== lastStatus) {
        lastStatus = record.status;
        options.onUpdate?.(record);
      }
      if (
        record.status === IntentStatus.FULFILLED ||
        record.status === IntentStatus.CANCELLED ||
        record.status === IntentStatus.EXPIRED
      ) {
        return record;
      }
      if (Date.now() > deadline) {
        throw new Error(`gave up waiting on intent ${intentId} (last status: ${IntentStatus[record.status]})`);
      }
      await sleep(pollMs);
    }
  }

  async bidsFor(intentId: Hex): Promise<SolverBid[]> {
    return this.client.getBids(intentId);
  }

  /** What the agent holds across the whole tradable universe, for reporting and rebalancing. */
  async portfolio(owner?: Address): Promise<{ symbol: string; token: Address; balance: bigint; decimals: number }[]> {
    const holder = owner ?? this.client.address;
    const assets = this.client.catalog.all();
    return Promise.all(
      assets.map(async (asset) => ({
        symbol: asset.symbol,
        token: asset.address,
        decimals: asset.decimals,
        balance: await this.client.balanceOf(asset.address, holder),
      })),
    );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
