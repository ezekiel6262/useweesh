import test from "node:test";
import assert from "node:assert/strict";
import { Quoter, dominates, findDominatingBid, rankBids, selectWinnerFrom } from "../dist/index.js";
import { NVDA, TSLA, USDT, draft, makePublicClient } from "./stubs.js";

const VENUE = "0x00000000000000000000000000000000000000a1";
const venues = { [VENUE]: { feeBps: 30, prices: { [USDT]: 1, [TSLA]: 325, [NVDA]: 185 } } };

const quoter = () =>
  new Quoter({
    publicClient: makePublicClient(venues),
    venues: [{ name: "A", address: VENUE }],
    intermediate: USDT,
    cacheMs: 0,
  });

const bid = (overrides) => ({
  bidId: 0,
  solver: "0x0000000000000000000000000000000000000001",
  feeBps: 10,
  etaSeconds: 20,
  planHash: "0x" + "00".repeat(32),
  guaranteedOut: [10n ** 19n, 10n ** 19n],
  withdrawn: false,
  ...overrides,
});

const rank = (bids, overrides = {}) =>
  rankBids(bids, {
    quoter: quoter(),
    draft: draft(overrides.draft),
    notional: 10_000_000_000n,
    reputationOf: () => overrides.reputation ?? 5_000,
    ...overrides.options,
  });

test("dominance means no worse anywhere and better somewhere", () => {
  const base = bid({ feeBps: 10, guaranteedOut: [100n, 100n] });

  assert.ok(dominates(bid({ feeBps: 10, guaranteedOut: [101n, 100n] }), base), "more on one leg");
  assert.ok(dominates(bid({ feeBps: 9, guaranteedOut: [100n, 100n] }), base), "cheaper for the same");
  assert.ok(!dominates(bid({ feeBps: 10, guaranteedOut: [100n, 100n] }), base), "identical is not dominant");
  assert.ok(!dominates(bid({ feeBps: 9, guaranteedOut: [99n, 100n] }), base), "a trade-off is not dominance");
  assert.ok(!dominates(bid({ feeBps: 11, guaranteedOut: [101n, 101n] }), base), "better output but dearer");
});

test("ranking prefers the bid that leaves the user with more, net of fee", async () => {
  const cheapButThin = bid({ bidId: 0, solver: "0x" + "01".repeat(20), feeBps: 5, guaranteedOut: [10n ** 19n, 10n ** 19n] });
  const dearerButFatter = bid({
    bidId: 1,
    solver: "0x" + "02".repeat(20),
    feeBps: 25,
    guaranteedOut: [12n ** 19n, 12n ** 19n],
  });

  const ranked = await rank([cheapButThin, dearerButFatter]);
  assert.equal(ranked[0].bid.bidId, 1, "more delivered value wins even at a higher fee");
  assert.ok(ranked[0].guaranteedValue > ranked[1].guaranteedValue);
});

test("reputation breaks a tie between otherwise equal bids", async () => {
  const a = bid({ bidId: 0, solver: "0x" + "01".repeat(20) });
  const b = bid({ bidId: 1, solver: "0x" + "02".repeat(20) });

  const ranked = await rankBids([a, b], {
    quoter: quoter(),
    draft: draft(),
    notional: 10_000_000_000n,
    reputationOf: (solver) => (solver === b.solver ? 9_000 : 2_000),
  });
  assert.equal(ranked[0].bid.bidId, 1);
});

test("bids outside the intent's own guardrails are ineligible, not merely ranked low", async () => {
  const overFee = bid({ bidId: 0, solver: "0x" + "01".repeat(20), feeBps: 90 });
  const underRep = bid({ bidId: 1, solver: "0x" + "02".repeat(20) });
  const withdrawn = bid({ bidId: 2, solver: "0x" + "03".repeat(20), withdrawn: true });

  const ranked = await rankBids([overFee, underRep, withdrawn], {
    quoter: quoter(),
    draft: draft({ policy: { maxFeeBps: 30, minReputationBps: 6_000 } }),
    notional: 10_000_000_000n,
    reputationOf: () => 5_000,
  });

  assert.match(ranked.find((r) => r.bid.bidId === 0).ineligible, /fee above/);
  assert.match(ranked.find((r) => r.bid.bidId === 1).ineligible, /reputation below/);
  assert.match(ranked.find((r) => r.bid.bidId === 2).ineligible, /withdrawn/);
  assert.equal(selectWinnerFrom(ranked, [overFee, underRep, withdrawn]).winner, undefined);
});

test("a coordinator will not select a bid it could be slashed for", async () => {
  const chosen = bid({ bidId: 0, solver: "0x" + "01".repeat(20), feeBps: 20, guaranteedOut: [100n, 100n] });
  const better = bid({ bidId: 1, solver: "0x" + "02".repeat(20), feeBps: 10, guaranteedOut: [120n, 120n] });

  assert.equal(findDominatingBid([chosen, better], chosen)?.bidId, 1);

  // Even if a stale valuation ranked the dominated bid first, selection skips it.
  const ranked = [
    { bid: chosen, guaranteedValue: 999n, feeCost: 0n, reputationBps: 5_000, score: 999 },
    { bid: better, guaranteedValue: 1n, feeCost: 0n, reputationBps: 5_000, score: 1 },
  ];
  const result = selectWinnerFrom(ranked, [chosen, better]);
  assert.equal(result.winner.bid.bidId, 1);
});

test("an empty auction has no winner and says so", async () => {
  assert.equal(selectWinnerFrom([], []).reason, "no eligible bids");
});
