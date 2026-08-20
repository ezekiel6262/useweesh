# Architecture

IntentOS has four moving parts: a commitment, an auction, a settlement, and the AI that feeds the
first and drives the second.

```
  request ──► parse ──► IntentDraft ──► submit ─────────────────► IntentRegistry
  (a sentence)  │        (validated)     (hashes only)              │
                │                                                   │ auction window
                └── the draft is published to the mempool ──┐       │
                                                            ▼       ▼
                                                        solvers  place bids
                                                            │       │
                                                            │       ▼
                                                            │   coordinator selects
                                                            │       │
                                                            ▼       ▼
                                                        winner ─► IntentSettlement
                                                                    │
                                                        reveal outcome + policy,
                                                        execute, verify, pay, report
```

## Commitment, not instruction

`IntentRegistry.submit` takes the hash of the outcome and the hash of the policy — not their
contents. The id is derived onchain from those hashes plus the owner, a salt and the timing, so
nobody can squat on an id another account is about to use.

Only at settlement are the outcome and policy revealed, and `IntentSettlement` rejects anything
that does not hash to what was committed. That is what makes the offchain mempool safe to be
untrusted: a doctored draft is simply unsettleable.

## Where the enforcement lives

`IntentSettlement` is the only contract that touches user funds, and it is deliberately the one
doing the arithmetic:

- **Leg sizing** is computed from the committed `weightBps`, with the final leg absorbing the
  rounding remainder. The solver supplies routes; it never supplies amounts.
- **Per-leg floors** are `max(user minOut, winning bid's guarantee)`. Output is *measured* as a
  balance delta on the recipient, never taken from the router's return value.
- **Capital deployment** is checked: `spent >= spendable × (1 − maxSlippageBps)`. A solver cannot
  quietly under-deploy and pocket the difference — leftovers go back to the owner either way.
- **Policy** is delegated to `PolicyEngine`, so guardrails can grow without touching the contract
  that moves money.

A rebalance runs the same path: exits are sold into the base asset first, and whatever they raise
becomes the entry budget. Exits and entries land in one transaction, so the portfolio is never
caught half-rotated.

## The auction, and what makes it honest

Bids are public and binding: a fee, an ETA, a plan hash, and a vector of guaranteed outputs — one
per leg. Winning means being held to that vector at settlement.

Selection can be done by the intent owner, or delegated to a bonded coordinator so agents need not
stay online. A dishonest coordinator cannot hurt the user directly — the user's own floors and
policy are enforced whichever solver wins — but it could pick a worse solver. So that is made
expensive: anyone may call `challengeSelection` with a recorded bid that *Pareto-dominates* the
winner (no worse on every leg, no worse on fee, strictly better somewhere) and take a cut of the
coordinator's bond, and the intent returns to auction.

Dominance is the right primitive here because it is comparable without a price oracle. Full
onchain scoring of heterogeneous baskets is not, which is why ranking happens offchain and only
its integrity is enforced onchain. The coordinator's own selection code refuses to pick a
dominated bid for the same reason.

## Reputation

`SolverRegistry` keeps an EMA of settlement outcomes in basis points, seeded at 50% so a new
solver is neither trusted nor unusable, moving 20% of the way toward the latest result each time.
Only the registry may report outcomes. Intents can require a floor (`minReputationBps`), which is
what gives the score something to buy.

A solver that wins an auction and then fails to settle takes the hit — through `reportFailure`,
which hands the intent back to auction, or through `expire` once the deadline passes.

## The offchain half

**The mempool** carries the drafts behind commitments. It is a convenience, not an authority:
solvers verify every draft against the registry before planning, and a coordinator that served
doctored drafts would only be wasting its own credibility.

**Solvers** quote every allowlisted venue for every leg at the size that leg will actually trade —
including one hop through the base asset — then choose per leg. They value each leg's output back
into the base asset so a four-asset basket and a single swap score on the same axis, and discount
by the chance the plan reverts, which rises with how tight the tightest leg is and how many legs
must clear together.

**Strategies** differ in exactly one thing that matters: how much of the quote the solver is
willing to be bound to. That is what makes the auction more than a formality.

## Timing

Every deadline in the protocol is a block timestamp, so the SDK stamps intents from the chain's
next-block time rather than the machine's clock. Approvals mine blocks, RPC round trips take time,
and a read is evaluated against the head while a transaction lands in the block after it — an
intent timed off `Date.now()` can arrive with its auction already closed. Drafts are re-timed
immediately before submission for the same reason.
