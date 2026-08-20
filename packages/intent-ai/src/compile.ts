import {
  IntentKind,
  buildBasketOutcome,
  buildRebalanceOutcome,
  draftIntent,
  parseIntentDraft,
  type Address,
  type ExitLeg,
  type IntentDraft,
  type Policy,
} from "@intentos/intent-schema";
import { type AssetCatalog, parseAmount } from "./catalog.js";
import { describeSpec } from "./grammar.js";
import type { IntentSpec } from "./spec.js";

/**
 * Turns an IntentSpec into a validated IntentDraft.
 *
 * Everything the language model produced is treated as a proposal: symbols are resolved against
 * the onchain catalog, decimal amounts become base units here, percentages become basis points
 * here, and the result is run through the standard's own validation before it is returned. A
 * draft that leaves this function is one the contracts will accept.
 */

export interface CompileOptions {
  catalog: AssetCatalog;
  /** Where the acquired assets should land. Usually the submitting account. */
  recipient: Address;
  /** Optional live quoting, used to turn the slippage tolerance into binding per-leg floors. */
  quote?: QuoteFn;
  auctionSeconds?: number;
  /** Fallback lifetime when the request itself did not say how long the intent should live. */
  ttlSeconds?: number;
  /** Provenance recorded on the intent. */
  source?: string;
  prompt?: string;
  now?: number;
}

export type QuoteFn = (tokenIn: Address, tokenOut: Address, amountIn: bigint) => Promise<bigint>;

export class CompileError extends Error {
  constructor(message: string, public readonly clarifications: string[] = []) {
    super(message);
    this.name = "CompileError";
  }
}

const PERCENT_TO_BPS = 100;

function resolveRecipient(spec: IntentSpec, fallback: Address): Address {
  if (!spec.payTo) return fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(spec.payTo)) {
    throw new CompileError("pay-to is not a 20-byte address", spec.clarifications);
  }
  return spec.payTo as Address;
}

export async function compileSpec(spec: IntentSpec, options: CompileOptions): Promise<IntentDraft> {
  const { catalog } = options;

  if (spec.targets.length === 0) {
    throw new CompileError("the intent names no assets to acquire", spec.clarifications);
  }

  const recipient = resolveRecipient(spec, options.recipient);
  const input = catalog.resolve(spec.inputSymbol);
  const targets = spec.targets.map((target) => ({ ...target, asset: catalog.resolve(target.symbol) }));
  const exits: (ExitLeg & { symbol: string })[] = spec.exits.map((exit) => {
    const asset = catalog.resolve(exit.symbol);
    return {
      symbol: asset.symbol,
      token: asset.address,
      amountIn: parseAmount(exit.amount, asset.decimals),
      minOut: 0n,
    };
  });

  const isRebalance = spec.action === "rebalance";
  if (!isRebalance && spec.inputAmount === null) {
    throw new CompileError(`the intent does not say how much ${input.symbol} to deploy`, spec.clarifications);
  }
  if (isRebalance && exits.length === 0) {
    throw new CompileError("a rebalance needs at least one position to sell", spec.clarifications);
  }

  const inputAmount = spec.inputAmount === null ? 0n : parseAmount(spec.inputAmount, input.decimals);
  const maxSlippageBps = clampBps(Math.round(spec.maxSlippagePercent * PERCENT_TO_BPS), 0, 2_000);

  // Size each leg the way settlement will, so the quotes we ask for match what actually trades.
  const weights = resolveWeightsPercent(targets.map((t) => t.weightPercent));
  const notional = isRebalance ? await estimateRebalanceNotional(exits, input.address, options) : inputAmount;

  // Floors are derived from what will actually be spent, not from the gross notional: the
  // solver's fee comes off the top before any leg is bought, so quoting the gross amount would
  // set a floor no honest solver could clear.
  const maxFeeBps = clampBps(Math.round((spec.maxFeePercent ?? (spec.action === "pay" ? 0 : 0.3)) * PERCENT_TO_BPS), 0, 1_000);
  const spendable = (notional * BigInt(10_000 - maxFeeBps)) / 10_000n;

  const quoted = await Promise.all(
    targets.map(async (target, i) => {
      if (!options.quote || spendable === 0n) return undefined;
      const legNotional = (spendable * BigInt(weights[i]!)) / 10_000n;
      if (legNotional === 0n) return undefined;
      try {
        return await options.quote(input.address, target.asset.address, legNotional);
      } catch {
        // A leg nobody can quote yet is left with a zero floor; the winning solver's own
        // auction guarantee still binds it onchain.
        return undefined;
      }
    }),
  );

  const legTargets = targets.map((target, i) => ({
    token: target.asset.address,
    weightBps: weights[i]!,
    quotedOut: quoted[i],
  }));

  const outcome = isRebalance
    ? buildRebalanceOutcome({
        baseToken: input.address,
        recipient,
        exits: exits.map(({ token, amountIn, minOut }) => ({ token, amountIn, minOut })),
        targets: legTargets,
        maxSlippageBps,
        topUp: inputAmount,
      })
    : buildBasketOutcome({
        inputToken: input.address,
        inputAmount,
        recipient,
        targets: legTargets,
        maxSlippageBps,
        kind:
          spec.action === "onboard_rwa"
            ? IntentKind.RWA_ONBOARD
            : spec.action === "pay"
              ? IntentKind.PAYMENT
              : undefined,
      });

  const ttlSeconds = Math.max(
    120,
    spec.ttlMinutes !== null ? Math.round(spec.ttlMinutes * 60) : (options.ttlSeconds ?? 600),
  );
  const auctionSeconds = Math.min(options.auctionSeconds ?? 20, Math.floor(ttlSeconds / 2));
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const policy: Policy = {
    // The declared notional doubles as a spend cap: settlement can never exceed what was asked for.
    maxNotional: isRebalance ? 0n : inputAmount,
    validAfter: 0n,
    validUntil: BigInt(now + ttlSeconds + 60),
    maxFeeBps,
    minReputationBps: clampBps(Math.round((spec.minSolverReputationPercent ?? 0) * PERCENT_TO_BPS), 0, 10_000),
    requireRwaAttested: spec.requireRwaAttested,
    requireCompliant: spec.requireCompliant,
    sponsorGas: spec.sponsorGas,
    tokenAllowlist: spec.restrictToDeclaredAssets
      ? ([...new Set([...targets.map((t) => t.asset.address), ...exits.map((e) => e.token)])] as Address[])
      : [],
  };

  const draft = draftIntent({
    outcome,
    policy,
    auctionSeconds,
    ttlSeconds,
    now,
    metadata: {
      prompt: options.prompt,
      source: options.source ?? "intent-ai",
      summary: spec.summary || describeSpec(spec),
      schedule: spec.recurrence
        ? { everySeconds: spec.recurrence.everySeconds, ...(spec.recurrence.maxRuns ? { maxRuns: spec.recurrence.maxRuns } : {}) }
        : undefined,
      conditions: spec.conditions.length
        ? spec.conditions.map((c) => ({
            kind: c.kind,
            operator: c.operator,
            value: c.value,
            ...(c.subject ? { subject: c.subject } : {}),
            ...(c.window ? { window: c.window } : {}),
          }))
        : undefined,
      assumptions: spec.assumptions.length ? spec.assumptions : undefined,
    },
  });

  // The last word belongs to the standard, not to whatever produced the spec.
  return parseIntentDraft(draft);
}

/** How much base asset the exit legs are expected to raise, so entries can be sized. */
async function estimateRebalanceNotional(
  exits: ExitLeg[],
  baseToken: Address,
  options: CompileOptions,
): Promise<bigint> {
  if (!options.quote) return 0n;
  let total = 0n;
  for (const exit of exits) {
    try {
      total += await options.quote(exit.token, baseToken, exit.amountIn);
    } catch {
      return 0n; // Partial estimates would skew the weights; better to leave floors open.
    }
  }
  return total;
}

/** Percentages to basis points, filling in equal weights and absorbing rounding drift. */
function resolveWeightsPercent(percents: (number | null)[]): number[] {
  const count = percents.length;
  const missing = percents.filter((p) => p === null).length;

  if (missing === count) {
    const base = Math.floor(10_000 / count);
    const weights = new Array<number>(count).fill(base);
    weights[0] = base + (10_000 - base * count);
    return weights;
  }
  if (missing > 0) {
    // Some legs weighted and some not: split whatever is left over evenly among the rest.
    const declared = percents.reduce<number>((sum, p) => sum + (p ?? 0), 0);
    const share = Math.max(0, (100 - declared) / missing);
    percents = percents.map((p) => p ?? share);
  }

  const scaled = percents.map((p) => Math.floor((p as number) * PERCENT_TO_BPS));
  const total = scaled.reduce((sum, w) => sum + w, 0);
  if (total === 0) throw new CompileError("the declared weights add up to nothing");

  // Renormalize so the legs always sum to exactly 10_000, whatever the user wrote.
  const normalized = scaled.map((w) => Math.floor((w / total) * 10_000));
  const drift = 10_000 - normalized.reduce((sum, w) => sum + w, 0);
  let largest = 0;
  for (let i = 1; i < normalized.length; i++) if (normalized[i]! > normalized[largest]!) largest = i;
  normalized[largest] = normalized[largest]! + drift;

  if (normalized.some((w) => w <= 0)) {
    throw new CompileError("one of the declared weights rounds down to nothing");
  }
  return normalized;
}

function clampBps(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
