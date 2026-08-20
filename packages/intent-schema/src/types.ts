import type { Address, Hex } from "viem";

/**
 * IntentOS Intent Standard v0.1.
 *
 * An intent is a commitment to an *outcome*, not to a transaction. Everything here is mirrored
 * by contracts/contracts/libraries/IntentLib.sol; `hash.ts` reproduces its encoding exactly.
 */

/** Matches IntentLib.Kind — the enum ordering is part of the wire format. */
export enum IntentKind {
  SWAP = 0,
  BASKET = 1,
  REBALANCE = 2,
  RWA_ONBOARD = 3,
  BATCH = 4,
}

/** Matches IntentLib.Status. */
export enum IntentStatus {
  NONE = 0,
  OPEN = 1,
  SELECTED = 2,
  FULFILLED = 3,
  CANCELLED = 4,
  EXPIRED = 5,
}

export const BPS = 10_000;

export interface BasketLeg {
  /** Output token to acquire. */
  token: Address;
  /** Share of the input notional to spend on this leg. All legs must sum to 10_000. */
  weightBps: number;
  /** Hard floor on units received. Enforced onchain at settlement. */
  minOut: bigint;
}

export interface ExitLeg {
  token: Address;
  amountIn: bigint;
  /** Floor on base-asset units received for this leg. */
  minOut: bigint;
}

export interface Outcome {
  kind: IntentKind;
  /** Asset the user parts with. For REBALANCE this is the base asset the exits route through. */
  inputToken: Address;
  /** 0 for a pure REBALANCE — the exit legs fund the entries. */
  inputAmount: bigint;
  recipient: Address;
  maxSlippageBps: number;
  legs: BasketLeg[];
  exits: ExitLeg[];
}

export interface Policy {
  /** Hard cap on input notional. 0 means uncapped. */
  maxNotional: bigint;
  validAfter: bigint;
  validUntil: bigint;
  maxFeeBps: number;
  /** Floor on the winning solver's reputation, in bps of the EMA score. */
  minReputationBps: number;
  /** Every acquired asset must carry a live attestation in the RWARegistry. */
  requireRwaAttested: boolean;
  /** If non-empty, restricts every token the intent may touch. */
  tokenAllowlist: Address[];
}

/** A submitted intent, before it has an onchain id. */
export interface IntentDraft {
  outcome: Outcome;
  policy: Policy;
  salt: Hex;
  auctionEndsAt: bigint;
  deadline: bigint;
  /** Free-form provenance: the natural-language request, the agent that produced it, notes. */
  metadata: IntentMetadata;
}

export interface IntentMetadata {
  /** The original request, when the intent came from natural language. */
  prompt?: string;
  /** How the intent was produced: which parser, which model. */
  source?: string;
  /** Human-readable restatement of the declared outcome. */
  summary?: string;
  /** Recurrence declared by the user; executed by the agent runtime, one submission per period. */
  schedule?: RecurrenceRule;
  /** Preconditions that must hold before the intent is worth serving. */
  conditions?: Condition[];
  /** Ids of the sibling intents when this one is part of a BATCH. */
  batch?: Hex[];
  [key: string]: unknown;
}

/** Recurring / policy-based intents. Evaluated offchain by the agent runtime. */
export interface RecurrenceRule {
  everySeconds: number;
  /** Stop after this many submissions. Omitted means open-ended. */
  maxRuns?: number;
  /** First submission time, seconds since epoch. */
  startAt?: number;
}

/**
 * A precondition on an intent. Conditions are evaluated by solvers and by the coordinator
 * before an auction opens; an intent whose conditions do not hold is left unserved rather
 * than settled at a bad moment.
 */
export interface Condition {
  kind: "price" | "drawdown" | "volatility" | "time" | "portfolio-drift";
  /** Token or symbol the condition is about. */
  subject?: string;
  operator: "lt" | "lte" | "gt" | "gte";
  /** Threshold, in the natural unit of the condition (USD price, percent, timestamp). */
  value: number;
  window?: string;
}

export interface IntentRecord {
  intentId: Hex;
  owner: Address;
  kind: IntentKind;
  status: IntentStatus;
  legCount: number;
  createdAt: bigint;
  auctionEndsAt: bigint;
  deadline: bigint;
  outcomeHash: Hex;
  policyHash: Hex;
  selectedSolver: Address;
  selectedBid: number;
  ownerSelected: boolean;
}

export interface SolverBid {
  bidId: number;
  solver: Address;
  feeBps: number;
  etaSeconds: number;
  planHash: Hex;
  /** Binding per-leg floors, aligned with `Outcome.legs`. */
  guaranteedOut: bigint[];
  withdrawn: boolean;
}

/** A concrete route for one leg. `path[0]` is spent, `path[last]` is received. */
export interface Route {
  router: Address;
  path: Address[];
}

/** What a solver commits to in an auction, before it becomes an onchain bid. */
export interface ExecutionPlan {
  intentId: Hex;
  solver: Address;
  entryRoutes: Route[];
  exitRoutes: Route[];
  /** Quoted output per acquisition leg, before the solver's safety margin. */
  quotedOut: bigint[];
  /** What the solver is willing to guarantee onchain. */
  guaranteedOut: bigint[];
  feeBps: number;
  etaSeconds: number;
  /** Solver's own scoring breakdown, surfaced in the dashboard. */
  scoring: PlanScoring;
}

export interface PlanScoring {
  /** Total quoted output value in base-asset units. */
  quotedValue: number;
  /** Estimated gas cost in base-asset units. */
  gasCost: number;
  /** Fee charged to the user in base-asset units. */
  feeCost: number;
  /** Modelled price impact across all legs, in bps. */
  priceImpactBps: number;
  /** Solver's estimated probability the plan settles without reverting, 0..1. */
  successProbability: number;
  /** Composite objective actually maximised by the solver. */
  score: number;
  notes: string[];
}
