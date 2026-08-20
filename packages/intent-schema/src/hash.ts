import { type Address, type Hex, encodeAbiParameters, encodePacked, keccak256, toHex } from "viem";
import type { Outcome, Policy } from "./types.js";

/**
 * Canonical hashing for the Intent Standard.
 *
 * Every function here is a byte-for-byte mirror of the matching one in IntentLib.sol. A
 * mismatch would make every settlement revert with OutcomeMismatch, so the pairing is pinned
 * by test/hash.test.ts (pure TS vectors) and by contracts/test/Hashing.test.ts, which asks the
 * deployed contract to hash the same structs and compares.
 */

const OUTCOME_TYPEHASH = keccak256(toHex("IntentOS.Outcome.v1"));
const POLICY_TYPEHASH = keccak256(toHex("IntentOS.Policy.v1"));
const INTENT_TYPEHASH = keccak256(toHex("IntentOS.Intent.v1"));

export function hashLegs(legs: Outcome["legs"]): Hex {
  const items = legs.map((leg) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint16" }, { type: "uint256" }],
        [leg.token, leg.weightBps, leg.minOut],
      ),
    ),
  );
  return keccak256(encodePacked(["bytes32[]"], [items]));
}

export function hashExits(exits: Outcome["exits"]): Hex {
  const items = exits.map((exit) =>
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
        [exit.token, exit.amountIn, exit.minOut],
      ),
    ),
  );
  return keccak256(encodePacked(["bytes32[]"], [items]));
}

export function hashOutcome(outcome: Outcome): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint8" },
        { type: "address" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        OUTCOME_TYPEHASH,
        outcome.kind,
        outcome.inputToken,
        outcome.inputAmount,
        outcome.recipient,
        outcome.maxSlippageBps,
        hashLegs(outcome.legs),
        hashExits(outcome.exits),
      ],
    ),
  );
}

export function hashPolicy(policy: Policy): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint16" },
        { type: "uint16" },
        { type: "bool" },
        { type: "bytes32" },
      ],
      [
        POLICY_TYPEHASH,
        policy.maxNotional,
        policy.validAfter,
        policy.validUntil,
        policy.maxFeeBps,
        policy.minReputationBps,
        policy.requireRwaAttested,
        keccak256(encodePacked(["address[]"], [policy.tokenAllowlist])),
      ],
    ),
  );
}

export interface IntentIdParams {
  chainId: number | bigint;
  registry: Address;
  owner: Address;
  outcomeHash: Hex;
  policyHash: Hex;
  salt: Hex;
  auctionEndsAt: bigint;
  deadline: bigint;
}

/** Mirrors IntentRegistry.computeIntentId. */
export function computeIntentId(params: IntentIdParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
      ],
      [
        INTENT_TYPEHASH,
        BigInt(params.chainId),
        params.registry,
        params.owner,
        params.outcomeHash,
        params.policyHash,
        params.salt,
        params.auctionEndsAt,
        params.deadline,
      ],
    ),
  );
}

/** Hash of a solver's full route plan, committed in its bid and revealed at settlement. */
export function hashPlan(entryRoutes: { router: Address; path: Address[] }[], exitRoutes: { router: Address; path: Address[] }[]): Hex {
  const encode = (routes: { router: Address; path: Address[] }[]) =>
    routes.map((r) => keccak256(encodePacked(["address", "address[]"], [r.router, r.path])));
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [
        keccak256(encodePacked(["bytes32[]"], [encode(entryRoutes)])),
        keccak256(encodePacked(["bytes32[]"], [encode(exitRoutes)])),
      ],
    ),
  );
}
