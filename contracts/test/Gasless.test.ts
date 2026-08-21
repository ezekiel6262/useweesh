import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZERO_POLICY, deployIntentOS, usdt } from "./fixtures";

describe("Gasless submitFor and integrator control", () => {
  async function fixture() {
    const env = await deployIntentOS();
    const outcome = {
      kind: 5,
      inputToken: env.addresses.base,
      inputAmount: usdt(500),
      recipient: env.signers.challenger.address,
      maxSlippageBps: 0,
      legs: [{ token: env.addresses.base, weightBps: 10_000, minOut: usdt(500) }],
      exits: [] as any[],
    };
    return { env, outcome };
  }

  async function signSubmit(env: any, owner: any, fields: Record<string, unknown>) {
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "IntentOS",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await env.intentRegistry.getAddress(),
    };
    const types = {
      Submit: [
        { name: "owner", type: "address" },
        { name: "kind", type: "uint8" },
        { name: "outcomeHash", type: "bytes32" },
        { name: "policyHash", type: "bytes32" },
        { name: "salt", type: "bytes32" },
        { name: "auctionEndsAt", type: "uint64" },
        { name: "deadline", type: "uint64" },
        { name: "legCount", type: "uint16" },
        { name: "integrator", type: "address" },
        { name: "metadataURI", type: "string" },
        { name: "nonce", type: "uint256" },
      ],
    };
    return owner.signTypedData(domain, types, fields);
  }

  it("lets a relayer submit an intent the owner signed", async () => {
    const { env, outcome } = await loadFixture(fixture);
    const now = await time.latest();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const auctionEndsAt = now + 20;
    const deadline = now + 600;
    const outcomeHash = await env.intentRegistry.hashOutcome(outcome);
    const policyHash = await env.intentRegistry.hashPolicy(ZERO_POLICY);
    const nonce = await env.intentRegistry.nonces(env.signers.user.address);

    const signature = await signSubmit(env, env.signers.user, {
      owner: env.signers.user.address,
      kind: outcome.kind,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt,
      deadline,
      legCount: 1,
      integrator: ethers.ZeroAddress,
      metadataURI: "gasless-pay",
      nonce,
    });

    const intentId = await env.intentRegistry.computeIntentId(
      env.signers.user.address,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt,
      deadline,
    );

    await expect(
      env.intentRegistry.connect(env.signers.coordinator).submitFor(
        env.signers.user.address,
        salt,
        outcome.kind,
        outcomeHash,
        policyHash,
        1,
        auctionEndsAt,
        deadline,
        ethers.ZeroAddress,
        "gasless-pay",
        signature,
      ),
    ).to.emit(env.intentRegistry, "IntentSubmitted");

    const record = await env.intentRegistry.getIntent(intentId);
    expect(record.owner).to.equal(env.signers.user.address);
    expect(await env.intentRegistry.nonces(env.signers.user.address)).to.equal(nonce + 1n);
  });

  it("rejects a submitFor signed by someone else", async () => {
    const { env, outcome } = await loadFixture(fixture);
    const now = await time.latest();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const auctionEndsAt = now + 20;
    const deadline = now + 600;
    const outcomeHash = await env.intentRegistry.hashOutcome(outcome);
    const policyHash = await env.intentRegistry.hashPolicy(ZERO_POLICY);
    const nonce = await env.intentRegistry.nonces(env.signers.user.address);

    const signature = await signSubmit(env, env.signers.solverA, {
      owner: env.signers.user.address,
      kind: outcome.kind,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt,
      deadline,
      legCount: 1,
      integrator: ethers.ZeroAddress,
      metadataURI: "",
      nonce,
    });

    await expect(
      env.intentRegistry.connect(env.signers.coordinator).submitFor(
        env.signers.user.address,
        salt,
        outcome.kind,
        outcomeHash,
        policyHash,
        1,
        auctionEndsAt,
        deadline,
        ethers.ZeroAddress,
        "",
        signature,
      ),
    ).to.be.revertedWithCustomError(env.intentRegistry, "BadSignature");
  });

  it("pins selection to the named integrator", async () => {
    const { env } = await loadFixture(fixture);
    const tsla = await env.stocks.TSLAx.getAddress();
    const outcome = {
      kind: 0,
      inputToken: env.addresses.base,
      inputAmount: usdt(1_000),
      recipient: env.signers.user.address,
      maxSlippageBps: 100,
      legs: [{ token: tsla, weightBps: 10_000, minOut: 0n }],
      exits: [] as any[],
    };
    const now = await time.latest();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const auctionEndsAt = now + 20;
    const deadline = now + 600;
    const outcomeHash = await env.intentRegistry.hashOutcome(outcome);
    const policyHash = await env.intentRegistry.hashPolicy(ZERO_POLICY);
    const nonce = await env.intentRegistry.nonces(env.signers.user.address);
    const integrator = env.signers.challenger.address;

    const signature = await signSubmit(env, env.signers.user, {
      owner: env.signers.user.address,
      kind: outcome.kind,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt,
      deadline,
      legCount: 1,
      integrator,
      metadataURI: "",
      nonce,
    });

    const tx = await env.intentRegistry.connect(env.signers.coordinator).submitFor(
      env.signers.user.address,
      salt,
      outcome.kind,
      outcomeHash,
      policyHash,
      1,
      auctionEndsAt,
      deadline,
      integrator,
      "",
      signature,
    );
    const receipt = await tx.wait();
    const intentId = (await env.intentRegistry.computeIntentId(
      env.signers.user.address,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt,
      deadline,
    ));

    await env.intentRegistry.connect(env.signers.solverA).placeBid(intentId, 10, 30, ethers.ZeroHash, [0n]);
    await time.increase(25);

    await expect(
      env.intentRegistry.connect(env.signers.coordinator).selectWinner(intentId, 0),
    ).to.be.revertedWithCustomError(env.intentRegistry, "NotSelector");

    await expect(env.intentRegistry.connect(env.signers.challenger).selectWinner(intentId, 0)).to.not.be.reverted;
    expect((await env.intentRegistry.getIntent(intentId)).integrator).to.equal(integrator);
    void receipt;
  });

  it("permit lets the owner approve settlement without sending a transaction", async () => {
    const { env } = await loadFixture(fixture);
    const token = env.base;
    const owner = env.signers.user;
    const spender = env.addresses.settlement;
    const value = usdt(500);
    const deadline = (await time.latest()) + 3_600;
    const nonce = await token.nonces(owner.address);
    const network = await ethers.provider.getNetwork();
    const domain = {
      name: await token.name(),
      version: "1",
      chainId: network.chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    const signature = await owner.signTypedData(domain, types, {
      owner: owner.address,
      spender,
      value,
      nonce,
      deadline,
    });
    const { r, s, v } = ethers.Signature.from(signature);
    await token.connect(env.signers.coordinator).permit(owner.address, spender, value, deadline, v, r, s);
    expect(await token.allowance(owner.address, spender)).to.equal(value);
  });
});
