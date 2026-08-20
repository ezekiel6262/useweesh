# Running on X Layer

X Layer is OKX's zkEVM L2. Gas is paid in OKB.

| | Chain ID | RPC | Explorer |
|---|---|---|---|
| Mainnet | 196 | `https://rpc.xlayer.tech` | `https://www.oklink.com/x-layer` |
| Testnet | 1952 | `https://testrpc.xlayer.tech` | `https://web3.okx.com/explorer/xlayer-testnet` |

Both are defined in `packages/sdk/src/chain.ts`; the local Hardhat node (31337) stands in for
development.

## Deploying to testnet

```bash
cp .env.example .env         # set PRIVATE_KEY, and XLAYER_TESTNET_RPC if you use your own node
npm run build -w @intentos/contracts
npm run deploy:testnet -w @intentos/contracts
```

This writes `deployments/xlayerTestnet.json`, which every tool reads. Point the rest of the stack
at it with `INTENTOS_NETWORK=xlayerTestnet`:

```bash
INTENTOS_NETWORK=xlayerTestnet COORDINATOR_PRIVATE_KEY=0x… npm run dashboard
INTENTOS_NETWORK=xlayerTestnet SOLVER_KEYS=0x…,0x… npm run solvers
INTENTOS_NETWORK=xlayerTestnet AGENT_PRIVATE_KEY=0x… npm run agent -- "…"
```

The deploy script also mints stand-in USDT and xStocks and seeds two demo venues, because the real
tokenized equities are not deployed on testnet. That is fine for testnet and **wrong for
mainnet** — see below.

## Going to mainnet

Three things must change, and none of them should be guessed.

**1. Real asset addresses.** `contracts/config/assets.ts` carries `mainnet: null` for every asset
on purpose. Fill each one from the issuer's own documentation, then have the deploy script use
those addresses instead of minting mocks. An address that is wrong by one character is an address
that belongs to someone else.

**2. Real routers.** `IntentSettlement.setRouterAllowed` gates which venues a solver may call, and
it is the difference between "the solver picked a bad price" and "the solver called a contract
that took the money". Allowlist the X Layer DEX routers you have actually checked — the interface
IntentOS uses is the UniswapV2-style `swapExactTokensForTokens` / `getAmountsOut` pair that the
major venues expose.

**3. Real attestors.** `RWARegistry.setAttestor` decides whose word counts for
`requireRwaAttested`. On testnet the deployer attests everything, which is meaningless. On
mainnet this should be the issuer, its transfer agent, or an oracle acting for one — and the
`reviewBy` date should be short enough that a stale attestation lapses on its own.

Also worth setting before any real value moves: `SolverRegistry.setMinBond` to something a solver
would mind losing, and `IntentRegistry.fundAuctioneerBond` to more than a coordinator would gain
by picking a friendly solver.

## Cost

The whole design leans on X Layer being cheap: a four-leg basket is four swaps, a rebalance is
exits plus entries, all in one transaction. On an L1 the per-leg gas would push users back toward
single swaps, which is exactly what intents are meant to get away from. Solvers model gas per leg
in base-asset units (`SolverStrategy.gasPerLegBase`) — on X Layer that term is small enough that
routing quality dominates, which is the regime this optimiser is tuned for.

## Verifying contracts

Hardhat's verify plugin is installed. Point it at OKLink's API for X Layer, then:

```bash
npx hardhat verify --network xlayerTestnet <address> <constructor args…>
```
