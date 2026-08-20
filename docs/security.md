# Trust model

What IntentOS assumes, what it enforces, and what it does not yet cover.

## What a user is trusting

**Not the solver.** A solver picks routes; it cannot pick amounts, recipients, weights or floors.
Everything it might want to shade is committed before the auction and checked at settlement.
Overpromising in a bid is not an exploit, it is a failed settlement and a reputation loss.

**Not the coordinator, for their money.** The coordinator publishes drafts and closes auctions. It
cannot change what settles: the user's floors, slippage ceiling and policy bind whichever solver
wins. It *can* pick a worse-but-valid solver, so it posts a bond that anyone can slash by pointing
at a recorded bid that dominates the one it chose.

**Not the mempool.** Drafts arrive from a service the solver did not write. Every solver verifies
a draft against the onchain commitment before planning, and the coordinator does the same before
accepting one into the pool.

**Not the language model.** The model proposes a spec in tickers, decimals and percentages. It
never emits an address or a wei amount. Symbols resolve against the onchain catalog, and an
unknown ticker raises `UnknownAssetError` instead of producing a transaction. The compiled draft
is validated by the standard before submission.

**They are trusting**: governance's router allowlist, the RWA attestors, and the correctness of
the contracts.

## What is enforced onchain

| Property | Where |
|---|---|
| Basket weights are exactly as declared | `IntentSettlement._acquire` sizes legs itself |
| Each leg clears the user's floor and the solver's guarantee | `_floorFor` + `BelowFloor` |
| Outputs are measured, not reported | balance delta on the recipient, never the router's return |
| The whole notional is deployed, or it reverts | `CapitalUnderdeployed` |
| The revealed outcome and policy match the commitment | `OutcomeMismatch` / `PolicyMismatch` |
| Only the winning solver may settle | `NotSelectedSolver` |
| Only allowlisted routers may be called | `RouterNotAllowed` |
| Fee ≤ the intent's cap; notional ≤ the intent's cap | `PolicyEngine.check` |
| Assets are attested, if the intent required it | `RWARegistry.isAttested` |
| A dominated selection is slashable | `IntentRegistry.challengeSelection` |

## Known limits

- **Unaudited.** Nothing here has had a security review.
- **Winner selection is ranked offchain.** Only its *integrity* is enforced onchain, via
  dominance. Scoring heterogeneous baskets onchain needs a value oracle; that is future work.
- **The coordinator is a single party in this version.** It is bonded and challengeable, not
  decentralised.
- **Conditions and recurrence are offchain.** A solver that ignores an intent's declared
  preconditions is not punished by the chain for it; it simply serves an intent the user would
  rather it did not, within the guardrails that *are* enforced.
- **Attestation is as good as its attestors.** `RWARegistry` records who said what and when, with
  a review date after which an attestation goes stale. It does not verify custody.
- **`MockDexRouter` is a test venue.** Real deployments must allowlist real routers.
- **Fee-on-transfer and rebasing tokens are out of scope.** Settlement measures balance deltas, so
  such tokens would not be silently mis-accounted, but they are not tested.

## Reporting

This is a hackathon-stage project. If you find something, open an issue.
