import type { Address } from "viem";
import { BPS, hashPlan, type ExecutionPlan, type IntentDraft, type PlanScoring, type Route } from "@intentos/intent-schema";
import { Quoter } from "./quotes.js";
import type { SolverStrategy } from "./strategy.js";

/**
 * Turns a declared outcome into a concrete plan, then scores it.
 *
 * The planner is the part of a solver that is actually competitive. It sizes every leg exactly
 * the way settlement will — from the user's committed weights, not from anything the solver
 * chooses — and then searches the venues for the best way to fill each one. What it optimises is
 * not raw output but output the solver is willing to be held to: every leg's guarantee goes
 * onchain in the bid, and settlement enforces it.
 */

export interface PlannerOptions {
  quoter: Quoter;
  strategy: SolverStrategy;
  solver: Address;
}

export interface PlanResult {
  plan?: ExecutionPlan;
  /** Why the solver is not bidding, when it is not. */
  declined?: string;
}

export async function planIntent(
  intentId: `0x${string}`,
  draft: IntentDraft,
  options: PlannerOptions,
): Promise<PlanResult> {
  const { quoter, strategy } = options;
  const { outcome } = draft;
  const notes: string[] = [];

  // 1. Exits first: a rebalance's entry budget is whatever the sells actually raise.
  const exitRoutes: Route[] = [];
  let notional = outcome.inputAmount;

  for (const [i, exit] of outcome.exits.entries()) {
    const quote = await quoter.best(exit.token, outcome.inputToken, exit.amountIn);
    if (!quote) return { declined: `no venue prices exit leg ${i}` };
    if (quote.amountOut < exit.minOut) {
      return { declined: `exit leg ${i} quotes below the user's floor` };
    }
    exitRoutes.push(quote.route);
    notional += quote.amountOut;
    notes.push(`exit ${i} via ${quote.venue.name}`);
  }

  if (notional === 0n) return { declined: "the intent funds nothing" };

  // 2. The fee comes off the top, exactly as settlement takes it.
  const feeBps = Math.min(strategy.feeBps, draft.policy.maxFeeBps);
  const fee = (notional * BigInt(feeBps)) / BigInt(BPS);
  const spendable = notional - fee;

  // 3. Size each leg from the committed weights, last leg absorbing the remainder.
  const entryRoutes: Route[] = [];
  const quotedOut: bigint[] = [];
  const guaranteedOut: bigint[] = [];
  let spent = 0n;
  let deliveredValue = 0n;
  let riskiestLegBps = 0;

  for (const [i, leg] of outcome.legs.entries()) {
    const last = i + 1 === outcome.legs.length;
    const amountIn = last ? spendable - spent : (spendable * BigInt(leg.weightBps)) / BigInt(BPS);
    spent += amountIn;

    // A cash sleeve: the leg is the input asset, so nothing needs routing.
    if (leg.token.toLowerCase() === outcome.inputToken.toLowerCase()) {
      entryRoutes.push({ router: quoter.venues[0]!.address, path: [outcome.inputToken, leg.token] });
      quotedOut.push(amountIn);
      guaranteedOut.push(amountIn);
      deliveredValue += amountIn;
      continue;
    }

    const quote = await quoter.best(outcome.inputToken, leg.token, amountIn);
    if (!quote) return { declined: `no venue prices leg ${i}` };

    const guarantee = (quote.amountOut * BigInt(BPS - strategy.safetyMarginBps)) / BigInt(BPS);
    if (guarantee < leg.minOut) {
      return { declined: `leg ${i} cannot be guaranteed above the user's floor` };
    }

    entryRoutes.push(quote.route);
    quotedOut.push(quote.amountOut);
    guaranteedOut.push(guarantee);
    notes.push(`leg ${i} via ${quote.venue.name}`);

    // Value the leg back in the base asset so heterogeneous baskets are comparable.
    const value = await quoter.valueIn(leg.token, outcome.inputToken, quote.amountOut);
    if (value === null) return { declined: `leg ${i} cannot be valued back into the base asset` };
    deliveredValue += value;

    // How close this leg sits to the floor it must clear — the plan's real failure mode.
    const headroomBps = Number(((quote.amountOut - leg.minOut) * BigInt(BPS)) / quote.amountOut);
    riskiestLegBps = Math.max(riskiestLegBps, BPS - headroomBps);
  }

  // 4. Capital deployment: settlement rejects a plan that leaves too much behind.
  const requiredSpend = (spendable * BigInt(BPS - outcome.maxSlippageBps)) / BigInt(BPS);
  if (spent < requiredSpend) {
    return { declined: "the plan would leave more of the notional undeployed than the intent allows" };
  }

  const scoring = scorePlan({
    notional,
    spendable,
    fee,
    deliveredValue,
    legCount: outcome.legs.length,
    riskiestLegBps,
    strategy,
    notes,
  });

  const edgeBps = Number(((deliveredValue - spendable) * BigInt(BPS)) / (spendable === 0n ? 1n : spendable));
  if (edgeBps < -strategy.minEdgeBps - outcome.maxSlippageBps) {
    return { declined: `routing costs exceed what this solver will absorb (${edgeBps} bps)` };
  }

  return {
    plan: {
      intentId,
      solver: options.solver,
      entryRoutes,
      exitRoutes,
      quotedOut,
      guaranteedOut,
      feeBps,
      etaSeconds: strategy.etaSeconds,
      scoring,
    },
  };
}

interface ScoreInputs {
  notional: bigint;
  spendable: bigint;
  fee: bigint;
  deliveredValue: bigint;
  legCount: number;
  riskiestLegBps: number;
  strategy: SolverStrategy;
  notes: string[];
}

/**
 * The solver's objective. Delivered value, discounted by the chance the plan reverts, net of the
 * fee it charges and the gas it will burn. Expressed in base-asset units so a four-leg xStocks
 * basket and a single swap are scored on the same axis.
 */
export function scorePlan(inputs: ScoreInputs): PlanScoring {
  const { strategy } = inputs;
  const gasCost = strategy.gasPerLegBase * BigInt(inputs.legCount);

  // Risk rises with how tight the tightest leg is and with the number of legs that must all
  // clear in one transaction.
  const tightness = Math.min(1, inputs.riskiestLegBps / BPS);
  const legPenalty = 1 - Math.pow(0.995, inputs.legCount);
  const failureOdds = Math.min(0.5, (tightness * 0.15 + legPenalty) * strategy.riskAversion);
  const successProbability = 1 - failureOdds;

  const toNumber = (value: bigint) => Number(value);
  const quotedValue = toNumber(inputs.deliveredValue);
  const feeCost = toNumber(inputs.fee);
  const gas = toNumber(gasCost);

  const priceImpactBps =
    inputs.spendable === 0n
      ? 0
      : Number(((inputs.spendable - inputs.deliveredValue) * BigInt(BPS)) / inputs.spendable);

  return {
    quotedValue,
    gasCost: gas,
    feeCost,
    priceImpactBps,
    successProbability,
    score: quotedValue * successProbability - feeCost - gas,
    notes: inputs.notes,
  };
}

export function planHashOf(plan: ExecutionPlan): `0x${string}` {
  return hashPlan(plan.entryRoutes, plan.exitRoutes);
}
