import { type Address, type Hex, toHex } from "viem";
import { BPS, IntentKind, type BasketLeg, type ExitLeg, type IntentDraft, type Outcome, type Policy } from "./types.js";

/** Constructors for well-formed outcomes. Everything here keeps `checkOutcomeInvariants` happy. */

/** Split 10_000 bps across `count` legs, giving the remainder to the first leg. */
export function equalWeights(count: number): number[] {
  if (count <= 0) throw new Error("equalWeights needs at least one leg");
  const base = Math.floor(BPS / count);
  const weights = new Array<number>(count).fill(base);
  weights[0] = base + (BPS - base * count);
  return weights;
}

/** Turn arbitrary positive weights (percentages, dollar targets, scores) into exact bps. */
export function normalizeWeights(raw: number[]): number[] {
  const total = raw.reduce((sum, w) => sum + w, 0);
  if (total <= 0) throw new Error("weights must sum to something positive");

  const scaled = raw.map((w) => Math.floor((w / total) * BPS));
  const drift = BPS - scaled.reduce((sum, w) => sum + w, 0);
  // Hand the rounding remainder to the largest leg, where it is proportionally smallest.
  let largest = 0;
  for (let i = 1; i < scaled.length; i++) if (scaled[i]! > scaled[largest]!) largest = i;
  scaled[largest] = scaled[largest]! + drift;
  return scaled;
}

/** Apply a slippage tolerance to a quote to get a binding floor. */
export function applySlippage(quoted: bigint, slippageBps: number): bigint {
  return (quoted * BigInt(BPS - slippageBps)) / BigInt(BPS);
}

export interface BasketTarget {
  token: Address;
  /** Omit to weight the basket equally. */
  weightBps?: number;
  /** Quote for this leg's share of the notional, used to derive `minOut`. */
  quotedOut?: bigint;
  /** Explicit floor. Wins over the quote-derived one when both are given. */
  minOut?: bigint;
}

export interface BuildBasketArgs {
  inputToken: Address;
  inputAmount: bigint;
  recipient: Address;
  targets: BasketTarget[];
  maxSlippageBps: number;
  kind?: IntentKind;
}

export function buildBasketOutcome(args: BuildBasketArgs): Outcome {
  const weights = resolveWeights(args.targets);
  const legs: BasketLeg[] = args.targets.map((target, i) => ({
    token: target.token,
    weightBps: weights[i]!,
    minOut: target.minOut ?? (target.quotedOut ? applySlippage(target.quotedOut, args.maxSlippageBps) : 0n),
  }));

  return {
    kind: args.kind ?? (legs.length === 1 ? IntentKind.SWAP : IntentKind.BASKET),
    inputToken: args.inputToken,
    inputAmount: args.inputAmount,
    recipient: args.recipient,
    maxSlippageBps: args.maxSlippageBps,
    legs,
    exits: [],
  };
}

export interface BuildRebalanceArgs {
  baseToken: Address;
  recipient: Address;
  exits: ExitLeg[];
  targets: BasketTarget[];
  maxSlippageBps: number;
  /** Extra base-asset capital to add on top of what the exits raise. */
  topUp?: bigint;
}

export function buildRebalanceOutcome(args: BuildRebalanceArgs): Outcome {
  const weights = resolveWeights(args.targets);
  return {
    kind: IntentKind.REBALANCE,
    inputToken: args.baseToken,
    inputAmount: args.topUp ?? 0n,
    recipient: args.recipient,
    maxSlippageBps: args.maxSlippageBps,
    legs: args.targets.map((target, i) => ({
      token: target.token,
      weightBps: weights[i]!,
      minOut: target.minOut ?? (target.quotedOut ? applySlippage(target.quotedOut, args.maxSlippageBps) : 0n),
    })),
    exits: args.exits,
  };
}

function resolveWeights(targets: BasketTarget[]): number[] {
  const explicit = targets.filter((t) => t.weightBps !== undefined);
  if (explicit.length === 0) return equalWeights(targets.length);
  if (explicit.length !== targets.length) {
    throw new Error("weight every leg or none of them — partial weights are ambiguous");
  }
  const given = targets.map((t) => t.weightBps!);
  const total = given.reduce((sum, w) => sum + w, 0);
  return total === BPS ? given : normalizeWeights(given);
}

export function defaultPolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    maxNotional: 0n,
    validAfter: 0n,
    validUntil: 0n,
    maxFeeBps: 30,
    minReputationBps: 0,
    requireRwaAttested: false,
    requireCompliant: false,
    sponsorGas: false,
    tokenAllowlist: [],
    ...overrides,
  };
}

export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export interface DraftArgs {
  outcome: Outcome;
  policy?: Policy;
  /** Seconds solvers get to bid. */
  auctionSeconds?: number;
  /** Seconds from now until the intent may no longer settle. */
  ttlSeconds?: number;
  metadata?: IntentDraft["metadata"];
  now?: number;
}

export function draftIntent(args: DraftArgs): IntentDraft {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const auctionSeconds = args.auctionSeconds ?? 20;
  const ttlSeconds = args.ttlSeconds ?? 600;
  if (ttlSeconds <= auctionSeconds) throw new Error("ttlSeconds must exceed auctionSeconds");

  return {
    outcome: args.outcome,
    policy: args.policy ?? defaultPolicy(),
    salt: randomSalt(),
    auctionEndsAt: BigInt(now + auctionSeconds),
    deadline: BigInt(now + ttlSeconds),
    metadata: { ...(args.metadata ?? {}), createdAt: now },
  };
}

/**
 * Re-stamp a draft's timing against a fresh clock, keeping the windows it was built with.
 *
 * An intent commits to its auction window and deadline, so a draft that sat around while
 * approvals were mined can arrive already expired. Re-timing just before submission keeps a
 * short auction window usable without widening it "just in case".
 */
export function retimeDraft(
  draft: IntentDraft,
  args: { now: number; auctionSeconds?: number; ttlSeconds?: number },
): IntentDraft {
  const originalAuction = Number(draft.deadline - draft.auctionEndsAt);
  const auctionSeconds = args.auctionSeconds ?? 20;
  const ttlSeconds = args.ttlSeconds ?? auctionSeconds + originalAuction;
  if (ttlSeconds <= auctionSeconds) throw new Error("ttlSeconds must exceed auctionSeconds");

  return {
    ...draft,
    auctionEndsAt: BigInt(args.now + auctionSeconds),
    deadline: BigInt(args.now + ttlSeconds),
    metadata: { ...draft.metadata, createdAt: args.now },
  };
}
