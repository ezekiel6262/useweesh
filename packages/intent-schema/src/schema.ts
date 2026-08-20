import { z } from "zod";
import { IntentKind } from "./types.js";
import type { IntentDraft, Outcome, Policy } from "./types.js";

/** Structural validation for the Intent Standard, shared by the SDK, the API and solvers. */

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte address")
  .transform((v) => v as `0x${string}`);

const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex string")
  .transform((v) => v as `0x${string}`);

const bigintish = z.union([z.bigint(), z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).transform(BigInt);

export const basketLegSchema = z.object({
  token: address,
  weightBps: z.number().int().min(1).max(10_000),
  minOut: bigintish,
});

export const exitLegSchema = z.object({
  token: address,
  amountIn: bigintish.refine((v) => v > 0n, "exit legs must sell a non-zero amount"),
  minOut: bigintish,
});

export const outcomeSchema = z.object({
  kind: z.nativeEnum(IntentKind),
  inputToken: address,
  inputAmount: bigintish,
  recipient: address,
  maxSlippageBps: z.number().int().min(0).max(2_000),
  legs: z.array(basketLegSchema).min(1).max(16),
  exits: z.array(exitLegSchema).max(16).default([]),
});

export const policySchema = z.object({
  maxNotional: bigintish.default(0n),
  validAfter: bigintish.default(0n),
  validUntil: bigintish.default(0n),
  maxFeeBps: z.number().int().min(0).max(1_000),
  minReputationBps: z.number().int().min(0).max(10_000).default(0),
  requireRwaAttested: z.boolean().default(false),
  requireCompliant: z.boolean().default(false),
  sponsorGas: z.boolean().default(false),
  tokenAllowlist: z.array(address).max(32).default([]),
});

export const conditionSchema = z.object({
  kind: z.enum(["price", "drawdown", "volatility", "time", "portfolio-drift", "volume", "funding"]),
  subject: z.string().max(32).optional(),
  operator: z.enum(["lt", "lte", "gt", "gte"]),
  value: z.number(),
  window: z.string().max(16).optional(),
});

export const recurrenceSchema = z.object({
  everySeconds: z.number().int().min(60),
  maxRuns: z.number().int().min(1).optional(),
  startAt: z.number().int().optional(),
});

export const intentMetadataSchema = z
  .object({
    prompt: z.string().max(4_000).optional(),
    source: z.string().max(120).optional(),
    summary: z.string().max(1_000).optional(),
    schedule: recurrenceSchema.optional(),
    conditions: z.array(conditionSchema).max(8).optional(),
    batch: z.array(hex32).max(16).optional(),
    createdAt: z.number().int().optional(),
  })
  .passthrough();

export const intentDraftSchema = z.object({
  outcome: outcomeSchema,
  policy: policySchema,
  salt: hex32,
  auctionEndsAt: bigintish,
  deadline: bigintish,
  metadata: intentMetadataSchema.default({}),
});

export class IntentValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid intent: ${issues.join("; ")}`);
    this.name = "IntentValidationError";
  }
}

/**
 * Semantic checks that zod cannot express on its own. These mirror what PolicyEngine and
 * IntentSettlement enforce onchain, so a draft that passes here will not revert on arithmetic.
 */
export function checkOutcomeInvariants(outcome: Outcome): string[] {
  const issues: string[] = [];

  const totalWeight = outcome.legs.reduce((sum, leg) => sum + leg.weightBps, 0);
  if (totalWeight !== 10_000) {
    issues.push(`leg weights must sum to 10000, got ${totalWeight}`);
  }

  const seen = new Set<string>();
  for (const leg of outcome.legs) {
    const key = leg.token.toLowerCase();
    if (seen.has(key)) issues.push(`duplicate acquisition leg for ${leg.token}`);
    seen.add(key);
  }

  const isRebalance = outcome.kind === IntentKind.REBALANCE;
  if (isRebalance) {
    if (outcome.exits.length === 0) issues.push("a rebalance needs at least one exit leg");
  } else {
    if (outcome.exits.length > 0) issues.push(`exit legs are only valid on a REBALANCE`);
    if (outcome.inputAmount <= 0n) issues.push("inputAmount must be positive");
  }

  if (
    outcome.kind === IntentKind.SWAP ||
    outcome.kind === IntentKind.RWA_ONBOARD ||
    outcome.kind === IntentKind.PAYMENT
  ) {
    if (outcome.legs.length !== 1) {
      issues.push(`${IntentKind[outcome.kind]} takes exactly one leg, got ${outcome.legs.length}`);
    }
  }

  for (const exit of outcome.exits) {
    if (exit.token.toLowerCase() === outcome.inputToken.toLowerCase()) {
      issues.push(`exit leg ${exit.token} is already the base asset`);
    }
  }

  return issues;
}

export function checkPolicyInvariants(policy: Policy, deadline: bigint): string[] {
  const issues: string[] = [];
  if (policy.validUntil !== 0n && policy.validUntil < deadline) {
    issues.push("policy expires before the intent deadline, so settlement could never succeed");
  }
  if (policy.validAfter !== 0n && policy.validUntil !== 0n && policy.validAfter >= policy.validUntil) {
    issues.push("policy validity window is empty");
  }
  return issues;
}

/** Parse and fully validate an intent draft. Throws IntentValidationError on any problem. */
export function parseIntentDraft(input: unknown): IntentDraft {
  const parsed = intentDraftSchema.parse(input) as IntentDraft;

  const issues = [
    ...checkOutcomeInvariants(parsed.outcome),
    ...checkPolicyInvariants(parsed.policy, parsed.deadline),
  ];
  if (parsed.deadline <= parsed.auctionEndsAt) {
    issues.push("deadline must be after the auction window closes");
  }
  if (parsed.policy.maxNotional !== 0n && parsed.outcome.inputAmount > parsed.policy.maxNotional) {
    issues.push("inputAmount exceeds the policy's maxNotional");
  }
  if (issues.length > 0) throw new IntentValidationError(issues);

  return parsed;
}
