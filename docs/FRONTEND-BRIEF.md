# IntentOS — Claude Design brief

Paste this whole document into Claude Design. Design a better frontend for a **live** product, not a concept deck. The protocol already runs on X Layer testnet. You are replacing the visual system and information architecture of two surfaces: the marketing homepage and the compose app.

**Live:** https://intentos-nine.vercel.app  
**Compose:** https://intentos-nine.vercel.app/app  
**Spec:** https://intentos-nine.vercel.app/spec  
**Repo:** https://github.com/ezekiel6262/useweesh  
**Hackathon:** OKX Build X AI Season  
**Chain:** X Layer testnet, chain id **1952** (mainnet would be 196). Gas in OKB.

Do not invent a different product. Do not turn it into a DEX, a chatbot, a portfolio tracker, or a cross-chain aggregator.

---

## 1. Vision

**IntentOS is the X Layer-native Intent Operating System for agents, stablecoins, and Real World Assets.**

People and agents should not have to encode four swaps, four approvals, and a hope that the book does not move. They declare an **outcome** — what should be true afterwards. Competing solvers (AI, KYB-attested, RWA specialists, agent-run) bid on **how**. The chain **enforces that they did**.

Hero copy (use this, or a tighter sibling — do not dilute it):

> State what should be true *afterwards*.  
> AI and compliant solvers compete over how. The chain enforces that they did.

Positioning line:

> IntentOS — the X Layer-native Intent Operating System for agents, stablecoins, and Real World Assets.  
> Declare any outcome (including complex multi-asset xStocks positioning and RWA tokenization flows) and let AI + compliant solvers fulfill it.

### Why this exists

Tokenized equities and stables on X Layer are real. Using them still looks like a DEX: approve, swap, approve, swap, fix the fill that slipped. Agents have it worse — they must emit transactions, not outcomes.

IntentOS moves the boundary:

- The user (or agent) commits to an outcome and a policy.
- Solvers compete on fee, speed, and **binding per-leg guarantees**.
- Settlement sizes every leg from the user’s weights. A solver never supplies amounts.
- If a floor is missed, if capital is under-deployed, if a non-KYB solver wins a compliant intent — the transaction reverts. Nothing is “best effort.”

### What it is not

Not LI.FI. Not a bridge. Not a chat UI that “does DeFi for you.” Single-chain on purpose: one atomic settlement, no half-finished cross-chain state, a guarantee that means exactly what it says.

### Differentiation the UI must make *visible* (not just claimed)

1. **Weights are not negotiable.** Settlement computes leg sizes from committed `weightBps`.
2. **Floors are doubled.** Each leg must clear `max(user minOut, solver guarantee)`. Output is measured as a balance delta on the recipient, never taken from a router’s return value.
3. **The whole notional gets deployed.** Under-deployment reverts. Dust returns to the owner.
4. **Guardrails travel with the intent.** Fee cap, spend cap, reputation floor, allowlist, RWA attestation, KYB-only solvers, gas sponsorship — hashed at submit, checked at settle.
5. **Only hashes go onchain** until settlement. A doctored draft cannot settle.
6. **Agents are first-class.** They declare via SDK. They can also register as solvers.
7. **Gasless path.** Owner signs EIP-712 Submit + ERC-20 permit. Coordinator pays submit gas. Solvers pay fulfillment gas.
8. **Modular solvers.** Lanes: AI · KYB · RWA · STABLE · AGENT · GASLESS. A compliant intent reverts if a non-KYB solver wins.

---

## 2. What IntentOS consists of

Think of it as an OS, not an app. Five layers, one loop.

```
sentence  →  IntentSpec  →  IntentDraft  →  hashes onchain  →  solver auction  →  settlement
             (tickers, %)    (addresses,     IntentRegistry      bids + select      reveal, size,
                              wei, bps)                                           measure, revert
```

### 2.1 Intent Standard (`packages/intent-schema` + `IntentLib.sol`)

Canonical types and hashing. Two packages must agree byte-for-byte or every settlement reverts with `OutcomeMismatch`.

**Kinds** (type badges in the UI):

| Kind | What it is |
|---|---|
| `SWAP` | One asset in → one asset out |
| `BASKET` | One asset in → weighted set out (xStocks portfolios) |
| `REBALANCE` | Exits → base → entries, one atomic tx |
| `RWA_ONBOARD` | Acquire an attested tokenized real-world asset |
| `BATCH` | Several of the above declared together |
| `PAYMENT` | 1:1 stable send (cash sleeve), including gasless USDG |

**Lifecycle pills:** `OPEN` → `SELECTED` → `FULFILLED`  
Side paths: `CANCELLED`, `EXPIRED`, back to `OPEN` on failure or a dominance challenge.

**An outcome** is: kind, input token/amount, recipient, slippage ceiling, acquisition legs (`token, weightBps, minOut`), exit legs (rebalance only).

**A policy** (v2) is: spend cap, validity window, fee cap, reputation floor, `requireRwaAttested`, `requireCompliant` (KYB), `sponsorGas`, token allowlist.

Registry stores `outcomeHash` and `policyHash`, not contents.

### 2.2 Contracts (onchain, X Layer 1952)

| Contract | Job |
|---|---|
| **IntentRegistry** | Commit hashes, auction, select winner, `submit` and gasless `submitFor` (EIP-712). Optional `integrator` pins who may select. |
| **IntentSettlement** | Only contract that touches user funds. Reveal, size legs, call allowlisted routers, measure deltas, enforce floors and spend, pay solver, report reputation. |
| **PolicyEngine** | Guardrails. Evolves without touching the money-mover. |
| **SolverRegistry** | Bond, EMA reputation, capability bits, owner-attested KYB. |
| **RWARegistry** | Attestations (ISIN / asset ref) and onboarding requests. |

Live testnet (do not invent other addresses):

- Registry `0x2cc22cA31E1767Dbe639BA74AA441A4DE76606fD`
- Settlement `0x6ddA9DC53b789a13eAc897CD2fCEc8a35607f10C`
- PolicyEngine `0xdBE7d92110f5aa428535Eb68291c668A203bE9b1`
- SolverRegistry `0x073a5541F4f8973dC36428E6a70Dac72922eb8ed`
- RWARegistry `0x780D39477b869681a23a0c4AB3bE17B9CDEBe875`
- USDT `0x90DB51E0d7b70CFa7f49fF27Cd5bfccecb8bF6e1`
- USDG `0x7146B28DCea1bC2a5f35D25306373A24F61bE29B`

### 2.3 Parser (`packages/intent-ai`)

A sentence becomes an `IntentSpec` in tickers, decimal amounts, and percents — **never addresses**. A deterministic compiler resolves symbols against the onchain catalog. A hallucinated ticker dies at the catalog, not in a transaction. Do not name the model in the UI.

### 2.4 Solvers (`packages/solver-core`)

They watch open intents, quote venues, bid `{ feeBps, eta, planHash, guaranteedOut[] }`, and settle what they win. Two live solvers:

- **Aggressive** — AI + RWA + stable + gasless. Tight guarantees, wins on price. Often the one that fills a tight basket.
- **Conservative** — KYB-attested + RWA + agent + gasless. Leaves headroom; the only solver that can fill a `requireCompliant` intent.

A decline is a feature. Show it.

### 2.5 Coordinator + relay

Bonded auctioneer. Closes auctions so agents need not stay online. Pays gas for `submitFor` (gasless submit). Anyone can `challengeSelection` if a recorded bid Pareto-dominates the pick and take a cut of the coordinator bond.

### 2.6 Agent SDK (`packages/sdk`)

```ts
await agent.declare("put 5,000 USDT into NVDA and AAPL, 60/40, only attested assets");
await agent.track(intentId);
```

Clarifications hold the intent — nothing is signed until the spec is complete. Recurrence is metadata; the agent runtime submits once per period.

---

## 3. Architecture the UI must reflect

Do not invent a different loop. The product *is* this loop.

```
sentence
   │
   ▼
parse  ──► IntentSpec (tickers, percents, decimals only)
   │
   ▼
compile against onchain catalog  ──► IntentDraft (addresses, wei, bps)
   │
   ▼
sign EIP-712 Submit (+ permit if allowance needed)
   │
   ▼
coordinator relays submitFor     ← owner never sends the submit tx
   │
   ▼
IntentRegistry stores outcomeHash + policyHash
   │  auction window (~30s on testnet)
   ▼
solvers bid { fee, eta, planHash, guaranteedOut[] }
   │
   ▼
coordinator or owner (or named integrator) selects
   │  challengeSelection if a recorded bid dominates
   ▼
IntentSettlement.settle
   · reveal outcome + policy (hash-match or revert)
   · size legs from weightBps
   · execute allowlisted routers
   · measure recipient balance deltas
   · enforce max(user minOut, solver guarantee)
   · enforce spend, fee, RWA, KYB, gasless capability
   · pay solver, report reputation
```

**Trust model to make legible in the UI:**

- Mempool / draft: untrusted. Wrong hash → unsettleable.
- Solver: untrusted. Bid is a promise the contract enforces.
- Coordinator: cannot steal funds; can pick a worse solver; that is slashable.
- Settlement: the only trusted arithmetic.

---

## 4. Who it is for (in this order)

1. **Hackathon judges** — must *see* a four-asset xStocks basket, a KYB lane, a gasless payment, an auction, a settlement, in under a minute.
2. **AI agents** — primary user. GUI should make that obvious (SDK snippet, “source: agent”).
3. **Advanced users / desks** — people who would otherwise click four swaps.
4. **Neobanks / fintechs on X Layer** — integrator-controlled, KYB solvers, USDG rails.
5. **Solver operators** — reputation, bond, lanes.

Do not design first-time-crypto onboarding. Assume USDT, slippage, and DEX are known. Do explain *intents* — most visitors have never seen commit-hash-then-reveal.

---

## 5. Surfaces to design (two products, one brand)

There are **two** public surfaces. They must feel related and **must not look the same**.

### Surface A — Homepage `/` (marketing / protocol story)

Editorial. Vision, loop, why X Layer, why xStocks, why agents, why KYB, why gasless. CTA: **Declare an intent** → `/app`. Secondary: Spec.

Current homepage already has this story; it is thin. Design it as a **protocol site**: one strong lede, the four-stage loop, four use-case clusters (payments, RWA/xStocks, compliant, agents), solver lanes, one combined example intent, SDK fragment, live-on-testnet banner.

Do not put a working composer on the homepage.

### Surface B — Compose `/app` (the product)

This is the OS. Dense. Operator-grade. Always-on **playbook** (things you can declare) and **protocol console** (chain, registry, lanes, assets, what is enforced). Composer is the hero control, not a blank void.

**Desktop layout (1080–1440px):**

- Top bar: mark + `intentos`. Nav: Home / Compose / Spec. Live chip `X Layer · 1952`. Connect.
- **Left (wider):**
  - Intent composer: textarea, Parse, Submit & settle, Mint stables.
  - Four-step loop strip (Declare / Commit / Auction / Settle) — light the live step.
  - After parse: committed outcome (kind badge, explanation, weight table with bars, floors).
  - After submit: settlement log (bids, declines, winner, tx).
  - Playbook: categorized intents. Click loads the prompt. Groups: Stablecoins & payments · xStocks & RWA · Compliant & agents.
- **Right (sidebar ~360px, never overflow hashes):**
  - Session: account, network, balances (USDT, USDG, xStocks), last intent.
  - Protocol console: chain, live/offline, registry, settlement, lanes, kinds, “you sign · coordinator pays gas”, asset pills.
  - Policy chips (after parse).
  - Commitment: stacked outcome/policy hashes in boxed mono, copy, caption “only hashes onchain.”
  - Registry: recent intents, status pills, link to `/intent/?id=`.

**Empty state must not feel empty.** Playbook + console + loop are always visible. Session explains connect/mint without looking abandoned.

### Surface C — Intent record `/intent/?id=0x…`

A receipt. Status, kind, owner, solver, auction/deadline, stacked hashes, bids table. Same chrome as compose.

### Surface D — Spec `/spec`

Keep as a reading surface (Intent Standard). You may restyle; do not turn it into marketing.

---

## 6. Playbook intents (pre-fill these; they parse against the live catalog)

**Payments**

- Pay 500 USDG gaslessly to 0x000000000000000000000000000000000000cafe
- Swap 2,500 USDT into USDG with 0.1% max slippage
- Pay 1,200 USDG gaslessly to 0x000000000000000000000000000000000000cafe every month

**xStocks / RWA**

- Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight, max 0.5% slippage, only attested assets, fees under 0.25%
- Using only compliant solvers, allocate 25,000 USDT equally across TSLA, NVDA, AAPL, META and SPY xStocks with max 0.3% slippage
- Rebalance my xStocks to 25% TSLA, 25% NVDA, 25% AAPL, 25% SPY every Monday
- Allocate 8,000 USDT equally across TSLA, NVDA and AAPL, only if 24h volume exceeds 1000000
- Exit all TSLA, NVDA and AAPL into USDG if volatility spikes above 40
- Onboard SPY xStock as an attested RWA and put 5,000 USDT into it, only attested assets

**Agents / enterprise**

- Using only compliant solvers, integrator-controlled, allocate 15,000 USDT equally across TSLA and NVDA xStocks, only attested assets
- put 5,000 USDT into NVDA and AAPL, 60/40, only attested assets

Combined vision example (homepage, even if the parser cannot yet compile ETH/vaults):

> Using only compliant solvers, gaslessly convert stables into a diversified basket of 6 xStocks on X Layer, then rebalance monthly.

---

## 7. Assets, venues, solvers (what to show)

**Assets:** USDT (6dp, base), USDG (6dp, base, 1:1 rail vs USDT), TSLAx, NVDAx, AAPLx, METAx, SPYx, GOOGLx (18dp, RWA-attested stand-ins). Aliases: TSLA → TSLAx, etc. On testnet these are protocol-deployed mocks with real settlement.

**Venues:** OKX-DEX-sim (30 bps), XSwap-sim (20 bps). Different depth/skew so routing is a real choice.

**Solver lanes to badge:** AI, KYB, RWA, STABLE, AGENT, GASLESS.

**Guardrail chips (committed, not advisory):**

- `fee ≤ 0.25%`
- `slippage ≤ 0.50%`
- `RWA attested`
- `KYB solvers only`
- `solver sponsors gas`
- `pinned to TSLAx, NVDAx, …`
- `reputation ≥ n%`

**Hashes:** boxed mono, wrap by design (4-hex groups or `overflow-wrap`), copy button. Never a flex row of label | 66-char hex.

**Basket viz:** horizontal weight bars, not pies. Percent + floor. Floor `"0"` → label **open** (binds from the winning bid).

---

## 8. Visual system

**Mood:** Weesh paper applied to a protocol OS. Light only. Editorial, institutional, quiet. Cream paper, terracotta, not a terminal and not a consumer fintech gradient.

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#f7f4ee` | page |
| `--surface` | `#fffdf9` | cards |
| `--ink` | `#241f1a` | text |
| `--ink-muted` | `#59524a` | secondary |
| `--ink-faint` | `#8a8177` | labels |
| `--accent` | `#7a3b2e` | terracotta — actions, live step |
| `--accent-soft` | `#f1e2d8` | chips, banner |
| `--divider` | `#e5ddd1` | rules |
| `--yes` | `#3f7a5c` | attested, fulfilled, winner, KYB |
| `--no` | `#a4463a` | declined, exits, errors |
| `--warn` | `#8a6a2a` | bidding / selected |

**Type:** Newsreader (serif) for mark and headlines, italic for emphasis words (`afterwards`). Work Sans for UI. IBM Plex Mono for hashes, amounts, chips, console, status. Tabular figures.

**Radius:** 12–14px cards, 999px pills. Shadow `0 4px 20px rgba(36,31,26,.06)`.

**Mark:** chevron already used as favicon — cream rounded square, terracotta path `M7 11 L16 23 L25 11`. Do not replace with a robot or a generic “AI” spark.

**Density:** information-dense. Judges should see composer + playbook + console without hunting. Mobile: single column, chips wrap, hashes wrap in boxes.

**Do not:** dark theme, glassmorphism, Web3 purple, NFT art, 3D coins, fake TVL, “Powered by AI” sparkle, naming the model, connect-wallet as the homepage hero.

---

## 9. Microcopy

Short, specific, slightly stern. Protocol voice.

Good:

> Only these hashes are stored onchain. Settlement reveals the outcome and reverts on mismatch.

> You sign. The coordinator pays submit gas. Solvers pay fulfillment.

> Weights are not negotiable. Floors are doubled. The whole notional gets deployed, or it reverts.

Bad:

> ✨ AI is crafting your personalized DeFi journey.

Errors are first-class: unknown ticker → show catalog; wallet reject → say so; 0 OKB fallback → explain relay vs self-submit.

Never mention the model name in the UI.

---

## 10. Implementation constraints (the design must survive these)

The live compose app is `apps/web/public/app/index.html` plus `window.IntentOS` from `app.js`.

**Compose talks to:**

- `POST /api/parse` `{ prompt, recipient }` — returns draft, explanation, hashes
- `POST /api/relay` — gasless submitFor (coordinator pays)
- `POST /api/bid` `POST /api/close` `POST /api/settle`
- `GET /api/health` `GET /api/deployment` `GET /api/recent`
- Wallet: `connectWallet`, `mintTestUsdt` (mints USDT **and** USDG), `submitDraft`, `readBalances`

Amounts on the wire may be tagged `n:<bigint>`.

Homepage and spec are static HTML. Compose is static HTML + those APIs. Deliver HTML/CSS that can drop into:

| File | Role |
|---|---|
| `apps/web/public/index.html` | Homepage |
| `apps/web/public/app/index.html` | Compose OS |
| `apps/web/public/intent/index.html` | Intent record |
| `apps/web/public/spec/index.html` | Standard (optional restyle) |

Keep routes `/` `/app` `/spec` `/intent`. Do not require a SPA framework. A single-page hash app is acceptable if it still ships as static files.

Wallet: OKX Wallet in-app browser, chain 1952. Prefer `eth_signTypedData_v4` for gasless; `eth_sendTransaction` fallback. Do not use a third-party tx executor pattern that OKX rejects.

---

## 11. What a better frontend should fix (pain of the current UI)

The protocol is stronger than the screens. Current compose is a paper form: empty until parse, hashes that used to overflow, a playbook bolted under the prompt. Design should feel like **an OS console for intents**, not a textarea on cream paper.

Priorities:

1. Compose must look complete the moment it loads (playbook + console + loop), then get *more* specific after parse (outcome, policy, hashes, settlement log).
2. Homepage must sell the OS, not clone the app.
3. Hashes, addresses, timestamps always stack or truncate — never horizontal overflow.
4. Solver activity should feel like a live auction (two named solvers, decline vs bid, winner chip), not a log dump.
5. Session should feel like a signed-in terminal: account, stables, xStocks, last intent, network.
6. Make KYB / gasless / USDG / xStocks *legible as protocol features*, not footer trivia.

---

## 12. Success

Someone opens `/` and understands, in fifteen seconds: outcomes not transactions; X Layer; agents + stables + RWA.

They open `/app` and, without reading a docs page, can pick a four-asset xStocks basket, see weights and hashes, and understand that solvers will compete and the chain will check.

They can also see they could have paid USDG gaslessly, or required KYB solvers, without leaving compose.

If the visual system fights those beats, change the visuals, not the beats.
