import test from "node:test";
import assert from "node:assert/strict";
import { IntentKind } from "@intentos/intent-schema";
import { AssetCatalog, catalogFromDeployment, compileSpec, formatAmount, parseAmount, parseIntent, parseWithGrammar, explainDraft } from "../dist/index.js";

const deployment = {
  network: "test",
  chainId: 195,
  contracts: {},
  tokens: {
    USDT: "0x0000000000000000000000000000000000000011",
    TSLAx: "0x0000000000000000000000000000000000000021",
    NVDAx: "0x0000000000000000000000000000000000000022",
    AAPLx: "0x0000000000000000000000000000000000000023",
    SPYx: "0x0000000000000000000000000000000000000024",
    GOOGLx: "0x0000000000000000000000000000000000000025",
  },
  routers: [],
};

const catalog = catalogFromDeployment(deployment);
const USER = "0x000000000000000000000000000000000000beef";

const parse = (prompt) => parseWithGrammar(prompt, catalog).spec;
const compile = (spec) => compileSpec(spec, { catalog, recipient: USER, now: 1_800_000_000 });

test("catalog resolves the ways people actually write tickers", () => {
  assert.equal(catalog.resolve("TSLAx").symbol, "TSLAx");
  assert.equal(catalog.resolve("TSLA").symbol, "TSLAx");
  assert.equal(catalog.resolve("tsla").symbol, "TSLAx");
  assert.equal(catalog.resolve("$TSLA").symbol, "TSLAx");
  assert.equal(catalog.resolve("Tesla").symbol, "TSLAx");
  assert.equal(catalog.resolve("s&p").symbol, "SPYx");
  assert.throws(() => catalog.resolve("DOGE"), /no asset called/);
});

test("amounts parse in the shapes people type them", () => {
  assert.equal(parseAmount("10,000", 6), 10_000_000_000n);
  assert.equal(parseAmount("10k", 6), 10_000_000_000n);
  assert.equal(parseAmount("2.5", 18), 2_500_000_000_000_000_000n);
  assert.equal(parseAmount("$1,250.75", 6), 1_250_750_000n);
  assert.equal(formatAmount(10_000_000_000n, 6), "10,000");
  assert.equal(formatAmount(2_500_000_000_000_000_000n, 18), "2.5");
});

test("the headline basket request parses into an equal-weight basket", async () => {
  const spec = parse(
    "Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight and 0.5% max slippage",
  );

  assert.equal(spec.action, "buy_basket");
  assert.equal(spec.inputSymbol, "USDT");
  assert.equal(spec.inputAmount, "10000");
  assert.deepEqual(spec.targets.map((t) => t.symbol), ["TSLAx", "NVDAx", "AAPLx", "SPYx"]);
  assert.ok(spec.targets.every((t) => t.weightPercent === null));
  assert.equal(spec.maxSlippagePercent, 0.5);

  const draft = await compile(spec);
  assert.equal(draft.outcome.kind, IntentKind.BASKET);
  assert.equal(draft.outcome.inputAmount, 10_000_000_000n);
  assert.equal(draft.outcome.maxSlippageBps, 50);
  assert.deepEqual(draft.outcome.legs.map((l) => l.weightBps), [2_500, 2_500, 2_500, 2_500]);
  // The declared notional doubles as a spend cap.
  assert.equal(draft.policy.maxNotional, 10_000_000_000n);
});

test("explicit weights survive into basis points", async () => {
  const spec = parse("put 40% into NVDA, 35% AAPL and 25% SPY using 20,000 USDT");
  assert.deepEqual(
    spec.targets.map((t) => [t.symbol, t.weightPercent]),
    [["NVDAx", 40], ["AAPLx", 35], ["SPYx", 25]],
  );

  const draft = await compile(spec);
  assert.deepEqual(draft.outcome.legs.map((l) => l.weightBps), [4_000, 3_500, 2_500]);
  assert.equal(draft.outcome.legs.reduce((sum, l) => sum + l.weightBps, 0), 10_000);
});

test("weights that do not add to 100 are renormalized rather than rejected", async () => {
  const spec = parse("buy 50% TSLA and 30% NVDA with 1000 USDT");
  const draft = await compile(spec);
  assert.equal(draft.outcome.legs.reduce((sum, l) => sum + l.weightBps, 0), 10_000);
  assert.ok(draft.outcome.legs[0].weightBps > draft.outcome.legs[1].weightBps);
});

test("a single target is a swap, not a basket", async () => {
  const spec = parse("swap 5000 USDT into TSLAx");
  assert.equal(spec.action, "swap");
  const draft = await compile(spec);
  assert.equal(draft.outcome.kind, IntentKind.SWAP);
  assert.equal(draft.outcome.legs.length, 1);
  assert.equal(draft.outcome.legs[0].weightBps, 10_000);
});

test("a sell-and-buy request becomes a rebalance funded by its exits", async () => {
  const spec = parse("rebalance: sell 10 TSLA and 5 NVDA, then buy AAPL and SPY equally");
  assert.equal(spec.action, "rebalance");
  assert.deepEqual(spec.exits.map((e) => [e.symbol, e.amount]), [["TSLAx", "10"], ["NVDAx", "5"]]);
  assert.deepEqual(spec.targets.map((t) => t.symbol), ["AAPLx", "SPYx"]);

  const draft = await compile(spec);
  assert.equal(draft.outcome.kind, IntentKind.REBALANCE);
  assert.equal(draft.outcome.inputAmount, 0n);
  assert.equal(draft.outcome.exits.length, 2);
  assert.equal(draft.outcome.exits[0].amountIn, 10_000_000_000_000_000_000n);
  // A rebalance is funded by its own exits, so a fixed notional cap would be meaningless.
  assert.equal(draft.policy.maxNotional, 0n);
});

test("guardrails in the sentence become guardrails in the policy", async () => {
  const spec = parse(
    "Deploy 50,000 USDT into TSLA and NVDA equally, only attested assets, nothing else, fees under 0.2%, reputation above 60%",
  );
  assert.equal(spec.requireRwaAttested, true);
  assert.equal(spec.restrictToDeclaredAssets, true);
  assert.equal(spec.maxFeePercent, 0.2);
  assert.equal(spec.minSolverReputationPercent, 60);

  const draft = await compile(spec);
  assert.equal(draft.policy.requireRwaAttested, true);
  assert.equal(draft.policy.maxFeeBps, 20);
  assert.equal(draft.policy.minReputationBps, 6_000);
  assert.deepEqual(draft.policy.tokenAllowlist, [
    deployment.tokens.TSLAx,
    deployment.tokens.NVDAx,
  ]);
});

test("recurrence and conditions are carried as intent metadata", async () => {
  const spec = parse("every week put 1000 USDT into SPY, only if SPY is below 700");
  assert.deepEqual(spec.recurrence, { everySeconds: 604_800, maxRuns: null });
  assert.deepEqual(spec.conditions, [
    { kind: "price", subject: "SPYx", operator: "lt", value: 700, window: null },
  ]);

  const draft = await compile(spec);
  assert.equal(draft.metadata.schedule.everySeconds, 604_800);
  assert.equal(draft.metadata.conditions[0].subject, "SPYx");
});

test("a tokenization request is recognised as RWA onboarding", async () => {
  const spec = parse("bring 25,000 USDT onchain into SPY xStock");
  assert.equal(spec.action, "onboard_rwa");
  const draft = await compile(spec);
  assert.equal(draft.outcome.kind, IntentKind.RWA_ONBOARD);
});

test("a request with no amount asks rather than guessing", () => {
  const spec = parse("buy some TSLA and NVDA");
  assert.equal(spec.inputAmount, null);
  assert.match(spec.clarifications.join(" "), /how much/i);
});

test("quotes turn the slippage tolerance into binding per-leg floors", async () => {
  const spec = parse("Allocate 10,000 USDT across TSLA and NVDA equally with 1% max slippage");
  // A quoting function that returns one whole unit per 100 USDT of notional.
  const quote = async (_tokenIn, _tokenOut, amountIn) => (amountIn * 10n ** 18n) / (100n * 10n ** 6n);

  const draft = await compileSpec(spec, { catalog, recipient: USER, quote, now: 1_800_000_000 });
  const legNotional = 5_000_000_000n;
  const quoted = (legNotional * 10n ** 18n) / (100n * 10n ** 6n);

  assert.equal(draft.outcome.legs[0].minOut, (quoted * 9_900n) / 10_000n);
  assert.ok(draft.outcome.legs[0].minOut > 0n);
});

test("an unquotable leg is left open rather than blocking the intent", async () => {
  const spec = parse("Allocate 1,000 USDT across TSLA and NVDA equally");
  const quote = async (_in, out) => {
    if (out === deployment.tokens.NVDAx) throw new Error("no pool");
    return 10n ** 18n;
  };
  const draft = await compileSpec(spec, { catalog, recipient: USER, quote, now: 1_800_000_000 });
  assert.ok(draft.outcome.legs[0].minOut > 0n);
  assert.equal(draft.outcome.legs[1].minOut, 0n);
});

test("parseIntent falls back to the grammar when no model is configured", async () => {
  const parsed = await parseIntent("Allocate 10,000 USDT across TSLA and NVDA equally", {
    catalog,
    recipient: USER,
    prefer: "grammar",
    now: 1_800_000_000,
  });
  assert.equal(parsed.parser, "grammar");
  assert.equal(parsed.draft.metadata.source, "grammar");
  assert.equal(parsed.draft.outcome.legs.length, 2);
});

test("parseIntent uses Claude when a client is supplied, and validates what it returns", async () => {
  // A stand-in for the Anthropic client: same call shape, canned structured output.
  const client = {
    messages: {
      parse: async (request) => {
        assert.equal(request.model, "claude-opus-5");
        assert.ok(request.system.includes("TSLAx"), "the catalog is given to the model");
        assert.ok(request.output_config.format, "structured output is requested");
        return {
          stop_reason: "end_turn",
          parsed_output: {
            action: "buy_basket",
            inputSymbol: "USDT",
            inputAmount: "10000",
            targets: [
              { symbol: "TSLAx", weightPercent: 60 },
              { symbol: "NVDAx", weightPercent: 40 },
            ],
            exits: [],
            maxSlippagePercent: 0.75,
            maxFeePercent: 0.25,
            requireRwaAttested: true,
            restrictToDeclaredAssets: false,
            minSolverReputationPercent: null,
            ttlMinutes: 15,
            recurrence: null,
            conditions: [],
            summary: "Put 10,000 USDT into TSLAx and NVDAx, weighted 60/40.",
            assumptions: ["Assumed the position is funded in USDT."],
            clarifications: [],
          },
        };
      },
    },
  };

  const parsed = await parseIntent("60/40 TSLA and NVDA with ten thousand dollars", {
    catalog,
    recipient: USER,
    client,
    now: 1_800_000_000,
  });

  assert.equal(parsed.parser, "claude");
  assert.equal(parsed.draft.metadata.source, "claude:claude-opus-5");
  assert.deepEqual(parsed.draft.outcome.legs.map((l) => l.weightBps), [6_000, 4_000]);
  assert.equal(parsed.draft.policy.maxFeeBps, 25);
  assert.equal(parsed.draft.policy.requireRwaAttested, true);
  assert.deepEqual(parsed.assumptions, ["Assumed the position is funded in USDT."]);
});

test("a model that names an unknown asset fails resolution instead of trading", async () => {
  const client = {
    messages: {
      parse: async () => ({
        stop_reason: "end_turn",
        parsed_output: {
          action: "swap",
          inputSymbol: "USDT",
          inputAmount: "1000",
          targets: [{ symbol: "MOONx", weightPercent: 100 }],
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
        },
      }),
    },
  };

  await assert.rejects(
    parseIntent("buy MOONx", { catalog, recipient: USER, client, now: 1_800_000_000 }),
    /no asset called "MOONx"/,
  );
});

test("an intent explains itself in the words a user would check", async () => {
  const spec = parse("Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY equally, only attested assets");
  const draft = await compile(spec);
  const text = explainDraft(draft, { catalog });

  assert.match(text, /10,000 USDT/);
  assert.match(text, /25% TSLAx/);
  assert.match(text, /RWA attestation/);
});

test("an empty catalog rejects everything rather than defaulting", () => {
  const empty = new AssetCatalog();
  assert.throws(() => empty.resolve("TSLA"), /no asset called/);
});
