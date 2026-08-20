import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZERO_POLICY, deployIntentOS, route, submitIntent, usdt } from "./fixtures";

/**
 * The auction is what makes solver competition real: bids are public and binding, the winner is
 * held to what it promised, and a coordinator that ignores a strictly better bid loses bond.
 */
describe("IntentRegistry — auction and lifecycle", () => {
  async function swapFixture() {
    const env = await deployIntentOS();
    const tsla = await env.stocks.TSLAx.getAddress();
    const outcome = {
      kind: 0,
      inputToken: env.addresses.base,
      inputAmount: usdt(10_000),
      recipient: env.signers.user.address,
      maxSlippageBps: 100,
      legs: [{ token: tsla, weightBps: 10_000, minOut: 0n }],
      exits: [] as any[],
    };
    return { env, tsla, outcome };
  }

  it("derives the intent id onchain so nobody can squat on it", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId, salt, auctionEndsAt, deadline, outcomeHash, policyHash } = await submitIntent(
      env,
      env.signers.user,
      outcome,
    );

    // Same parameters from a different account produce a different id, so a front-runner
    // cannot occupy the slot the user is about to use.
    const attackerId = await env.intentRegistry.computeIntentId(
      env.signers.solverB.address,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt,
      deadline,
    );
    expect(attackerId).to.not.equal(intentId);
    expect((await env.intentRegistry.getIntent(intentId)).owner).to.equal(env.signers.user.address);
  });

  it("refuses bids from unbonded solvers and after the window closes", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);

    await expect(
      env.intentRegistry.connect(env.signers.challenger).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]),
    ).to.be.revertedWithCustomError(env.intentRegistry, "SolverInactive");

    await time.increase(25);
    await expect(
      env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]),
    ).to.be.revertedWithCustomError(env.intentRegistry, "AuctionClosed");
  });

  it("rejects a bid whose guarantee vector does not cover every leg", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await expect(
      env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n, 0n]),
    ).to.be.revertedWithCustomError(env.intentRegistry, "BadLegCount");
  });

  it("will not select a winner while the auction is still open", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await expect(
      env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0),
    ).to.be.revertedWithCustomError(env.intentRegistry, "AuctionStillOpen");
  });

  it("slashes the auctioneer's bond when it passes over a dominating bid", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);

    // Solver B is better on both axes: more output guaranteed, lower fee.
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 25, 30, ethers.ZeroHash, [100n]);
    await env.intentRegistry.connect(env.signers.solverB).placeBid(intentId, 10, 30, ethers.ZeroHash, [120n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const bondBefore = await env.intentRegistry.auctioneerBond();
    const balanceBefore = await ethers.provider.getBalance(env.signers.challenger.address);

    const tx = await env.intentRegistry.connect(env.signers.challenger).challengeSelection(intentId, 1);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;

    const reward = (bondBefore * 2_000n) / 10_000n;
    expect(await env.intentRegistry.auctioneerBond()).to.equal(bondBefore - reward);
    expect(await ethers.provider.getBalance(env.signers.challenger.address)).to.equal(balanceBefore + reward - gas);

    // The intent goes back to auction rather than being stranded.
    expect((await env.intentRegistry.getIntent(intentId)).status).to.equal(1); // OPEN
  });

  it("rejects a challenge against a bid that is not strictly better", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);

    // B guarantees more but charges more too — a real trade-off, not dominance.
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [100n]);
    await env.intentRegistry.connect(env.signers.solverB).placeBid(intentId, 25, 30, ethers.ZeroHash, [120n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    await expect(
      env.intentRegistry.connect(env.signers.challenger).challengeSelection(intentId, 1),
    ).to.be.revertedWithCustomError(env.intentRegistry, "NotDominating");
  });

  it("does not let anyone challenge a choice the intent owner made themselves", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 25, 30, ethers.ZeroHash, [100n]);
    await env.intentRegistry.connect(env.signers.solverB).placeBid(intentId, 10, 30, ethers.ZeroHash, [120n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.user).selectWinner(intentId, 0);

    await expect(
      env.intentRegistry.connect(env.signers.challenger).challengeSelection(intentId, 1),
    ).to.be.revertedWithCustomError(env.intentRegistry, "NotChallengeable");
  });

  it("moves reputation on success and on failure", async () => {
    const { env, tsla, outcome } = await loadFixture(swapFixture);
    const seed = await env.solverRegistry.reputationOf(env.signers.solverA.address);
    expect(seed).to.equal(5_000);

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);
    await env.settlement
      .connect(env.signers.solverA)
      .settle(intentId, outcome, ZERO_POLICY, [route(env.addresses.routerA, [env.addresses.base, tsla])], []);

    const afterSuccess = await env.solverRegistry.reputationOf(env.signers.solverA.address);
    expect(afterSuccess).to.equal(6_000); // 5000 * 0.8 + 10000 * 0.2

    // A solver that walks away from a selected intent takes the hit.
    const second = await submitIntent(env, env.signers.user, outcome, ZERO_POLICY, { salt: ethers.hexlify(ethers.randomBytes(32)) });
    await env.intentRegistry.connect(env.signers.solverA).placeBid(second.intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(second.intentId, 0);
    await env.settlement.connect(env.signers.solverA).reportFailure(second.intentId, "no route");

    expect(await env.solverRegistry.reputationOf(env.signers.solverA.address)).to.equal(4_800); // 6000 * 0.8
    expect((await env.intentRegistry.getIntent(second.intentId)).status).to.equal(1); // back to OPEN
  });

  it("expires an unserved intent and marks down the solver that abandoned it", async () => {
    const { env, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome, ZERO_POLICY, { ttlSeconds: 120 });
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    await expect(env.intentRegistry.expire(intentId)).to.be.revertedWithCustomError(env.intentRegistry, "BadTiming");

    await time.increase(200);
    await env.intentRegistry.connect(env.signers.challenger).expire(intentId);

    expect((await env.intentRegistry.getIntent(intentId)).status).to.equal(5); // EXPIRED
    expect(await env.solverRegistry.reputationOf(env.signers.solverA.address)).to.equal(4_000);
  });

  it("lets the owner cancel, and blocks settlement afterwards", async () => {
    const { env, tsla, outcome } = await loadFixture(swapFixture);
    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);
    await env.intentRegistry.connect(env.signers.user).cancel(intentId);

    await expect(
      env.settlement
        .connect(env.signers.solverA)
        .settle(intentId, outcome, ZERO_POLICY, [route(env.addresses.routerA, [env.addresses.base, tsla])], []),
    ).to.be.revertedWithCustomError(env.settlement, "IntentNotSelected");
  });
});
