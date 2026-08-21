import { ethers, network } from "hardhat";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_ASSET, ETF_SYMBOLS, VENUES, XSTOCKS } from "../config/assets";
import { XLAYER_MAINNET } from "../config/mainnet";
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
  const mainnet = chainId === 196;

  let treasury: Signer = signers[1] ?? deployer;
  let coordinator: Signer = signers[2] ?? deployer;
  let solverA: Signer | undefined = signers[3];
  let solverB: Signer | undefined = signers[4];
  let solverC: Signer | undefined = signers[5];
  let solverD: Signer | undefined = signers[6];
  const derivedKeys: Record<string, string> = {};

  if ((testnet || mainnet) && seedKey && signers.length < 3) {
    coordinator = deriveWallet(seedKey, "coordinator");
    solverA = deriveWallet(seedKey, "solver-a");
    solverB = deriveWallet(seedKey, "solver-b");
    solverC = deriveWallet(seedKey, "solver-c");
    solverD = deriveWallet(seedKey, "solver-d");
    treasury = deployer;
    derivedKeys.COORDINATOR_PRIVATE_KEY = (coordinator as Wallet).privateKey;
    derivedKeys.SOLVER_A_PRIVATE_KEY = (solverA as Wallet).privateKey;
    derivedKeys.SOLVER_B_PRIVATE_KEY = (solverB as Wallet).privateKey;
    derivedKeys.SOLVER_C_PRIVATE_KEY = (solverC as Wallet).privateKey;
    derivedKeys.SOLVER_D_PRIVATE_KEY = (solverD as Wallet).privateKey;

    const gasDrop = mainnet ? ethers.parseEther("0.002") : ethers.parseEther("0.008");
    for (const wallet of [coordinator, solverA, solverB, solverC, solverD]) {
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
  const minBond = testnet ? ethers.parseEther("0.0001") : ethers.parseEther("0.001");
  const auctioneerBond = testnet ? ethers.parseEther("0.0005") : ethers.parseEther("0.002");

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
  await (await settlement.setRwaRegistry(await rwaRegistry.getAddress())).wait();

  const tokens: Record<string, string> = {};
  const routers: { name: string; address: string }[] = [];
  const reviewBy = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

  if (mainnet) {
    tokens.USDT = XLAYER_MAINNET.tokens.USDT;
    tokens.USDG = XLAYER_MAINNET.tokens.USDG;
    tokens.TSLAx = XLAYER_MAINNET.tokens.TSLAx;
    tokens.WOKB = XLAYER_MAINNET.wokb;
    await (
      await rwaRegistry.attest(
        tokens.TSLAx,
        1,
        "TSLAx",
        "ISIN:CH1436219252",
        "https://app.rwa.xyz/assets/TSLAx",
        reviewBy,
      )
    ).wait();
    await (await settlement.setRouterAllowed(XLAYER_MAINNET.uniswapV2Router, true)).wait();
    routers.push({ name: "Uniswap-V2", address: XLAYER_MAINNET.uniswapV2Router });
    const adapter = await (await ethers.getContractFactory("V3RouterAdapter")).deploy(
      XLAYER_MAINNET.uniswapV3.swapRouter02,
      XLAYER_MAINNET.uniswapV3.quoterV2,
    );
    await adapter.waitForDeployment();
    const adapterAddress = await adapter.getAddress();
    await (await settlement.setRouterAllowed(adapterAddress, true)).wait();
    routers.push({ name: "Uniswap-V3", address: adapterAddress });
    console.log(`mainnet tokens USDT/USDG/TSLAx attested TSLAx`);
    console.log(`v3 adapter ${adapterAddress}`);
  } else {
    const erc20 = await ethers.getContractFactory("MockERC20");
    const usdt = await erc20.deploy(BASE_ASSET.name, BASE_ASSET.symbol, BASE_ASSET.decimals);
    await usdt.waitForDeployment();
    const usdg = await erc20.deploy("Global Dollar", "USDG", 6);
    await usdg.waitForDeployment();
    tokens.USDT = await usdt.getAddress();
    tokens.USDG = await usdg.getAddress();
    for (const asset of XSTOCKS) {
      const t = await erc20.deploy(asset.name, asset.symbol, asset.decimals);
      await t.waitForDeployment();
      tokens[asset.symbol] = await t.getAddress();
      await (
        await rwaRegistry.attest(
          tokens[asset.symbol]!,
          ETF_SYMBOLS.has(asset.symbol) ? 2 : 1,
          asset.symbol,
          asset.assetRef,
          `https://intentos.xyz/rwa/${asset.symbol}.json`,
          reviewBy,
        )
      ).wait();
    }
    const routerFactory = await ethers.getContractFactory("MockDexRouter");
    for (const venue of VENUES) {
      const router = await routerFactory.deploy(venue.name, venue.feeBps);
      await router.waitForDeployment();
      const routerAddress = await router.getAddress();
      for (const asset of XSTOCKS) {
        const priceE18 = usdtToAssetPriceE18(asset.usdPrice, venue.priceSkewBps[asset.symbol] ?? 0);
        const depth = BigInt(Math.round(5_000 * (venue.depthMultiplier[asset.symbol] ?? 1))) * 10n ** 6n;
        await (await router.setPrice(tokens.USDT!, tokens[asset.symbol]!, priceE18, depth)).wait();
        const stock = await ethers.getContractAt("MockERC20", tokens[asset.symbol]!);
        await (await stock.mint(routerAddress, ethers.parseUnits("250000", asset.decimals))).wait();
      }
      await (await usdt.mint(routerAddress, ethers.parseUnits("50000000", BASE_ASSET.decimals))).wait();
      await (await router.setPrice(tokens.USDT!, tokens.USDG!, WAD, ethers.parseUnits("50000", 6))).wait();
      await (await usdg.mint(routerAddress, ethers.parseUnits("50000000", 6))).wait();
      await (await settlement.setRouterAllowed(routerAddress, true)).wait();
      routers.push({ name: venue.name, address: routerAddress });
    }
  }

  const recurring = await (await ethers.getContractFactory("RecurringRegistry")).deploy(deployer.address);
  await recurring.waitForDeployment();
  await (await recurring.setCoordinator(await coordinator.getAddress())).wait();

  const tslaVault = await (await ethers.getContractFactory("RwaVault")).deploy(
    deployer.address,
    tokens.TSLAx!,
    await rwaRegistry.getAddress(),
    "IntentOS TSLAx Vault",
    "vTSLAx",
  );
  await tslaVault.waitForDeployment();

  if (!mainnet) {
    const usdt = await ethers.getContractAt("MockERC20", tokens.USDT!);
    const usdg = await ethers.getContractAt("MockERC20", tokens.USDG!);
    const funded = [deployer, coordinator, solverA, solverB, solverC, solverD].filter(Boolean) as Signer[];
    for (const signer of funded) {
      await (await usdt.mint(await signer.getAddress(), ethers.parseUnits("1000000", BASE_ASSET.decimals))).wait();
      await (await usdg.mint(await signer.getAddress(), ethers.parseUnits("1000000", 6))).wait();
      await (await (await ethers.getContractAt("MockERC20", tokens.TSLAx!)).mint(
        await signer.getAddress(),
        ethers.parseUnits("1000", 18),
      )).wait();
    }
  }

  if (solverA && solverB) {
    // Bond above the floor so a missed-guarantee slash (10%) does not auto-eject the solver.
    const bond = minBond * 10n;
    const roster: [Signer, string][] = [
      [solverA, "aggressive"],
      [solverB, "conservative"],
    ];
    if (solverC) roster.push([solverC, "rwa"]);
    if (solverD) roster.push([solverD, "payroll"]);
    for (const [solver, name] of roster) {
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
    if (solverC) {
      await (await solverRegistry.attestCapabilities(
        await solverC.getAddress(),
        capRwa | capAgent | capGasless,
      )).wait();
    }
    if (solverD) {
      await (await solverRegistry.attestCapabilities(
        await solverD.getAddress(),
        capStable | capGasless,
      )).wait();
    }
    console.log("solver A: AI + RWA + stable + gasless");
    console.log("solver B: KYB + RWA + stable + agent + gasless");
    if (solverC) console.log("solver C: RWA desk");
    if (solverD) console.log("solver D: payroll / payments");
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
      recurringRegistry: await recurring.getAddress(),
      tslaVault: await tslaVault.getAddress(),
    },
    roles: {
      treasury: await treasury.getAddress(),
      coordinator: await coordinator.getAddress(),
      solverA: solverA ? await solverA.getAddress() : undefined,
      solverB: solverB ? await solverB.getAddress() : undefined,
      solverC: solverC ? await solverC.getAddress() : undefined,
      solverD: solverD ? await solverD.getAddress() : undefined,
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
