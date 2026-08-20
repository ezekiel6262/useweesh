import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

export const BPS = 10_000n;
export const WAD = 10n ** 18n;

export const USDT_DECIMALS = 6;
export const usdt = (whole: string | number) => ethers.parseUnits(String(whole), USDT_DECIMALS);
export const shares = (whole: string | number) => ethers.parseUnits(String(whole), 18);

/** priceE18 for USDT -> asset priced at `usdPrice` dollars a share. */
export const priceOf = (usdPrice: number) => (WAD * 1_000_000n) / BigInt(Math.round(usdPrice * 1_000_000));

export const DEMO_STOCKS = [
  { symbol: "TSLAx", usd: 330 },
  { symbol: "NVDAx", usd: 180 },
  { symbol: "AAPLx", usd: 230 },
  { symbol: "SPYx", usd: 640 },
];

/**
 * A complete IntentOS deployment with two priced venues, four xStocks, two bonded solvers and
 * a funded user. Deliberately close to what scripts/deploy.ts produces, so the tests exercise
 * the same wiring the demo runs on.
 */
export async function deployIntentOS() {
  const [deployer, treasury, coordinator, user, solverA, solverB, challenger] = await ethers.getSigners();

  const solverRegistry = await (await ethers.getContractFactory("SolverRegistry"))
    .deploy(deployer.address, ethers.parseEther("0.01"));
  const rwaRegistry = await (await ethers.getContractFactory("RWARegistry")).deploy(deployer.address);
  const policyEngine = await (await ethers.getContractFactory("PolicyEngine"))
    .deploy(await solverRegistry.getAddress(), await rwaRegistry.getAddress());
  const intentRegistry = await (await ethers.getContractFactory("IntentRegistry"))
    .deploy(deployer.address, await solverRegistry.getAddress());
  const settlement = await (await ethers.getContractFactory("IntentSettlement")).deploy(
    deployer.address,
    await intentRegistry.getAddress(),
    await policyEngine.getAddress(),
    treasury.address,
  );

  await intentRegistry.setSettlement(await settlement.getAddress());
  await intentRegistry.setAuctioneer(coordinator.address);
  await intentRegistry.fundAuctioneerBond({ value: ethers.parseEther("1") });
  await solverRegistry.setReporter(await intentRegistry.getAddress(), true);
  await rwaRegistry.setAttestor(deployer.address, true);

  const erc20 = await ethers.getContractFactory("MockERC20");
  const base = await erc20.deploy("Tether USD", "USDT", USDT_DECIMALS);
  const stocks: Record<string, any> = {};
  for (const stock of DEMO_STOCKS) {
    stocks[stock.symbol] = await erc20.deploy(`${stock.symbol} xStock`, stock.symbol, 18);
    await rwaRegistry.attest(
      await stocks[stock.symbol].getAddress(),
      1, // EQUITY
      stock.symbol,
      `ISIN:TEST${stock.symbol}`,
      `https://intentos.xyz/rwa/${stock.symbol}.json`,
      (await time.latest()) + 365 * 24 * 3600,
    );
  }

  const routerFactory = await ethers.getContractFactory("MockDexRouter");
  // Two venues that disagree: A is cheaper on TSLA/NVDA, B on AAPL/SPY.
  const routerA = await routerFactory.deploy("OKX-DEX-sim", 30);
  const routerB = await routerFactory.deploy("XSwap-sim", 20);
  const skewA: Record<string, number> = { TSLAx: -10, NVDAx: -10, AAPLx: 10, SPYx: 10 };
  const skewB: Record<string, number> = { TSLAx: 10, NVDAx: 10, AAPLx: -10, SPYx: -10 };

  for (const router of [routerA, routerB]) {
    const skew = router === routerA ? skewA : skewB;
    for (const stock of DEMO_STOCKS) {
      const token = stocks[stock.symbol];
      const price = (priceOf(stock.usd) * BigInt(10_000 + skew[stock.symbol]!)) / BPS;
      await router.setPrice(await base.getAddress(), await token.getAddress(), price, usdt(5_000));
      await token.mint(await router.getAddress(), shares(500_000));
    }
    await base.mint(await router.getAddress(), usdt(100_000_000));
    await settlement.setRouterAllowed(await router.getAddress(), true);
  }

  await base.mint(user.address, usdt(1_000_000));
  await base.connect(user).approve(await settlement.getAddress(), ethers.MaxUint256);
  for (const stock of DEMO_STOCKS) {
    await stocks[stock.symbol].mint(user.address, shares(1_000));
    await stocks[stock.symbol].connect(user).approve(await settlement.getAddress(), ethers.MaxUint256);
  }

  await solverRegistry.connect(solverA).register("ipfs://solver-a", { value: ethers.parseEther("1") });
  await solverRegistry.connect(solverB).register("ipfs://solver-b", { value: ethers.parseEther("1") });

  return {
    signers: { deployer, treasury, coordinator, user, solverA, solverB, challenger },
    solverRegistry,
    rwaRegistry,
    policyEngine,
    intentRegistry,
    settlement,
    base,
    stocks,
    routers: { routerA, routerB },
    addresses: {
      base: await base.getAddress(),
      settlement: await settlement.getAddress(),
      intentRegistry: await intentRegistry.getAddress(),
      routerA: await routerA.getAddress(),
      routerB: await routerB.getAddress(),
    },
  };
}

export type IntentOS = Awaited<ReturnType<typeof deployIntentOS>>;

export const ZERO_POLICY = {
  maxNotional: 0n,
  validAfter: 0n,
  validUntil: 0n,
  maxFeeBps: 50,
  minReputationBps: 0,
  requireRwaAttested: false,
  tokenAllowlist: [] as string[],
};

/** Submit an intent and return its id, mirroring what the SDK does offchain. */
export async function submitIntent(
  env: IntentOS,
  signer: any,
  outcome: any,
  policy: any = ZERO_POLICY,
  opts: { auctionSeconds?: number; ttlSeconds?: number; salt?: string } = {},
) {
  const now = await time.latest();
  const auctionEndsAt = now + (opts.auctionSeconds ?? 20);
  const deadline = now + (opts.ttlSeconds ?? 3_600);
  const salt = opts.salt ?? ethers.hexlify(ethers.randomBytes(32));

  const outcomeHash = await env.intentRegistry.hashOutcome(outcome);
  const policyHash = await env.intentRegistry.hashPolicy(policy);
  const intentId = await env.intentRegistry.computeIntentId(
    signer.address,
    outcomeHash,
    policyHash,
    salt,
    auctionEndsAt,
    deadline,
  );

  await env.intentRegistry
    .connect(signer)
    .submit(salt, outcome.kind, outcomeHash, policyHash, outcome.legs.length, auctionEndsAt, deadline, "");

  return { intentId, auctionEndsAt, deadline, outcomeHash, policyHash, salt };
}

export function route(router: string, path: string[]) {
  return { router, path };
}
