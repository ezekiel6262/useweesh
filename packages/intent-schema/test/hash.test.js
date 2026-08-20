import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeIntentId, hashOutcome, hashPolicy } from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

/**
 * vectors.json is generated *by the contracts* (contracts/scripts/gen-vectors.ts). Passing here
 * means the TypeScript encoding still agrees with Solidity byte for byte — the invariant that
 * keeps settlement from reverting with OutcomeMismatch.
 */

const revive = (value) => {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value;
};

test("hashing matches the contract-generated vectors", async (t) => {
  assert.ok(vectors.length > 0, "fixture should not be empty");

  for (const vector of vectors) {
    await t.test(vector.name, () => {
      const outcome = revive(vector.outcome);
      const policy = revive(vector.policy);

      assert.equal(hashOutcome(outcome), vector.expected.outcomeHash, "outcome hash");
      assert.equal(hashPolicy(policy), vector.expected.policyHash, "policy hash");
      assert.equal(
        computeIntentId({
          chainId: vector.chainId,
          registry: vector.registry,
          owner: vector.owner,
          outcomeHash: vector.expected.outcomeHash,
          policyHash: vector.expected.policyHash,
          salt: vector.salt,
          auctionEndsAt: BigInt(vector.auctionEndsAt),
          deadline: BigInt(vector.deadline),
        }),
        vector.expected.intentId,
        "intent id",
      );
    });
  }
});

test("the hash commits to every field it should", () => {
  const base = revive(vectors[1].outcome);
  const original = hashOutcome(base);

  const tweakedWeight = { ...base, legs: base.legs.map((l, i) => (i === 0 ? { ...l, weightBps: l.weightBps + 1 } : l)) };
  assert.notEqual(hashOutcome(tweakedWeight), original, "a changed weight must change the hash");

  const tweakedFloor = { ...base, legs: base.legs.map((l, i) => (i === 2 ? { ...l, minOut: l.minOut - 1n } : l)) };
  assert.notEqual(hashOutcome(tweakedFloor), original, "a lowered floor must change the hash");

  const reordered = { ...base, legs: [base.legs[1], base.legs[0], ...base.legs.slice(2)] };
  assert.notEqual(hashOutcome(reordered), original, "leg order is part of the commitment");

  const shortened = { ...base, legs: base.legs.slice(0, 3) };
  assert.notEqual(hashOutcome(shortened), original, "a dropped leg must change the hash");
});

test("policy hash commits to the allowlist contents and order", () => {
  const policy = revive(vectors[1].policy);
  const original = hashPolicy(policy);

  const swapped = { ...policy, tokenAllowlist: [policy.tokenAllowlist[1], policy.tokenAllowlist[0], ...policy.tokenAllowlist.slice(2)] };
  assert.notEqual(hashPolicy(swapped), original);

  const extended = { ...policy, tokenAllowlist: [...policy.tokenAllowlist, "0x0000000000000000000000000000000000000099"] };
  assert.notEqual(hashPolicy(extended), original);

  const relaxed = { ...policy, requireRwaAttested: false };
  assert.notEqual(hashPolicy(relaxed), original, "dropping the attestation requirement must be visible");
});
