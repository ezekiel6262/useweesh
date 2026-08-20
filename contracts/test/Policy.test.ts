import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZERO_POLICY, deployIntentOS, route, submitIntent, usdt } from "./fixtures";

/**
 * Guardrails are the reason an agent can be handed a budget and left alone: whatever the solver
 * proposes, settlement will not step outside the policy the user committed to.
 */
describe("PolicyEngine and RWARegistry", () => {
  async function fixture() {
    const env = await deployIntentOS();
    const tsla = await env.stocks.TSLAx.getAddress();
    const nvda = await env.stocks.NVDAx.getAddress();
    const outcome = {
      kind: 0,
      inputToken: env.addresses.base,
      inputAmount: usdt(10_000),
      recipient: env.signers.user.address,
      maxSlippageBps: 100,
      legs: [{ token: tsla, weightBps: 10_000, minOut: 0n }],
      exits: [] as any[],
    };
    return { env, tsla, nvda, outcome };
  }

  /** Run an intent all the way to settlement under `policy`, returning the settle promise. */
  async function settleUnder(env: any, outcome: any, policy: any, tokenPath: string[], feeBps = 10) {
    const { intentId } = await submitIntent(env, env.signers.user, outcome, policy);
    await env.intentRegistry
      .connect(env.signers.solverA)
      .placeBid(intentId, feeBps, 30, ethers.ZeroHash, outcome.legs.map(() => 0n));
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);
    return env.settlement
      .connect(env.signers.solverA)
      .settle(intentId, outcome, policy, [route(env.addresses.routerA, tokenPath)], []);
  }

  it("caps the notional a single intent may spend", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, maxNotional: usdt(5_000) };
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla])).to.be.revertedWithCustomError(
      env.policyEngine,
      "NotionalTooLarge",
    );
  });

  it("caps the fee a solver may charge", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, maxFeeBps: 5 };
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla], 20)).to.be.revertedWithCustomError(
      env.policyEngine,
      "FeeTooHigh",
    );
  });

  it("keeps the intent inside its token allowlist", async () => {
    const { env, tsla, nvda, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, tokenAllowlist: [nvda] };
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla]))
      .to.be.revertedWithCustomError(env.policyEngine, "TokenNotAllowed")
      .withArgs(tsla);
  });

  it("enforces a reputation floor on the winning solver", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, minReputationBps: 9_000 }; // a fresh solver starts at 5000
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla])).to.be.revertedWithCustomError(
      env.policyEngine,
      "SolverReputationTooLow",
    );
  });

  it("honours the policy's validity window", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, validAfter: BigInt((await time.latest()) + 10_000) };
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla])).to.be.revertedWithCustomError(
      env.policyEngine,
      "PolicyNotYetValid",
    );
  });

  it("rejects weights that do not add up, whatever the solver claims", async () => {
    const { env, tsla, nvda } = await loadFixture(fixture);
    const outcome = {
      kind: 1,
      inputToken: env.addresses.base,
      inputAmount: usdt(10_000),
      recipient: env.signers.user.address,
      maxSlippageBps: 100,
      legs: [
        { token: tsla, weightBps: 6_000, minOut: 0n },
        { token: nvda, weightBps: 3_000, minOut: 0n }, // sums to 9000
      ],
      exits: [] as any[],
    };

    const { intentId } = await submitIntent(env, env.signers.user, outcome);
    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n, 0n]);
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);

    const routes = [
      route(env.addresses.routerA, [env.addresses.base, tsla]),
      route(env.addresses.routerA, [env.addresses.base, nvda]),
    ];
    await expect(
      env.settlement.connect(env.signers.solverA).settle(intentId, outcome, ZERO_POLICY, routes, []),
    ).to.be.revertedWithCustomError(env.policyEngine, "WeightsInvalid");
  });

  it("requires a live RWA attestation when the intent asks for one", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, requireRwaAttested: true };

    // Attested at deploy time, so this settles.
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla])).to.not.be.reverted;

    // Revoke the attestation and the same intent shape is no longer servable.
    await env.rwaRegistry.revoke(tsla, "issuer wound down the wrapper");
    expect(await env.rwaRegistry.isAttested(tsla)).to.equal(false);
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla]))
      .to.be.revertedWithCustomError(env.policyEngine, "AssetNotAttested")
      .withArgs(tsla);
  });

  it("treats an attestation past its review date as stale", async () => {
    const { env, tsla } = await loadFixture(fixture);
    const reviewBy = (await time.latest()) + 3_600;
    await env.rwaRegistry.attest(tsla, 1, "TSLAx", "ISIN:US88160R1014", "https://example.org/tsla.json", reviewBy);
    expect(await env.rwaRegistry.isAttested(tsla)).to.equal(true);

    await time.increase(7_200);
    expect(await env.rwaRegistry.isAttested(tsla)).to.equal(false);
  });

  it("records onboarding requests so an asset can be brought onchain from an intent", async () => {
    const { env } = await loadFixture(fixture);
    await expect(
      env.rwaRegistry
        .connect(env.signers.user)
        .requestOnboarding(ethers.ZeroAddress, 4, "LEI:5493001KJTIIGC8Y1R12", "ipfs://credit-fund-terms"),
    )
      .to.emit(env.rwaRegistry, "OnboardingRequested")
      .withArgs(0, env.signers.user.address, "LEI:5493001KJTIIGC8Y1R12");

    expect(await env.rwaRegistry.requestCount()).to.equal(1);
    const request = await env.rwaRegistry.requestAt(0);
    expect(request.requester).to.equal(env.signers.user.address);
    expect(request.resolved).to.equal(false);

    const token = await env.stocks.SPYx.getAddress();
    await env.rwaRegistry.resolveOnboarding(0, token, true);
    expect((await env.rwaRegistry.requestAt(0)).resolved).to.equal(true);
  });

  it("rejects a non-KYB solver when the intent requires a compliant path", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, requireCompliant: true };
    await expect(settleUnder(env, outcome, policy, [env.addresses.base, tsla])).to.be.revertedWithCustomError(
      env.policyEngine,
      "SolverNotCompliant",
    );
  });

  it("lets a KYB-attested solver fill a compliant intent", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const policy = { ...ZERO_POLICY, requireCompliant: true };
    const { intentId } = await submitIntent(env, env.signers.user, outcome, policy);
    await env.intentRegistry
      .connect(env.signers.solverB)
      .placeBid(intentId, 10, 30, ethers.ZeroHash, outcome.legs.map(() => 0n));
    await time.increase(25);
    await env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0);
    await expect(
      env.settlement
        .connect(env.signers.solverB)
        .settle(intentId, outcome, policy, [route(env.addresses.routerA, [env.addresses.base, tsla])], []),
    ).to.not.be.reverted;
  });

  it("refuses a slippage tolerance beyond the protocol ceiling", async () => {
    const { env, tsla, outcome } = await loadFixture(fixture);
    const wild = { ...outcome, maxSlippageBps: 2_500 };
    await expect(settleUnder(env, wild, ZERO_POLICY, [env.addresses.base, tsla])).to.be.revertedWithCustomError(
      env.policyEngine,
      "SlippageTooHigh",
    );
  });
});
