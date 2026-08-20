/**
 * Solver strategies.
 *
 * A solver network is only worth having if the solvers actually differ. These knobs are the ones
 * that change what a solver bids: how much of the quote it is willing to guarantee, what it
 * charges, how it trades off delivered value against the risk of missing its own guarantee, and
 * how it sizes a leg it cannot fully price.
 */
export interface SolverStrategy {
  name: string;
  /** How far below the quote the solver is willing to be bound, in bps. */
  safetyMarginBps: number;
  /** The solver's success fee, in bps of notional. */
  feeBps: number;
  /**
   * Weight on the risk of a plan reverting, relative to the value it delivers. A risk-averse
   * solver guarantees less and bids less aggressively; a tight one wins more auctions and
   * loses more reputation when a leg moves against it.
   */
  riskAversion: number;
  /** Estimated gas cost per leg, expressed in base-asset units. */
  gasPerLegBase: bigint;
  /** Refuse to bid when the expected surplus over the user's floors is thinner than this, in bps. */
  minEdgeBps: number;
  /** Seconds the solver claims it needs to settle after winning. */
  etaSeconds: number;
}

/** Guarantees close to the quote and charges little: wins on price, carries more revert risk. */
export const AGGRESSIVE: SolverStrategy = {
  name: "aggressive",
  safetyMarginBps: 15,
  feeBps: 8,
  riskAversion: 0.4,
  gasPerLegBase: 20_000n, // 0.02 USDT — X Layer gas is cheap enough that routing dominates
  minEdgeBps: 5,
  etaSeconds: 20,
};

/** Leaves headroom under every guarantee: loses some auctions, rarely fails one it wins. */
export const CONSERVATIVE: SolverStrategy = {
  name: "conservative",
  safetyMarginBps: 60,
  feeBps: 15,
  riskAversion: 1.6,
  gasPerLegBase: 20_000n,
  minEdgeBps: 20,
  etaSeconds: 35,
};

/** Middle of the road; the default for a solver that has not been tuned. */
export const BALANCED: SolverStrategy = {
  name: "balanced",
  safetyMarginBps: 30,
  feeBps: 12,
  riskAversion: 1.0,
  gasPerLegBase: 20_000n,
  minEdgeBps: 10,
  etaSeconds: 25,
};

export const STRATEGIES: Record<string, SolverStrategy> = {
  aggressive: AGGRESSIVE,
  conservative: CONSERVATIVE,
  balanced: BALANCED,
};
