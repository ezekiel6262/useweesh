import { ethers, network } from "hardhat";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ASSET, ETF_SYMBOLS, VENUES, XSTOCKS } from "../config/assets";

const WAD = 10n ** 18n;
const BPS = 10_000n;

/** priceE18 for USDT -> asset: how many whole assets one whole USDT buys. */
function usdtToAssetPriceE18(usdPrice: number, skewBps: number): bigint {
  const price = (WAD * 1_000_000n) / BigInt(Math.round(usdPrice * 1_000_000));
  return (price * (BPS + BigInt(skewBps))) / BPS;
}

async function main() {
  const [deployer, treasury, coordinator] = await ethers.getSigners();
  if (!treasury || !coordinator) throw new Error("need at least 3 signers");
  console.log(`\nIntentOS deploy -> ${network.name} (chainId ${network.config.chainId ?? "?"})`);
  console.log(`deployer    ${deployer.address}`);

  // ---------------------------------------------------------------- core stack
  const solverRegistry = await (await ethers.getContractFactory("SolverRegistry"))
    .deploy(deployer.address, ethers.parseEther("0.01"));
  await solverRegistry.waitForDeployment();

  const rwaRegistry = await (await ethers.getContractFactory("RWARegistry")).deploy(deployer.address);
  await rwaRegistry.waitForDeployment();

  const policyEngine = await (await ethers.getContractFactory("PolicyEngine"))
    .deploy(await solverRegistry.getAddress(), await rwaRegistry.getAddress());
  await policyEngine.waitForDeployment();

  const intentRegistry = await (await ethers.getContractFactory("IntentRegistry"))
    .deploy(deployer.address, await solverRegistry.getAddress());
  await intentRegistry.waitForDeployment();

  const settlement = await (await ethers.getContractFactory("IntentSettlement")).deploy(
    deployer.address,
    await intentRegistry.getAddress(),
    await policyEngine.getAddress(),
    treasury.address,
  );
  await settlement.waitForDeployment();

  // ------------------------------------------------------------------- wiring
  await (await intentRegistry.setSettlement(await settlement.getAddress())).wait();
  await (await intentRegistry.setAuctioneer(coordinator.address)).wait();
  await (await intentRegistry.fundAuctioneerBond({ value: ethers.parseEther("1") })).wait();
  await (await solverRegistry.setReporter(await intentRegistry.getAddress(), true)).wait();
  await (await rwaRegistry.setAttestor(deployer.address, true)).wait();

  // -------------------------------------------------------------- demo assets
  const erc20 = await ethers.getContractFactory("MockERC20");
  const usdt = await erc20.deploy(BASE_ASSET.name, BASE_ASSET.symbol, BASE_ASSET.decimals);
  await usdt.waitForDeployment();

  const tokens: Record<string, string> = { USDT: await usdt.getAddress() };
  for (const asset of XSTOCKS) {
    const t = await erc20.deploy(asset.name, asset.symbol, asset.decimals);
    await t.waitForDeployment();
    tokens[asset.symbol] = await t.getAddress();

    const reviewBy = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    await (
      await rwaRegistry.attest(
        tokens[asset.symbol]!,
        ETF_SYMBOLS.has(asset.symbol) ? 2 : 1, // AssetClass.ETF : AssetClass.EQUITY
        asset.symbol,
        asset.assetRef,
        `https://intentos.xyz/rwa/${asset.symbol}.json`,
        reviewBy,
      )
    ).wait();
  }

  // -------------------------------------------------------------- demo venues
  const routerFactory = await ethers.getContractFactory("MockDexRouter");
  const routers: { name: string; address: string }[] = [];
  for (const venue of VENUES) {
    const router = await routerFactory.deploy(venue.name, venue.feeBps);
    await router.waitForDeployment();
    const routerAddress = await router.getAddress();

    for (const asset of XSTOCKS) {
      const priceE18 = usdtToAssetPriceE18(asset.usdPrice, venue.priceSkewBps[asset.symbol] ?? 0);
      // Depth is quoted in USDT units: this much notional costs one bp of impact.
      const depth = BigInt(Math.round(500_000 * (venue.depthMultiplier[asset.symbol] ?? 1)));
      await (await router.setPrice(tokens.USDT!, tokens[asset.symbol]!, priceE18, depth)).wait();

      // Seed both sides of the book.
      const stock = await ethers.getContractAt("MockERC20", tokens[asset.symbol]!);
      await (await stock.mint(routerAddress, ethers.parseUnits("250000", asset.decimals))).wait();
    }
    await (await usdt.mint(routerAddress, ethers.parseUnits("50000000", BASE_ASSET.decimals))).wait();
    await (await settlement.setRouterAllowed(routerAddress, true)).wait();
    routers.push({ name: venue.name, address: routerAddress });
  }

  // Fund the first few signers so the demos and the dashboard have something to spend.
  for (const signer of (await ethers.getSigners()).slice(0, 6)) {
    await (await usdt.mint(signer.address, ethers.parseUnits("1000000", BASE_ASSET.decimals))).wait();
  }

  const deployment = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 0),
    deployedAt: new Date().toISOString(),
    contracts: {
      solverRegistry: await solverRegistry.getAddress(),
      rwaRegistry: await rwaRegistry.getAddress(),
      policyEngine: await policyEngine.getAddress(),
      intentRegistry: await intentRegistry.getAddress(),
      settlement: await settlement.getAddress(),
    },
    roles: { treasury: treasury.address, coordinator: coordinator.address },
    tokens,
    routers,
  };

  const dir = join(__dirname, "..", "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${network.name}.json`);
  writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");

  console.log(JSON.stringify(deployment.contracts, null, 2));
  console.log(`\nwrote ${file}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
