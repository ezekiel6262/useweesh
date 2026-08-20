import test from "node:test";
import assert from "node:assert/strict";
import {
  IntentKind,
  IntentValidationError,
  applySlippage,
  buildBasketOutcome,
  buildRebalanceOutcome,
  checkOutcomeInvariants,
  draftIntent,
  equalWeights,
  normalizeWeights,
  parseIntentDraft,
} from "../dist/index.js";

const USDT = "0x0000000000000000000000000000000000000011";
const TSLA = "0x0000000000000000000000000000000000000021";
const NVDA = "0x0000000000000000000000000000000000000022";
const AAPL = "0x0000000000000000000000000000000000000023";
const USER = "0x000000000000000000000000000000000000beef";

test("equalWeights always sums to 10000, including for indivisible counts", () => {
  for (let n = 1; n <= 16; n++) {
    const weights = equalWeights(n);
    assert.equal(weights.length, n);
    assert.equal(weights.reduce((a, b) => a + b, 0), 10_000, `n=${n}`);
    assert.ok(weights.every((w) => w > 0), `n=${n} has an empty leg`);
  }
});

test("normalizeWeights turns arbitrary targets into exact bps", () => {
  assert.deepEqual(normalizeWeights([50, 30, 20]), [5_000, 3_000, 2_000]);
  assert.deepEqual(normalizeWeights([1, 1, 1]).reduce((a, b) => a + b, 0), 10_000);
  // Dollar targets, not percentages.
  assert.equal(normalizeWeights([4000, 3000, 2000, 1000]).reduce((a, b) => a + b, 0), 10_000);
});

test("applySlippage produces a floor below the quote", () => {
  assert.equal(applySlippage(1_000_000n, 100), 990_000n);
  assert.equal(applySlippage(1_000_000n, 0), 1_000_000n);
});

test("an equal-weight basket is well formed", () => {
  const outcome = buildBasketOutcome({
    inputToken: USDT,
    inputAmount: 10_000_000_000n,
    recipient: USER,
    targets: [{ token: TSLA }, { token: NVDA }, { token: AAPL }],
    maxSlippageBps: 100,
  });
  assert.equal(outcome.kind, IntentKind.BASKET);
  assert.deepEqual(checkOutcomeInvariants(outcome), []);
});

test("a single target builds a SWAP, and quotes become binding floors", () => {
  const outcome = buildBasketOutcome({
    inputToken: USDT,
    inputAmount: 1_000_000n,
    recipient: USER,
    targets: [{ token: TSLA, quotedOut: 3_000_000_000_000_000_000n }],
    maxSlippageBps: 50,
  });
  assert.equal(outcome.kind, IntentKind.SWAP);
  assert.equal(outcome.legs[0].minOut, 2_985_000_000_000_000_000n);
});

test("invariant checks catch the mistakes that would revert onchain", () => {
  const good = buildBasketOutcome({
    inputToken: USDT,
    inputAmount: 1_000_000n,
    recipient: USER,
    targets: [{ token: TSLA }, { token: NVDA }],
    maxSlippageBps: 50,
  });

  const skewed = { ...good, legs: [{ ...good.legs[0], weightBps: 6_000 }, good.legs[1]] };
  assert.match(checkOutcomeInvariants(skewed).join(), /sum to 10000/);

  const duplicated = { ...good, legs: [good.legs[0], { ...good.legs[1], token: TSLA }] };
  assert.match(checkOutcomeInvariants(duplicated).join(), /duplicate/);

  const swapWithTwoLegs = { ...good, kind: IntentKind.SWAP };
  assert.match(checkOutcomeInvariants(swapWithTwoLegs).join(), /exactly one leg/);

  const rebalanceWithoutExits = { ...good, kind: IntentKind.REBALANCE };
  assert.match(checkOutcomeInvariants(rebalanceWithoutExits).join(), /at least one exit/);
});

test("a rebalance funds itself from its exit legs", () => {
  const outcome = buildRebalanceOutcome({
    baseToken: USDT,
    recipient: USER,
    exits: [{ token: TSLA, amountIn: 5_000_000_000_000_000_000n, minOut: 1_600_000_000n }],
    targets: [{ token: NVDA, weightBps: 6_000 }, { token: AAPL, weightBps: 4_000 }],
    maxSlippageBps: 75,
  });
  assert.equal(outcome.inputAmount, 0n);
  assert.deepEqual(checkOutcomeInvariants(outcome), []);
});

test("parseIntentDraft rejects a draft whose policy expires before its deadline", () => {
  const now = 1_800_000_000;
  const draft = draftIntent({
    now,
    outcome: buildBasketOutcome({
      inputToken: USDT,
      inputAmount: 1_000_000n,
      recipient: USER,
      targets: [{ token: TSLA }],
      maxSlippageBps: 50,
    }),
    policy: { maxNotional: 0n, validAfter: 0n, validUntil: BigInt(now + 30), maxFeeBps: 30, minReputationBps: 0, requireRwaAttested: false, requireCompliant: false, sponsorGas: false, tokenAllowlist: [] },
  });

  assert.throws(() => parseIntentDraft(draft), IntentValidationError);
});

test("parseIntentDraft accepts a fully specified xStocks basket", () => {
  const draft = draftIntent({
    outcome: buildBasketOutcome({
      inputToken: USDT,
      inputAmount: 10_000_000_000n,
      recipient: USER,
      targets: [{ token: TSLA }, { token: NVDA }, { token: AAPL }],
      maxSlippageBps: 100,
    }),
    metadata: { prompt: "put 10k USDT into TSLA, NVDA and AAPL equally", source: "test" },
  });

  const parsed = parseIntentDraft(draft);
  assert.equal(parsed.outcome.legs.length, 3);
  assert.equal(parsed.metadata.prompt, "put 10k USDT into TSLA, NVDA and AAPL equally");
});
