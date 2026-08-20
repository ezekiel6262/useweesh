# IntentOS — frontend design brief

Paste this document into Claude Design (or any UI designer). It describes the product, the architecture, the surfaces to design, and the constraints the current codebase already imposes.

**Repo:** `https://github.com/ezekiel6262/useweesh`  
**Local:** `C:\Users\zek\projects\useweesh`  
**Hackathon:** OKX Build X AI Season (deadline ~Aug 21, 2026)  
**Public demo:** static site in `apps/web` (Vercel). Full coordinator dashboard is `apps/api/public`.

---

## 1. What this product is

**IntentOS** is a single-chain Intent Operating System native to **X Layer** (OKX’s zkEVM L2, chain id 196 mainnet / 195 testnet).

Users and AI agents declare **outcomes**, not transactions:

> “Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight, max 0.5% slippage, only attested assets, fees under 0.25%”

Competing AI solvers bid on *how*. The settlement contract on X Layer checks that the result matches the declaration before anything is final.

This is **not** a DEX UI, **not** a chat bot, and **not** a portfolio tracker. It is an operating system for intents: compose → commit → auction → settle → verify.

### Hero promise (use this copy)

**State what should be true afterwards.**  
AI solvers compete over how. The chain enforces that they did.

### Differentiation to keep visible

- **Weights are not negotiable.** Settlement sizes every leg from committed weights. A solver cannot skew a basket toward inventory it happens to hold.
- **Floors are doubled.** Each leg must clear the user’s `minOut` *and* the winning solver’s bid guarantee.
- **The whole notional gets deployed.** Under-deployment reverts.
- **Guardrails travel with the intent.** Fee cap, spend cap, solver reputation floor, token allowlist, RWA attestation — committed at submit, checked at settle.
- **Single chain.** One atomic settlement, no bridges, no half-finished cross-chain state.

---

## 2. Who it is for (design for these, in order)

1. **Hackathon judges** — must *see* a four-asset xStocks basket, a real solver decline, an auction, and a settlement in under 60 seconds.
2. **AI agents** — primary user. They submit via SDK, not a GUI. The GUI should show that agents are first-class (code snippet, “source: agent”).
3. **Advanced users** — people who would otherwise click four swaps on a DEX.
4. **Solver operators** — reputation, bond, bids.

Do **not** design onboarding for a first-time crypto user. Assume the visitor knows what USDT, slippage, and a DEX are.

---

## 3. Architecture the UI must reflect

Do not invent a different loop. The product *is* this loop.

```
sentence
   │
   ▼
parse (Claude or grammar)  ──► IntentSpec (tickers, %, decimals only)
   │
   ▼
compile against onchain asset catalog  ──► IntentDraft (addresses, wei, bps)
   │
   ├──────────────► published to offchain mempool (convenience, untrusted)
   ▼
IntentRegistry.submit(outcomeHash, policyHash)     ← only hashes go onchain
   │
   │  auction window
   ▼
solvers bid { fee, eta, planHash, guaranteedOut[] }
   │
   ▼
coordinator (bonded) or owner selects winner
   │  anyone can challengeSelection if a recorded bid Pareto-dominates
   ▼
IntentSettlement.settle
   · reveal outcome + policy (must hash-match)
   · size legs from weightBps (solver never supplies amounts)
   · execute allowlisted routers
   · measure balance deltas on the recipient
   · enforce max(user minOut, solver guarantee) per leg
   · enforce capital deployment, fee cap, RWA attestation
   · pay solver, report reputation
```

### Packages behind that loop (do not rename in the UI)

| Layer | Location | Role |
|---|---|---|
| Intent Standard | `packages/intent-schema` + `contracts/libraries/IntentLib.sol` | Types, validation, canonical hashing |
| AI parse | `packages/intent-ai` | Sentence → IntentSpec → compiled draft |
| Agent SDK | `packages/sdk` | `declare` / `track` / `verify` |
| Solver | `packages/solver-core` | Quote, plan, score, auction |
| Contracts | `contracts/` | Registry, settlement, policy, solver reputation, RWA attestations |
| Coordinator API | `apps/api` | Mempool, parse, auction close, live dashboard |
| Public playground | `apps/web` | Static. Parse + preview. **Never signs.** |

### Intent kinds (show as a type badge)

`SWAP` · `BASKET` · `REBALANCE` · `RWA_ONBOARD` · `BATCH`

### Lifecycle (status pills)

`OPEN` → `SELECTED` → `FULFILLED`  
side paths: `CANCELLED`, `EXPIRED`, back to `OPEN` on failure / dominance challenge.

---

## 4. Hard product constraints (the UI must obey these)

1. **The hosted Vercel site is static.** It runs the grammar parser in the browser. It does not have a wallet, a coordinator, or an Anthropic key. Label it `playground`. Never imply the visitor’s funds moved.
2. **A live auction needs `apps/api`** (long-running process with keys). Serverless cannot host solvers. If you design a “Live” view, it is for a coordinator host (Railway/Fly), not Vercel.
3. **The LLM never names addresses.** Specs talk in tickers (`TSLAx`), decimal amounts, and percents. A hallucinated ticker fails catalog resolution. Show that safety: “compiled against catalog”, hashes, “floors open until quoted”.
4. **Preview auction ≠ settlement.** A client-side preview may *illustrate* conservative declining and aggressive winning. Always caption it as a preview against the demo venue book. Real numbers come from `npm run demo`.
5. **xStocks on the playground are stand-ins.** Real mainnet addresses are intentionally `null` in `contracts/config/assets.ts`. Do not invent contract addresses in the UI.
6. **Assets in the preview universe:** USDT (6 dp), TSLAx, NVDAx, AAPLx, SPYx, GOOGLx (18 dp). All xStocks are RWA-attested in the demo.
7. **Venues:** `OKX-DEX-sim` (30 bps) and `XSwap-sim` (20 bps), with different depth/skew so routing is a real choice.
8. **Solvers:** `aggressive` (8 bps, tight guarantees), `conservative` (15 bps, more headroom). Conservative often *declines* a tight four-leg basket. Show the decline. It is the point.

---

## 5. Screens to design

Design **one product**, four views, dark, dense, institutional. Not a marketing landing with a tiny demo tucked underneath — the composer *is* the product.

### View A — Compose (default, 70% of the demo)

**Purpose:** Turn a sentence into a committed intent the visitor can *see*.

**Layout (desktop, 1080–1280px content width):**

- Top bar: mark + “IntentOS” + subtitle “Intent OS for X Layer”. Right: network chip `X Layer · playground · grammar` and GitHub.
- Hero line (one sentence, max 2 lines).
- Composer: large textarea, primary button **Parse into an intent**, secondary **Preview solver auction**. Example chips under the field.
- After parse, two columns:
  - **Left (wider):** “What would be committed” — plain-language explanation + basket table/bars (asset, weight, floor). Exits in red if rebalance.
  - **Right:** Guardrail chips, then outcome hash + policy hash, then a 4-step loop with step 1 lit.
- Below both columns, once auction is previewed: solver cards + optional settlement delta table.

**Example prompts (pre-fill chips):**

- Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight, max 0.5% slippage, only attested assets, fees under 0.25%
- Swap 2,500 USDT into NVDA with 0.3% max slippage
- Rebalance: sell 3 TSLA and 4 NVDA, then buy AAPL and SPY equally
- put 20,000 USDT into NVDA and AAPL, 60/40, only attested assets
- every week put 1,000 USDT into SPY, only if SPY is below 700
- Bring 25,000 USDT onchain into SPY xStock, fees under 0.2%

**Basket visualization:** horizontal weight bars, not a 3D pie. Percent + floor per leg. If floors are `"0"`, label **open** and explain they bind from the winning bid onchain.

**Guardrail chips (committed, not advisory):**

- `fee ≤ 0.25%`
- `slippage ≤ 0.50%`
- `RWA attested` (green when on)
- `pinned to TSLAx, NVDAx, …`
- `solver reputation ≥ n%`
- `45s auction`

**Hashes:** monospace, full hex, labelled `outcome hash` / `policy hash`. Caption: “Only these hashes go onchain. A reveal that does not hash to this is rejected.”

**Auction preview (the judge moment):**

- Two solver rows/cards.
- Conservative: status `declined`, reason in muted mono (“leg 3 cannot be guaranteed above the user’s floor”).
- Aggressive: status `bid`, fee, confidence, eta, per-leg venue + guarantee.
- Selected winner chip.
- Settlement table: asset / before / after / change. Caption that this is a preview.

### View B — Loop (architecture)

A four-stage horizontal flow, not a blob diagram:

1. Declare — sentence → IntentSpec → compiled draft  
2. Commit — `IntentRegistry` stores hashes  
3. Auction — solvers bid guarantees; coordinator may be slashed  
4. Settle — `IntentSettlement` sizes, executes, measures, verifies  

Each stage: title, one-sentence job, the contract or package that owns it, what is *not* trusted.

Include a small “AI, specifically” callout:

- Parsing = structured spec, never addresses.
- Solving = competitive quoting, strategies differ in how much of the quote they will be bound to.

### View C — Network

Two panels.

**Solver network:** name, reputation bar (bps/100 as %), fulfilled/failed, fee style, one-line strategy. Seeded reputation is 50%.

**RWA catalog:** symbol, name, ISIN/`assetRef`, class (equity/etf/cash), attestation state. Attested = live. This is the xStocks specialization — make it feel like tokenized equities, not generic ERC-20s.

**Venues:** OKX-DEX-sim, XSwap-sim, fee.

### View D — Agents

Short pitch: agents are the primary user. They declare and they can also solve.

Show a real SDK snippet (do not invent an API):

```ts
import { IntentAgent, IntentOSClient } from "@intentos/sdk";

const agent = new IntentAgent(client);
const { intentId, explanation } = await agent.declare(
  "put 5,000 USDT into NVDA and AAPL, 60/40, only attested assets"
);
await agent.track(intentId);
```

Notes: clarifications hold the intent (nothing is signed). Recurrence is offchain v0.1 — the agent runtime submits once per period.

---

## 6. Visual system

**Mood:** a precise instrument. Dark terminal meeting a trading desk. Quiet confidence. No gradients-on-gradients, no glassmorphism stacks, no mascot, no “Web3” purple.

**Color (keep these tokens — they are already in the product):**

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0b0d10` | page |
| `--panel` | `#12161b` | cards |
| `--line` | `#1e252d` | borders |
| `--ink` | `#e6edf3` | text |
| `--muted` | `#8b98a5` | labels |
| `--accent` | `#4da3ff` | primary actions, live step |
| `--good` | `#3fb950` | attested, fulfilled, winner |
| `--warn` | `#d29922` | selected / bidding |
| `--bad` | `#f85149` | declined, exits, errors |

**Type:** system sans for prose (`-apple-system, Segoe UI, Inter`). `ui-monospace` for hashes, amounts, addresses, chips, status. Tabular numbers for weights and fills.

**Radius:** 8–11px panels, 999px pills. Not 24px squishy cards.

**Density:** information-dense. Judges should not scroll past two viewports to see the basket. Mobile: single column, chips wrap, hashes wrap, auction cards stack.

**Motion:** 200–300ms. Auction preview may stagger solver cards. No looping background animations.

**Mark:** a compact “I” ligature already used as an SVG favicon — dark rounded square, accent glyph. Do not replace with a generic robot.

**Do not:** connect-wallet button on the Vercel playground, token-price tickers as a hero, NFT art, 3D coins, “Powered by AI” sparkle, fake TVL.

---

## 7. Microcopy tone

Write like the README: short, specific, slightly stern. Prefer “what would be committed” over “your portfolio”. Prefer “declined” over “failed to find a route”. Prefer “preview” over “simulation” if you need a noun — and then immediately say why.

Good:

> Only these hashes go onchain. The outcome is revealed at settlement, and any reveal that does not hash to this is rejected.

Bad:

> ✨ AI is crafting your personalized DeFi journey.

Error states are first-class. Unknown ticker: show the catalog. Grammar miss: show the message, keep the prompt.

---

## 8. Data the frontend already exposes

`window.IntentOS` after `app.js` loads:

```ts
parse(prompt: string) => ParsedView
previewAuction(parsed: ParsedView) => AuctionPreview
assets: { symbol, kind, name, assetRef, attested, class, usdPrice }[]
solvers: { name, reputationBps, fulfilled, failed, feeBps, style }[]
venues: { name, feeBps }[]
```

`ParsedView` includes explanation, spec, assumptions, clarifications, outcome (kind, legs, exits, slippage), policy (fee, reputation, RWA, allowlist), timing, and `commitment.outcomeHash` / `policyHash`.

Implement against this API. Do not add a backend to `apps/web`.

Live coordinator (optional, separate host) speaks:

- `GET /api/deployment`
- `POST /api/parse` `{ prompt, recipient }`
- `GET /api/intents`
- `GET /api/solvers`
- `GET /api/rwa`

Amounts on the wire from the API are tagged `n:<bigint>`.

---

## 9. Files to change

| File | Role |
|---|---|
| `apps/web/public/index.html` | The product UI (HTML/CSS/JS). This is the design surface. |
| `apps/web/src/browser.ts` | Parser bridge. Do not restyle here. |
| `apps/web/src/auction.ts` | Preview math. Do not restyle here. |
| `apps/api/public/index.html` | Operator dashboard (live mempool). Secondary. Same tokens. |
| `apps/web/vercel.json` + root `vercel.json` | Static deploy. Root directory of the *repo* is fine; build is `npm run build -w @intentos/web`, output `apps/web/public`. |

Deliver HTML/CSS that drops into `apps/web/public/index.html` and talks to `window.IntentOS`. Keep a single page with hash routes (`#compose` `#loop` `#network` `#agents`) so Vercel stays static.

---

## 10. Success for the hackathon demo

A judge opens the Vercel URL and in one minute can:

1. See the four-asset xStocks sentence already in the composer.
2. Hit parse and read a committed basket with weights, open floors, RWA chip, and two hashes.
3. Hit preview auction and watch conservative decline + aggressive win.
4. Understand this is X Layer, single-chain, agent-native, RWA-specialized.

If the visual system fights any of those four beats, change the visuals, not the beats.
