import type { Address } from "viem";
import { BPS, type IntentDraft, type SolverBid } from "@intentos/intent-schema";
import type { Quoter } from "./quotes.js";

/**
 * Winner selection.
 *
 * Bids guarantee different baskets, so ranking them means valuing each guarantee vector in the
 * intent's own base asset and subtracting what the solver charges. Reputation breaks near-ties,
 * which is what gives the onchain score something to buy.
 *
 * The dominance guard matters as much as the ranking: IntentRegistry lets anyone slash the
 * auctioneer for passing over a bid that is better on every axis, so a coordinator that would
 * pick a dominated bid is stopped here rather than punished onchain.
 */

export interface RankedBid {
  bid: SolverBid;
  /** Guaranteed basket valued in the input asset. */
  guaranteedValue: bigint;
  feeCost: bigint;
  reputationBps: number;
  score: number;
  ineligible?: string;
}

export interface RankOptions {
  quoter: Quoter;
  draft: IntentDraft;
  notional: bigint;
  reputationOf: (solver: Address) => Promise<number> | number;
  /** How much a full reputation advantage is worth, as a share of guaranteed value. */
  reputationWeight?: number;
}

export async function rankBids(bids: SolverBid[], options: RankOptions): Promise<RankedBid[]> {
  const { draft, quoter, notional } = options;
  const weight = options.reputationWeight ?? 0.02;

  const ranked = await Promise.all(
    bids.map(async (bid): Promise<RankedBid> => {
      const reputationBps = await options.reputationOf(bid.solver);
      const feeCost = (notional * BigInt(bid.feeBps)) / BigInt(BPS);

      let guaranteedValue = 0n;
      let unpriced = false;
      for (const [i, leg] of draft.outcome.legs.entries()) {
        const value = await quoter.valueIn(leg.token, draft.outcome.inputToken, bid.guaranteedOut[i] ?? 0n);
        if (value === null) {
          unpriced = true;
          break;
        }
        guaranteedValue += value;
      }

      const base: RankedBid = { bid, guaranteedValue, feeCost, reputationBps, score: 0 };

      if (bid.withdrawn) return { ...base, ineligible: "withdrawn" };
      if (unpriced) return { ...base, ineligible: "guarantee cannot be valued" };
      if (bid.feeBps > draft.policy.maxFeeBps) return { ...base, ineligible: "fee above the intent's cap" };
      if (reputationBps < draft.policy.minReputationBps) {
        return { ...base, ineligible: "reputation below the intent's floor" };
      }

      const net = Number(guaranteedValue - feeCost);
      base.score = net * (1 + weight * (reputationBps / BPS));
      return base;
    }),
  );

  return ranked.sort((a, b) => {
    if (a.ineligible && !b.ineligible) return 1;
    if (b.ineligible && !a.ineligible) return -1;
    return b.score - a.score;
  });
}

/** True when `a` is at least as good as `b` everywhere and strictly better somewhere. */
export function dominates(a: SolverBid, b: SolverBid): boolean {
  if (a.feeBps > b.feeBps) return false;
  if (a.guaranteedOut.length !== b.guaranteedOut.length) return false;

  let strict = a.feeBps < b.feeBps;
  for (const [i, guaranteed] of a.guaranteedOut.entries()) {
    const other = b.guaranteedOut[i]!;
    if (guaranteed < other) return false;
    if (guaranteed > other) strict = true;
  }
  return strict;
}

/** Any recorded bid that dominates the chosen one — a slashable selection if it exists. */
export function findDominatingBid(bids: SolverBid[], chosen: SolverBid): SolverBid | undefined {
  return bids.find((bid) => !bid.withdrawn && bid.solver !== chosen.solver && dominates(bid, chosen));
}

export interface SelectionResult {
  winner?: RankedBid;
  rejected: RankedBid[];
  /** Set when no bid could be selected safely. */
  reason?: string;
}

export function selectWinnerFrom(ranked: RankedBid[], allBids: SolverBid[]): SelectionResult {
  const eligible = ranked.filter((r) => !r.ineligible);
  if (eligible.length === 0) {
    return { rejected: ranked, reason: "no eligible bids" };
  }

  for (const candidate of eligible) {
    const dominating = findDominatingBid(allBids, candidate.bid);
    if (!dominating) {
      return { winner: candidate, rejected: ranked.filter((r) => r !== candidate) };
    }
    // Ranking and dominance disagreeing means the valuation is stale; skip rather than get slashed.
    candidate.ineligible = `dominated by bid ${dominating.solver}`;
  }

  return { rejected: ranked, reason: "every bid was dominated by another" };
}
