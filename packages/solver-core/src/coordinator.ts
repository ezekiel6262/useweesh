import type { Address, Hex } from "viem";
import { IntentStatus, type IntentDraft } from "@intentos/intent-schema";
import type { IntentOSClient } from "@intentos/sdk";
import { rankBids, selectWinnerFrom, type RankedBid } from "./auction.js";
import { Quoter } from "./quotes.js";

/**
 * The auctioneer.
 *
 * Closing auctions is a service, not an authority: the coordinator holds a bond that anyone can
 * slash by pointing at a better bid it passed over, and it cannot affect the user's own floors
 * either way — those are enforced at settlement whichever solver wins. Agents that would rather
 * not stay online delegate the click; agents that do can select their own winner instead.
 */

export interface CoordinatorOptions {
  client: IntentOSClient;
  log?: (message: string) => void;
}

export interface SelectionReport {
  intentId: Hex;
  selected?: { solver: Address; bidId: number; feeBps: number };
  ranking: RankedBid[];
  skipped?: string;
  txHash?: Hex;
}

export class Coordinator {
  private readonly quoter: Quoter;
  private readonly reputationCache = new Map<Address, number>();

  constructor(private readonly options: CoordinatorOptions) {
    this.quoter = new Quoter({
      publicClient: options.client.publicClient,
      venues: options.client.deployment.routers.map((r) => ({ name: r.name, address: r.address })),
      intermediate: options.client.deployment.tokens.USDT,
    });
  }

  /** Close one auction, if it is ready to be closed. */
  async close(intentId: Hex, draft: IntentDraft): Promise<SelectionReport> {
    const record = await this.options.client.getIntent(intentId);

    if (record.status !== IntentStatus.OPEN) {
      return { intentId, ranking: [], skipped: `intent is ${IntentStatus[record.status].toLowerCase()}` };
    }
    // Chain time: `selectWinner` is checked against the timestamp of the block it lands in.
    // One block of margin, because a read is evaluated against the head while the transaction
    // lands in the block after it — without it every auction is attempted once too early.
    const now = BigInt(await this.options.client.chainNow());
    if (now <= record.auctionEndsAt) {
      return { intentId, ranking: [], skipped: "auction is still open" };
    }
    if (now > record.deadline) {
      return { intentId, ranking: [], skipped: "past the intent's deadline" };
    }

    const bids = await this.options.client.getBids(intentId);
    if (bids.length === 0) {
      return { intentId, ranking: [], skipped: "no bids" };
    }

    const notional = await this.estimateNotional(draft);
    const ranking = await rankBids(bids, {
      quoter: this.quoter,
      draft,
      notional,
      reputationOf: (solver) => this.reputationOf(solver),
    });

    const { winner, reason } = selectWinnerFrom(ranking, bids);
    if (!winner) {
      return { intentId, ranking, skipped: reason };
    }

    let txHash: Hex;
    try {
      txHash = await this.options.client.selectWinner(intentId, winner.bid.bidId);
    } catch (error) {
      // Losing the race to the head block is expected and self-correcting; the next pass
      // will close the same auction a second later.
      if (/AuctionStillOpen/.test((error as Error).message)) {
        return { intentId, ranking, skipped: "auction closed between the read and the write" };
      }
      throw error;
    }
    this.options.log?.(
      `selected ${winner.bid.solver} for ${intentId.slice(0, 10)}… at ${winner.bid.feeBps} bps ` +
        `(${ranking.length} bid${ranking.length === 1 ? "" : "s"})`,
    );

    return {
      intentId,
      selected: { solver: winner.bid.solver, bidId: winner.bid.bidId, feeBps: winner.bid.feeBps },
      ranking,
      txHash,
    };
  }

  /** For a rebalance the notional is whatever the exits raise, so it has to be quoted. */
  private async estimateNotional(draft: IntentDraft): Promise<bigint> {
    let notional = draft.outcome.inputAmount;
    for (const exit of draft.outcome.exits) {
      const quote = await this.quoter.best(exit.token, draft.outcome.inputToken, exit.amountIn);
      notional += quote?.amountOut ?? exit.minOut;
    }
    return notional;
  }

  private async reputationOf(solver: Address): Promise<number> {
    const cached = this.reputationCache.get(solver);
    if (cached !== undefined) return cached;
    const record = await this.options.client.getSolver(solver);
    this.reputationCache.set(solver, record.reputationBps);
    return record.reputationBps;
  }

  /** Reputation moves as intents settle; drop the cache between auction rounds. */
  refresh(): void {
    this.reputationCache.clear();
  }
}
