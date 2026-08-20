import test from "node:test";
import assert from "node:assert/strict";
import { AGGRESSIVE, CONSERVATIVE, Quoter, planIntent } from "../dist/index.js";
import { AAPL, NVDA, TSLA, USDT, draft, makePublicClient, outcome } from "./stubs.js";

const VENUE_A = "0x00000000000000000000000000000000000000a1";
const VENUE_B = "0x00000000000000000000000000000000000000b1";

/** A is cheaper on TSLA, B is cheaper on NVDA — so venue choice per leg is worth something. */
const venues = {
  [VENUE_A]: { feeBps: 30, prices: { [USDT]: 1, [TSLA]: 325, [NVDA]: 185, [AAPL]: 230 } },
  [VENUE_B]: { feeBps: 20, prices: { [USDT]: 1, [TSLA]: 335, [NVDA]: 176, [AAPL]: 231 } },
};

const quoter = () =>
  new Quoter({
    publicClient: makePublicClient(venues),
    venues: [
      { name: "A", address: VENUE_A },
      { name: "B", address: VENUE_B },
    ],
    intermediate: USDT,
    cacheMs: 0,
  });

const SOLVER = "0x00000000000000000000000000000000000005a1";
const ID = "0x" + "aa".repeat(32);

test("the planner picks the best venue for each leg independently", async () => {
  const { plan, declined } = await planIntent(ID, draft(), { quoter: quoter(), strategy: AGGRESSIVE, solver: SOLVER });

  assert.equal(declined, undefined);
  assert.equal(plan.entryRoutes.length, 2);
  // TSLA is cheaper on A (lower price per share), NVDA is cheaper on B.
  assert.equal(plan.entryRoutes[0].router, VENUE_A);
  assert.equal(plan.entryRoutes[1].router, VENUE_B);
  assert.deepEqual(plan.scoring.notes, ["leg 0 via A", "leg 1 via B"]);
});

test("legs are sized from the committed weights, net of the fee", async () => {
  const skewed = draft({
    outcome: outcome({
      legs: [
        { token: TSLA, weightBps: 7_500, minOut: 0n },
        { token: NVDA, weightBps: 2_500, minOut: 0n },
      ],
    }),
  });

  const { plan } = await planIntent(ID, skewed, { quoter: quoter(), strategy: AGGRESSIVE, solver: SOLVER });

  // Three times as much TSLA notional as NVDA, in value terms.
  const tslaValue = Number(plan.quotedOut[0]) * 325;
  const nvdaValue = Number(plan.quotedOut[1]) * 176;
  assert.ok(Math.abs(tslaValue / nvdaValue - 3) < 0.02, `expected a 3:1 split, got ${tslaValue / nvdaValue}`);
});

test("a solver only guarantees what it is willing to be held to", async () => {
  const aggressive = await planIntent(ID, draft(), { quoter: quoter(), strategy: AGGRESSIVE, solver: SOLVER });
  const conservative = await planIntent(ID, draft(), { quoter: quoter(), strategy: CONSERVATIVE, solver: SOLVER });

  for (const [i, guaranteed] of aggressive.plan.guaranteedOut.entries()) {
    assert.ok(guaranteed < aggressive.plan.quotedOut[i], "a guarantee sits below the quote");
    assert.ok(
      guaranteed > conservative.plan.guaranteedOut[i],
      "the aggressive solver guarantees more than the conservative one",
    );
  }
  assert.ok(aggressive.plan.feeBps < conservative.plan.feeBps);
  assert.ok(
    aggressive.plan.scoring.successProbability > conservative.plan.scoring.successProbability,
    "and prices that as a higher chance of clearing its own tighter guarantees",
  );
});

test("a floor no venue can reach makes the solver decline rather than bid", async () => {
  const greedy = draft({
    outcome: outcome({
      legs: [
        { token: TSLA, weightBps: 5_000, minOut: 10n ** 20n }, // 100 TSLA for 5,000 USDT
        { token: NVDA, weightBps: 5_000, minOut: 0n },
      ],
    }),
  });

  const { plan, declined } = await planIntent(ID, greedy, { quoter: quoter(), strategy: AGGRESSIVE, solver: SOLVER });
  assert.equal(plan, undefined);
  assert.match(declined, /cannot be guaranteed above the user's floor/);
});

test("an asset no venue lists is declined, not routed around", async () => {
  const unlisted = "0x0000000000000000000000000000000000000099";
  const exotic = draft({
    outcome: outcome({
      legs: [
        { token: TSLA, weightBps: 5_000, minOut: 0n },
        { token: unlisted, weightBps: 5_000, minOut: 0n },
      ],
    }),
  });

  const { declined } = await planIntent(ID, exotic, { quoter: quoter(), strategy: AGGRESSIVE, solver: SOLVER });
  assert.match(declined, /no venue prices leg 1/);
});

test("a rebalance's entry budget comes from what its exits actually raise", async () => {
  const rebalance = draft({
    outcome: outcome({
      kind: 2,
      inputAmount: 0n,
      legs: [{ token: AAPL, weightBps: 10_000, minOut: 0n }],
      exits: [{ token: TSLA, amountIn: 10n ** 19n, minOut: 0n }], // 10 TSLA
    }),
  });

  const { plan, declined } = await planIntent(ID, rebalance, {
    quoter: quoter(),
    strategy: AGGRESSIVE,
    solver: SOLVER,
  });

  assert.equal(declined, undefined);
  assert.equal(plan.exitRoutes.length, 1);
  // 10 TSLA sold near 335 buys roughly 14.5 AAPL near 230, minus fees on both sides.
  const acquired = Number(plan.quotedOut[0]) / 1e18;
  assert.ok(acquired > 14 && acquired < 15, `expected ~14.5 AAPL, got ${acquired}`);
});

test("the solver's fee is capped by the intent, not by its own strategy", async () => {
  const strict = draft({ policy: { maxFeeBps: 3 } });
  const { plan } = await planIntent(ID, strict, { quoter: quoter(), strategy: CONSERVATIVE, solver: SOLVER });
  assert.equal(plan.feeBps, 3);
});

test("scoring prices risk, fee and gas against delivered value", async () => {
  const { plan } = await planIntent(ID, draft(), { quoter: quoter(), strategy: AGGRESSIVE, solver: SOLVER });
  const { scoring } = plan;

  assert.ok(scoring.quotedValue > 0);
  assert.ok(scoring.score < scoring.quotedValue, "the score is net of what the plan costs");
  assert.ok(scoring.successProbability > 0 && scoring.successProbability <= 1);
  // These two venues disagree on price, so buying at the cheap one and marking to the dear one
  // shows a gain — which is exactly the spread a solver exists to capture. Either sign is
  // meaningful; what matters is that it stays in a plausible range.
  assert.ok(Math.abs(scoring.priceImpactBps) < 1_000, `impact was ${scoring.priceImpactBps} bps`);
});

test("with a single venue, the round trip is a cost", async () => {
  const soleVenue = new Quoter({
    publicClient: makePublicClient({ [VENUE_A]: venues[VENUE_A] }),
    venues: [{ name: "A", address: VENUE_A }],
    intermediate: USDT,
    cacheMs: 0,
  });

  const { plan } = await planIntent(ID, draft(), { quoter: soleVenue, strategy: AGGRESSIVE, solver: SOLVER });
  // Two 30 bps swaps to buy and mark back, so a little under 60 bps.
  assert.ok(
    plan.scoring.priceImpactBps > 40 && plan.scoring.priceImpactBps < 80,
    `expected roughly 60 bps of round-trip cost, got ${plan.scoring.priceImpactBps}`,
  );
});
