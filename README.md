# IntentOS

**The X Layer-native Intent Operating System for agents, stablecoins, and Real World Assets.**
You state an outcome — a gasless USDG payment, an xStocks basket, an RWA onboard — competing
AI and KYB’d solvers work out how to reach it; the chain enforces that they did.

```
"Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight,
 max 0.5% slippage, only attested assets, fees under 0.25%"
```

That sentence becomes a committed intent, a solver auction, and one atomic settlement — with the
weights, the per-leg floors, the fee cap and the RWA attestation requirement all enforced by the
settlement contract rather than trusted to whoever executes it.

---

## Why this shape

Buying a basket of tokenized equities today means a sequence: approve, swap, approve, swap, watch
each fill, fix the ones that moved. Every step is a decision the user has to make and a place the
user can be hurt. Agents have it worse — they must encode all of that as transactions.

IntentOS moves the boundary. The user declares *what should be true afterwards*. Solvers compete
over *how*. And the contract checks the result against the declaration before anything is final:

- **Weights are not negotiable.** Settlement sizes every leg from the weights the user committed
  to. A solver cannot skew a basket toward the leg it happens to have inventory in.
- **Floors are doubled.** Each leg must clear the user's own `minOut` *and* the guarantee the
  winning solver put in its bid, whichever is higher.
- **The whole notional gets deployed.** A solver that leaves more than the declared slippage
  tolerance undeployed has its settlement reverted.
- **Guardrails travel with the intent.** Spend caps, fee ceilings, solver reputation floors,
  token allowlists and "this must be an attested real-world asset" are committed at submission
  and checked at settlement.

Single-chain is a design choice. One atomic settlement against one set of venues means no bridge
latency to model, no half-finished cross-chain state, and a solver guarantee that means exactly
what it says.

## The loop, running

```
$ npm run demo

A four-asset xStocks basket, stated in one sentence
  "Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight, ..."

· parsed by grammar
  Deploy 10,000 USDT across 25% TSLAx (at least 7.4964 TSLAx), 25% NVDAx (at least 13.7325 NVDAx),
  25% AAPLx (at least 10.7558 AAPLx), 25% SPYx (at least 3.87 SPYx), with at most 0.50% slippage per leg.
  Solver fee is capped at 0.25% of the notional.
  Every asset acquired must carry a live RWA attestation onchain.
✓ intent 0x205481b05f1f… committed onchain

· solvers are bidding…
· [conservative] declined — leg 3 cannot be guaranteed above the user's floor
· [aggressive]   bid — 8 bps fee, 93.2% confidence, leg 0 via XSwap-sim, … leg 3 via OKX-DEX-sim
· selected aggressive at 0.08% fee
✓ settled onchain

  asset  before     after    change
  USDT   1,000,000  990,000  -10,000
  TSLAx  0          7.562    +7.562
  NVDAx  0          13.855   +13.855
  AAPLx  0          10.845   +10.845
  SPYx   0          3.896    +3.896
```

Two solvers with different risk appetites, a real decline, a real auction, and a settlement that
moved the portfolio exactly as declared.

## Quickstart

```bash
npm install
npm run chain          # terminal 1 — a local X Layer stand-in
npm run deploy:local   # terminal 2 — contracts, demo assets, two venues
npm run demo           # the whole loop, end to end
```

Then the distributed version — a coordinator, solvers and an agent as separate processes:

```bash
COORDINATOR_PRIVATE_KEY=0x5de4…365a npm run dashboard   # http://localhost:8787
npm run solvers                                          # two bonded solvers
AGENT_PRIVATE_KEY=0x7c85…07a6 npm run agent -- "put 5,000 USDT into NVDA and AAPL, 60/40"
```

Natural-language parsing uses Claude when `ANTHROPIC_API_KEY` is set and a deterministic grammar
otherwise, so everything above works offline. See [docs/xlayer.md](docs/xlayer.md) for X Layer
testnet and mainnet.

## What is here

| Package | What it does |
|---|---|
| `contracts/` | The Intent Standard, registry, solver reputation, policy engine and settlement |
| `packages/intent-schema` | The shared definition of an intent: types, validation, canonical hashing |
| `packages/intent-ai` | Natural language → a validated intent, via Claude or a grammar fallback |
| `packages/sdk` | What an agent imports: declare, submit, track, verify |
| `packages/solver-core` | Quoting, planning, scoring, the auction, the coordinator |
| `apps/api` | Coordinator service: parsing, the intent mempool, auction closing, dashboard |
| `apps/solver-agent` | Runs bonded solvers against a deployment |
| `apps/agent` | The one-command agent path |
| `apps/demo` | The full loop against a live chain |
| `apps/web` | Public playground: parse a sentence, see the committed intent, preview the solver auction |

Deeper: [architecture](docs/architecture.md) · [the intent standard](docs/intent-standard.md) ·
[trust model](docs/security.md) · [X Layer deployment](docs/xlayer.md) ·
[hosting the playground](docs/deploy.md) · [frontend brief](docs/FRONTEND-BRIEF.md)

## The AI, specifically

Two places, doing different jobs.

**Parsing** turns a request into an intent. Claude fills in an `IntentSpec` through structured
outputs — and that spec talks only in tickers, decimal amounts and percentages. It never names an
address, a wei amount or a basis point. A deterministic compiler resolves symbols against the
onchain asset catalog, converts units, derives per-leg floors from live quotes, and runs the
result through the standard's own validation. **A hallucinated ticker fails resolution instead of
reaching a transaction.**

**Solving** is the competitive part. Each solver quotes every allowlisted venue for every leg at
the size that leg will actually trade, picks a route per leg, and optimises delivered value
discounted by the chance its own plan reverts, net of fee and gas. Strategies differ in how much
of the quote they will be bound to — which is why the auction has something to choose between.

## Testing

```bash
npm test     # 34 contract tests, 57 package tests
```

The contract suite covers weight fidelity, per-leg floors, the solver's own auction guarantee,
commitment mismatch, router allowlisting, atomic rebalances, cash sleeves, auction timing,
dominance challenges, reputation movement, expiry and every policy guardrail.

Offchain and onchain hashing are pinned to each other: `contracts/scripts/gen-vectors.ts`
generates a fixture *from the contracts*, and both test suites replay it. An encoding drift fails
a test instead of every settlement.

## Status

Pre-MVP, built for the OKX Build X AI Season. The contracts are unaudited and the demo asset
universe is minted locally — the real xStocks addresses are deliberately left `null` in
`contracts/config/assets.ts` rather than guessed. Everything described above runs; nothing above
is a mock of itself.
