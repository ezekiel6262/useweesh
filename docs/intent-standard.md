# The IntentOS Intent Standard v0.1

An intent is a commitment to an outcome. This is what one contains, how it is encoded, and what
the chain will hold a solver to.

The definition lives in two places that must agree byte for byte:
`contracts/contracts/libraries/IntentLib.sol` and `packages/intent-schema`. They are pinned to
each other by a shared fixture — see [Hashing](#hashing).

## Outcome

```solidity
struct Outcome {
    Kind    kind;            // SWAP | BASKET | REBALANCE | RWA_ONBOARD | BATCH
    address inputToken;      // what the user parts with; the base asset for a REBALANCE
    uint256 inputAmount;     // 0 for a pure rebalance — the exits fund it
    address recipient;       // where the outputs land
    uint16  maxSlippageBps;  // ceiling on top of every leg's own floor
    BasketLeg[] legs;        // what to end up holding
    ExitLeg[]   exits;       // what to sell first (REBALANCE only)
}

struct BasketLeg { address token; uint16 weightBps; uint256 minOut; }
struct ExitLeg   { address token; uint256 amountIn; uint256 minOut; }
```

Rules the contracts enforce:

- `legs` is non-empty and `weightBps` sums to exactly `10_000`.
- `SWAP` and `RWA_ONBOARD` take exactly one leg.
- `REBALANCE` needs at least one exit; everything else must have none.
- `maxSlippageBps` may not exceed 2000 (20%), whatever the intent says.
- A leg whose token *is* the input asset is legal — that is a cash sleeve, and it is transferred
  rather than swapped.

`minOut` is the floor the user is unwilling to go below. It is enforced per leg, and the winning
solver's own auction guarantee is enforced on top of it.

## Policy

```solidity
struct Policy {
    uint256 maxNotional;        // hard cap on what settlement may spend; 0 = uncapped
    uint64  validAfter;
    uint64  validUntil;
    uint16  maxFeeBps;          // ceiling on the solver's success fee
    uint16  minReputationBps;   // floor on the winning solver's EMA score
    bool    requireRwaAttested; // every acquired asset must be attested onchain
    address[] tokenAllowlist;   // if non-empty, pins the intent to these assets
}
```

Policy is committed alongside the outcome and checked at settlement by `PolicyEngine`. It is what
makes handing an agent a budget reasonable: whatever it decides to do, it cannot step outside
this.

## Lifecycle

```
OPEN ──► SELECTED ──► FULFILLED
  │          │
  │          └── reportFailure / dominance challenge ──► OPEN
  ├── cancel ──► CANCELLED
  └── deadline passes ──► EXPIRED
```

`OPEN` accepts bids until `auctionEndsAt`. A winner may be selected between `auctionEndsAt` and
`deadline`, by the owner or by the bonded coordinator. Settlement must land before `deadline`.
`expire` is permissionless once the deadline passes, and marks down a solver that won and walked
away.

## Bids

```solidity
struct Bid {
    address solver;
    uint16  feeBps;
    uint32  etaSeconds;
    bytes32 planHash;          // the routes, revealed at settlement
    uint256[] guaranteedOut;   // one per acquisition leg — binding
}
```

`guaranteedOut` is the promise. Settlement enforces `max(leg.minOut, guaranteedOut[i])` on every
leg, so overpromising does not win an auction, it loses a settlement and a reputation point.

## Hashing

```
outcomeHash = keccak256(abi.encode(
    keccak256("IntentOS.Outcome.v1"), kind, inputToken, inputAmount,
    recipient, maxSlippageBps, hashLegs(legs), hashExits(exits)))

policyHash  = keccak256(abi.encode(
    keccak256("IntentOS.Policy.v1"), maxNotional, validAfter, validUntil,
    maxFeeBps, minReputationBps, requireRwaAttested, keccak256(abi.encodePacked(tokenAllowlist))))

intentId    = keccak256(abi.encode(
    keccak256("IntentOS.Intent.v1"), chainId, registry, owner,
    outcomeHash, policyHash, salt, auctionEndsAt, deadline))
```

Leg order is part of the commitment, and so is every field in it: change a weight, lower a floor,
drop a leg, reorder the allowlist, or clear `requireRwaAttested`, and the hash moves.

`intentId` is derived onchain rather than supplied, so an id cannot be squatted before its owner
uses it.

To regenerate the cross-language fixture after any encoding change:

```bash
cd contracts && npx hardhat run scripts/gen-vectors.ts
```

Both `contracts/test/Hashing.test.ts` and `packages/intent-schema/test/hash.test.js` replay it.

## Offchain metadata

Not hashed, and not enforced — provenance and scheduling that solvers and coordinators use but
the chain does not need:

- `prompt`, `source`, `summary` — where the intent came from and what it says in words.
- `schedule` — recurrence, executed by the agent runtime as one submission per period.
- `conditions` — preconditions a solver checks before serving (`price`, `drawdown`,
  `volatility`, `time`, `portfolio-drift`). A missing observation fails closed: the intent is
  left unserved rather than served blind.
- `createdAt` — chain time at stamping, so the auction window can be described.

Conditions and recurrence are deliberately offchain in v0.1. Putting them onchain means an oracle
and a keeper, which is a larger design than this version is trying to settle.
