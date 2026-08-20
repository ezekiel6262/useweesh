import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { DEMO_STOCKS, ZERO_POLICY, deployIntentOS, route, shares, submitIntent, usdt } from "./fixtures";

/**
 * These tests pin the promises IntentOS makes to a user who declares an outcome:
 * the basket is bought at the weights they asked for, no leg lands below the floor they set,
 * the whole notional is deployed, and the solver cannot rewrite any of it at settlement.
 */
describe("IntentSettlement", () => {
  async function basketFixture() {
    const env = await deployIntentOS();
    const stocks = await Promise.all(
      DEMO_STOCKS.slice(0, 4).map(async (s) => ({ symbol: s.symbol, address: await env.stocks[s.symbol].getAddress() })),
    );
    return { env, stocks };
  }

  function basketOutcome(env: any, stocks: { address: string }[], amount: bigint, weights: number[]) {
    return {
      kind: 1, // BASKET
      inputToken: env.addresses.base,
      inputAmount: amount,
      recipient: env.signers.user.address,
      maxSlippageBps: 100,
      legs: stocks.map((s, i) => ({ token: s.address, weightBps: weights[i]!, minOut: 0n })),
      exits: [] as any[],
    };
  }

  it("buys a four-asset xStocks basket at the declared weights in one settlement", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const amount = usdt(10_000);
    const outcome = basketOutcome(env, stocks, amount, [4_000, 3_000, 2_000, 1_000]);

    const before: bigint[] = [];
    for (const s of stocks) {
      const token = await ethers.getContractAt("MockERC20", s.address);
      before.push(await token.balanceOf(env.signers.user.address));
    }

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    const guaranteed = stocks.map(() => 0n);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, guaranteed);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = stocks.map((s) => route(env.addresses.routerA, [env.addresses.base, s.address]));
    await env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []);

    // The user holds all four positions, and the value split follows the declared weights.
    const spendable = amount - (amount * 10n) / 10_000n;
    for (const [i, s] of stocks.entries()) {
      const token = await ethers.getContractAt("MockERC20", s.address);
      const acquired = (await token.balanceOf(env.signers.user.address)) - before[i]!;
      expect(acquired, `${s.symbol} position`).to.be.gt(0n);

      const expectedSpend = (spendable * BigInt(outcome.legs[i]!.weightBps)) / 10_000n;
      const quoted = await env.routers.routerA.getAmountsOut(expectedSpend, [env.addresses.base, s.address]);
      expect(acquired).to.equal(quoted[1]);
    }

    const record = await env.intentRegistry.getIntent(intentId);
    expect(record.status).to.equal(3); // FULFILLED
  });

  it("pays the solver and the treasury out of the success fee, and refunds nothing extra", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const amount = usdt(10_000);
    const outcome = basketOutcome(env, stocks.slice(0, 2), amount, [5_000, 5_000]);

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    const feeBps = 20n;
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, Number(feeBps), 30, ethers.ZeroHash, [0n, 0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = stocks.slice(0, 2).map((s) => route(env.addresses.routerA, [env.addresses.base, s.address]));
    await env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []);

    const fee = (amount * feeBps) / 10_000n;
    const protocolFee = (fee * 3_000n) / 10_000n;
    expect(await env.base.balanceOf(env.signers.treasury.address)).to.equal(protocolFee);
    expect(await env.base.balanceOf(env.signers.solverA.address)).to.equal(fee - protocolFee);
    // Nothing of the user's money is stranded in the settlement contract.
    expect(await env.base.balanceOf(env.addresses.settlement)).to.equal(0n);
  });

  it("reverts when a leg lands below the floor the user declared", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const amount = usdt(10_000);
    const outcome = basketOutcome(env, stocks.slice(0, 2), amount, [5_000, 5_000]);
    // Ask for more TSLAx than 5,000 USDT can possibly buy.
    outcome.legs[0]!.minOut = shares(100);

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n, 0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = stocks.slice(0, 2).map((s) => route(env.addresses.routerA, [env.addresses.base, s.address]));
    await expect(
      env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []),
    ).to.be.revertedWithCustomError(env.routers.routerA, "InsufficientOutput");
  });

  it("holds the solver to its own auction guarantee, not just the user's floor", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const amount = usdt(10_000);
    const outcome = basketOutcome(env, stocks.slice(0, 1), amount, [10_000]);
    outcome.kind = 0; // SWAP

    const { intentId } = await submitIntent(env, env.signers.user, outcome);

    // Quote the leg, then have the solver promise 20% more than the venue can deliver.
    const spendable = amount - (amount * 10n) / 10_000n;
    const quoted = await env.routers.routerA.getAmountsOut(spendable, [env.addresses.base, stocks[0]!.address]);
    const overpromised = (quoted[1]! * 12_000n) / 10_000n;

    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [overpromised]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = [route(env.addresses.routerA, [env.addresses.base, stocks[0]!.address])];
    await expect(
      env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []),
    ).to.be.revertedWithCustomError(env.routers.routerA, "InsufficientOutput");
  });

  it("rejects a reveal that does not match the committed outcome", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const amount = usdt(10_000);
    const outcome = basketOutcome(env, stocks.slice(0, 2), amount, [5_000, 5_000]);

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n, 0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    // A solver that would rather send the basket somewhere else.
    const tampered = { ...outcome, recipient: env.signers.solverA.address };
    const routes = stocks.slice(0, 2).map((s) => route(env.addresses.routerA, [env.addresses.base, s.address]));
    await expect(
      env.settlement.connect(env.signers.solverA).settle(intentId, tampered, ZERO_POLICY, routes, []),
    ).to.be.revertedWithCustomError(env.settlement, "OutcomeMismatch");
  });

  it("refuses routers that governance has not allowlisted", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const rogue = await (await ethers.getContractFactory("MockDexRouter")).deploy("rogue", 0);
    await rogue.setPrice(env.addresses.base, stocks[0]!.address, 1n, 0);

    const outcome = basketOutcome(env, stocks.slice(0, 1), usdt(1_000), [10_000]);
    outcome.kind = 0;
    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = [route(await rogue.getAddress(), [env.addresses.base, stocks[0]!.address])];
    await expect(
      env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []),
    ).to.be.revertedWithCustomError(env.settlement, "RouterNotAllowed");
  });

  it("only the winning solver may settle", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const outcome = basketOutcome(env, stocks.slice(0, 1), usdt(1_000), [10_000]);
    outcome.kind = 0;

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = [route(env.addresses.routerA, [env.addresses.base, stocks[0]!.address])];
    await expect(
      env.settlement.connect(env.signers.solverB).settle(intentId, outcome, ZERO_POLICY, routes, []),
    ).to.be.revertedWithCustomError(env.settlement, "NotSelectedSolver");
  });

  it("rebalances out of two positions and into three in one atomic settlement", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const [tsla, nvda, aapl, spy] = stocks;

    const outcome = {
      kind: 2, // REBALANCE
      inputToken: env.addresses.base,
      inputAmount: 0n,
      recipient: env.signers.user.address,
      maxSlippageBps: 150,
      legs: [
        { token: aapl!.address, weightBps: 5_000, minOut: 0n },
        { token: spy!.address, weightBps: 3_000, minOut: 0n },
        { token: nvda!.address, weightBps: 2_000, minOut: 0n },
      ],
      exits: [
        { token: tsla!.address, amountIn: shares(10), minOut: 0n },
        { token: nvda!.address, amountIn: shares(5), minOut: 0n },
      ],
    };

    const before = {
      tsla: await env.stocks.TSLAx.balanceOf(env.signers.user.address),
      aapl: await env.stocks.AAPLx.balanceOf(env.signers.user.address),
    };

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 15, 45, ethers.ZeroHash, [0n, 0n, 0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const entryRoutes = outcome.legs.map((leg) => route(env.addresses.routerB, [env.addresses.base, leg.token]));
    const exitRoutes = outcome.exits.map((exit) => route(env.addresses.routerA, [exit.token, env.addresses.base]));
    await env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, entryRoutes, exitRoutes);

    expect(await env.stocks.TSLAx.balanceOf(env.signers.user.address)).to.equal(before.tsla - shares(10));
    expect(await env.stocks.AAPLx.balanceOf(env.signers.user.address)).to.be.gt(before.aapl);
    expect((await env.intentRegistry.getIntent(intentId)).status).to.equal(3);
  });

  it("lets a basket keep a cash sleeve in the input asset", async () => {
    const { env, stocks } = await loadFixture(basketFixture);
    const amount = usdt(10_000);
    const outcome = {
      kind: 1,
      inputToken: env.addresses.base,
      inputAmount: amount,
      recipient: env.signers.user.address,
      maxSlippageBps: 100,
      legs: [
        { token: stocks[0]!.address, weightBps: 7_000, minOut: 0n },
        { token: env.addresses.base, weightBps: 3_000, minOut: 0n }, // 30% stays in USDT
      ],
      exits: [] as any[],
    };

    const beforeUsdt = await env.base.balanceOf(env.signers.user.address);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 0, 30, ethers.ZeroHash, [0n, 0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = [
      route(env.addresses.routerA, [env.addresses.base, stocks[0]!.address]),
      route(env.addresses.routerA, [env.addresses.base, stocks[0]!.address]), // unused for the cash leg
    ];
    await env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []);

    const spentOnStock = (amount * 7_000n) / 10_000n;
    expect(await env.base.balanceOf(env.signers.user.address)).to.equal(beforeUsdt - spentOnStock);
  });
});
