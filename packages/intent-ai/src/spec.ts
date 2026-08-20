import { z } from "zod";

/**
 * The intermediate representation between natural language and the Intent Standard.
 *
 * An IntentSpec talks in tickers, decimal amounts and percentages — never addresses, wei or
 * basis points. That boundary is deliberate: the language model proposes a spec, and a
 * deterministic compiler (compile.ts) turns it into an Outcome using the onchain asset catalog.
 * A hallucinated address therefore cannot reach a transaction, because the model is never asked
 * for one.
 */

export const intentSpecSchema = z.object({
  action: z
    .enum(["swap", "buy_basket", "rebalance", "onboard_rwa"])
    .describe("What the user wants to happen"),
  inputSymbol: z.string().describe("Ticker of the asset being spent, e.g. USDT"),
  inputAmount: z
    .string()
    .nullable()
    .describe("Decimal amount of inputSymbol to spend, as a string. null for a pure rebalance."),
  targets: z
    .array(
      z.object({
        symbol: z.string().describe("Ticker to acquire, e.g. TSLAx"),
        weightPercent: z
          .number()
          .nullable()
          .describe("Share of the notional for this asset. null means weight the basket equally."),
      }),
    )
    .describe("Assets to end up holding"),
  exits: z
    .array(
      z.object({
        symbol: z.string(),
        amount: z.string().describe("Decimal quantity of this asset to sell"),
      }),
    )
    .describe("Positions to sell first. Only used by a rebalance."),
  maxSlippagePercent: z.number().describe("Slippage tolerance per leg, in percent"),
  maxFeePercent: z.number().nullable().describe("Ceiling on the solver's success fee, in percent"),
  requireRwaAttested: z
    .boolean()
    .describe("Require every acquired asset to carry a live RWA attestation onchain"),
  restrictToDeclaredAssets: z
    .boolean()
    .describe("Pin the intent to exactly the assets named, via an onchain token allowlist"),
  minSolverReputationPercent: z
    .number()
    .nullable()
    .describe("Floor on the winning solver's reputation score, in percent"),
  ttlMinutes: z.number().nullable().describe("How long the intent may remain servable"),
  recurrence: z
    .object({
      everySeconds: z.number(),
      maxRuns: z.number().nullable(),
    })
    .nullable()
    .describe("Set when the user asked for something recurring"),
  conditions: z
    .array(
      z.object({
        kind: z.enum(["price", "drawdown", "volatility", "time", "portfolio-drift"]),
        subject: z.string().nullable(),
        operator: z.enum(["lt", "lte", "gt", "gte"]),
        value: z.number(),
        window: z.string().nullable(),
      }),
    )
    .describe("Preconditions that must hold before the intent is worth serving"),
  summary: z.string().describe("One sentence restating the outcome in plain language"),
  assumptions: z
    .array(z.string())
    .describe("Anything filled in that the user did not actually say"),
  clarifications: z
    .array(z.string())
    .describe("Questions that genuinely need a human answer before this should be submitted"),
});

export type IntentSpec = z.infer<typeof intentSpecSchema>;

/** Every optional field filled in, so callers never deal with partial specs. */
export function emptySpec(overrides: Partial<IntentSpec> = {}): IntentSpec {
  return {
    action: "buy_basket",
    inputSymbol: "USDT",
    inputAmount: null,
    targets: [],
    exits: [],
    maxSlippagePercent: 1,
    maxFeePercent: null,
    requireRwaAttested: false,
    restrictToDeclaredAssets: false,
    minSolverReputationPercent: null,
    ttlMinutes: null,
    recurrence: null,
    conditions: [],
    summary: "",
    assumptions: [],
    clarifications: [],
    ...overrides,
  };
}
