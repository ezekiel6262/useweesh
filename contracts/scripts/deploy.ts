import { ethers, network } from "hardhat";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ASSET, ETF_SYMBOLS, VENUES, XSTOCKS } from "../config/assets";
import { keccak256, toUtf8Bytes, Wallet, type Signer } from "ethers";

const WAD = 10n ** 18n;
const BPS = 10_000n;

/** priceE18 for USDT -> asset: how many whole assets one whole USDT buys. */
function usdtToAssetPriceE18(usdPrice: number, skewBps: number): bigint {
  const price = (WAD * 1_000_000n) / BigInt(Math.round(usdPrice * 1_000_000));
  return (price * (BPS + BigInt(skewBps))) / BPS;
}

function deriveWallet(seedKey: string, label: string): Wallet {
  const material = keccak256(toUtf8Bytes(`intentos.role.${label}:${seedKey}`));
  return new Wallet(material, ethers.provider);
}

function upsertEnv(path: string, updates: Record<string, string>): void {
  let existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    existing = pattern.test(existing) ? existing.replace(pattern, line) : `${existing.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, existing.startsWith("\n") ? existing.slice(1) : existing);
}

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) throw new Error("no deployer signer — set PRIVATE_KEY");

  const seedKey = process.env.PRIVATE_KEY;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const testnet = chainId === 1952 || chainId === 195;

  let treasury: Signer = signers[1] ?? deployer;
  let coordinator: Signer = signers[2] ?? deployer;
  let solverA: Signer | undefined = signers[3];
  let solverB: Signer | undefined = signers[4];
  const derivedKeys: Record<string, string> = {};

  if (testnet && seedKey && signers.length < 3) {
    coordinator = deriveWallet(seedKey, "coordinator");
    solverA = deriveWallet(seedKey, "solver-a");
    solverB = deriveWallet(seedKey, "solver-b");
    treasury = deployer;
    derivedKeys.COORDINATOR_PRIVATE_KEY = (coordinator as Wallet).privateKey;
    derivedKeys.SOLVER_A_PRIVATE_KEY = (solverA as Wallet).privateKey;
    derivedKeys.SOLVER_B_PRIVATE_KEY = (solverB as Wallet).privateKey;

    const gasDrop = ethers.parseEther("0.002");
    for (const wallet of [coordinator, solverA, solverB]) {
      const addr = await wallet.getAddress();
      const bal = await ethers.provider.getBalance(addr);
      if (bal < gasDrop / 2n) {
        const tx = await deployer.sendTransaction({ to: addr, value: gasDrop });
        await tx.wait();
      }
    }
  }

  if (!treasury || !coordinator) throw new Error("need a treasury and a coordinator");

  console.log(`\nIntentOS deploy -> ${network.name} (chainId ${chainId})`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`coordinator  ${await coordinator.getAddress()}`);

  // ---------------------------------------------------------------- core stack
  const minBond = testnet ? ethers.parseEther("0.0001") : ethers.parseEther("0.01");
  const auctioneerBond = testnet ? ethers.parseEther("0.0005") : ethers.parseEther("1");

  const solverRegistry = await (await ethers.getContractFactory("SolverRegistry"))
    .deploy(deployer.address, minBond);
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
    await treasury.getAddress(),
  );
  await settlement.waitForDeployment();

  // ------------------------------------------------------------------- wiring
  await (await intentRegistry.setSettlement(await settlement.getAddress())).wait();
  await (await intentRegistry.setAuctioneer(await coordinator.getAddress())).wait();
  await (await intentRegistry.connect(coordinator).fundAuctioneerBond({ value: auctioneerBond })).wait();
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
      // Depth in USDT base units: this much notional costs one bp of price impact. 5,000 USDT
      // per bp puts a 10,000 USDT leg at ~2 bps, which is the right order for X Layer liquidity.
      const depth = BigInt(Math.round(5_000 * (venue.depthMultiplier[asset.symbol] ?? 1))) * 10n ** 6n;
      await (await router.setPrice(tokens.USDT!, tokens[asset.symbol]!, priceE18, depth)).wait();

      // Seed both sides of the book.
      const stock = await ethers.getContractAt("MockERC20", tokens[asset.symbol]!);
      await (await stock.mint(routerAddress, ethers.parseUnits("250000", asset.decimals))).wait();
    }
    await (await usdt.mint(routerAddress, ethers.parseUnits("50000000", BASE_ASSET.decimals))).wait();
    await (await settlement.setRouterAllowed(routerAddress, true)).wait();
    routers.push({ name: venue.name, address: routerAddress });
  }

  // Fund operator accounts so solvers and the dashboard have something to spend.
  const funded = [deployer, coordinator, solverA, solverB].filter(Boolean) as Signer[];
  for (const signer of funded) {
    await (await usdt.mint(await signer.getAddress(), ethers.parseUnits("1000000", BASE_ASSET.decimals))).wait();
  }

  if (solverA && solverB) {
    const bond = minBond;
    for (const [solver, name] of [
      [solverA, "aggressive"],
      [solverB, "conservative"],
    ] as const) {
      const registry = solverRegistry.connect(solver);
      await (await registry.register(`intentos://solver/${name}`, { value: bond })).wait();
      console.log(`registered ${name} solver ${await solver.getAddress()}`);
    }
    const capAi = await solverRegistry.CAP_AI();
    const capCompliant = await solverRegistry.CAP_COMPLIANT();
    const capRwa = await solverRegistry.CAP_RWA();
    const capStable = await solverRegistry.CAP_STABLE();
    const capAgent = await solverRegistry.CAP_AGENT();
    const capGasless = await solverRegistry.CAP_GASLESS();
    await (await solverRegistry.attestCapabilities(
      await solverA.getAddress(),
      capAi | capRwa | capStable | capGasless,
    )).wait();
    await (await solverRegistry.attestCapabilities(
      await solverB.getAddress(),
      capCompliant | capRwa | capStable | capAgent | capGasless,
    )).wait();
    await (await solverRegistry.attestKyb(await solverB.getAddress(), true)).wait();
    console.log("solver A: AI + RWA + stable + gasless");
    console.log("solver B: KYB + RWA + stable + agent + gasless");
  }

  const deployment = {
    network: network.name,
    chainId,
    deployedAt: new Date().toISOString(),
    contracts: {
      solverRegistry: await solverRegistry.getAddress(),
      rwaRegistry: await rwaRegistry.getAddress(),
      policyEngine: await policyEngine.getAddress(),
      intentRegistry: await intentRegistry.getAddress(),
      settlement: await settlement.getAddress(),
    },
    roles: {
      treasury: await treasury.getAddress(),
      coordinator: await coordinator.getAddress(),
      solverA: solverA ? await solverA.getAddress() : undefined,
      solverB: solverB ? await solverB.getAddress() : undefined,
    },
    tokens,
    routers,
  };

  const dir = join(__dirname, "..", "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${network.name}.json`);
  writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");

  if (Object.keys(derivedKeys).length > 0) {
    const envPath = join(__dirname, "..", "..", ".env");
    upsertEnv(envPath, {
      INTENTOS_NETWORK: "xlayerTestnet",
      INTENTOS_RPC: process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech",
      ...derivedKeys,
    });
    console.log(`wrote operator keys to ${envPath} (gitignored)`);
  }

  console.log(JSON.stringify(deployment.contracts, null, 2));
  console.log(`\nwrote ${file}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
