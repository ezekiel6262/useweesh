import test from "node:test";
import assert from "node:assert/strict";
import { conditionsHold, hashOutcome, hashPolicy, verifyDraftAgainstRecord } from "../dist/index.js";

/**
 * A solver receives drafts from a coordinator it did not write. These checks are what stand
 * between "someone sent me an intent" and "I am willing to guarantee an outcome for it".
 */

const draft = (overrides = {}) => ({
  outcome: {
    kind: 1,
    inputToken: "0x0000000000000000000000000000000000000011",
    inputAmount: 10_000_000_000n,
    recipient: "0x000000000000000000000000000000000000beef",
    maxSlippageBps: 100,
    legs: [
      { token: "0x0000000000000000000000000000000000000021", weightBps: 5_000, minOut: 1n },
      { token: "0x0000000000000000000000000000000000000022", weightBps: 5_000, minOut: 2n },
    ],
    exits: [],
    ...overrides.outcome,
  },
  policy: {
    maxNotional: 0n,
    validAfter: 0n,
    validUntil: 0n,
    maxFeeBps: 30,
    minReputationBps: 0,
    requireRwaAttested: false,
    tokenAllowlist: [],
    ...overrides.policy,
  },
  salt: "0x" + "01".repeat(32),
  auctionEndsAt: 1_800_000_020n,
  deadline: 1_800_000_600n,
  metadata: {},
});

const recordFor = (d, overrides = {}) => ({
  intentId: "0x" + "ab".repeat(32),
  owner: "0x000000000000000000000000000000000000beef",
  kind: d.outcome.kind,
  status: 1,
  legCount: d.outcome.legs.length,
  createdAt: 0n,
  auctionEndsAt: d.auctionEndsAt,
  deadline: d.deadline,
  outcomeHash: hashOutcome(d.outcome),
  policyHash: hashPolicy(d.policy),
  selectedSolver: "0x0000000000000000000000000000000000000000",
  selectedBid: 0,
  ownerSelected: false,
  ...overrides,
});

test("a matching draft verifies", () => {
  const d = draft();
  const result = verifyDraftAgainstRecord(d, recordFor(d), "0x" + "ab".repeat(32));
  assert.deepEqual(result, { ok: true, problems: [] });
});

test("a draft with a lowered floor no longer matches its commitment", () => {
  const d = draft();
  const record = recordFor(d);

  const tampered = {
    ...d,
    outcome: { ...d.outcome, legs: [{ ...d.outcome.legs[0], minOut: 0n }, d.outcome.legs[1]] },
  };
  const result = verifyDraftAgainstRecord(tampered, record);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /outcome does not hash/);
});

test("a relaxed policy is caught even when the outcome is untouched", () => {
  const d = draft();
  const record = recordFor(d);
  const relaxed = { ...d, policy: { ...d.policy, maxFeeBps: 900 } };

  const result = verifyDraftAgainstRecord(relaxed, record);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /policy does not hash/);
});

test("shifted timing is caught, since it changes what the solver is agreeing to", () => {
  const d = draft();
  const record = recordFor(d);
  const stretched = { ...d, deadline: d.deadline + 3_600n };

  const result = verifyDraftAgainstRecord(stretched, record);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /deadline differs/);
});

test("a record for a different intent is rejected", () => {
  const d = draft();
  const result = verifyDraftAgainstRecord(d, recordFor(d), "0x" + "cd".repeat(32));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /different intent/);
});

test("conditions hold only when every observation supports them", () => {
  const d = {
    ...draft(),
    metadata: {
      conditions: [
        { kind: "price", subject: "TSLAx", operator: "lt", value: 300 },
        { kind: "volatility", subject: "volatility", operator: "lte", value: 40 },
      ],
    },
  };

  assert.deepEqual(conditionsHold(d, { TSLAx: 280, volatility: 35 }), { hold: true, failed: [] });

  const tooHigh = conditionsHold(d, { TSLAx: 320, volatility: 35 });
  assert.equal(tooHigh.hold, false);
  assert.match(tooHigh.failed.join(), /TSLAx is 320/);

  // A missing observation fails closed: an unserved intent beats one served blind.
  const missing = conditionsHold(d, { TSLAx: 280 });
  assert.equal(missing.hold, false);
  assert.match(missing.failed.join(), /no observation for volatility/);
});

test("an intent with no conditions always holds", () => {
  assert.deepEqual(conditionsHold(draft(), {}), { hold: true, failed: [] });
});
