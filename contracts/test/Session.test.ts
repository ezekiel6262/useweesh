import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ZERO_POLICY, deployIntentOS, usdt } from "./fixtures";

describe("Session keys and ERC-1271", () => {
  async function fixture() {
    const env = await deployIntentOS();
    const outcome = {
      kind: 5,
      inputToken: env.addresses.base,
      inputAmount: usdt(100),
      recipient: env.signers.user.address,
      maxSlippageBps: 0,
      legs: [{ token: env.addresses.base, weightBps: 10_000, minOut: usdt(100) }],
      exits: [] as any[],
    };
    return { env, outcome };
  }

  async function signSubmit(env: any, signer: any, fields: Record<string, unknown>) {
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
    return signer.signTypedData(domain, types, fields);
  }

  it("lets a session key sign Submit for the owner", async () => {
    const { env, outcome } = await loadFixture(fixture);
    const session = env.signers.challenger;
    const now = await time.latest();
    await env.intentRegistry.connect(env.signers.user).authorizeSession(
      env.signers.user.address,
      session.address,
      now + 86_400,
      0,
      "0x",
    );

    const salt = ethers.hexlify(ethers.randomBytes(32));
    const outcomeHash = await env.intentRegistry.hashOutcome(outcome);
    const policyHash = await env.intentRegistry.hashPolicy(ZERO_POLICY);
    const fields = {
      owner: env.signers.user.address,
      kind: 5,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt: now + 30,
      deadline: now + 180,
      legCount: 1,
      integrator: ethers.ZeroAddress,
      metadataURI: "",
      nonce: 0n,
    };
    const sig = await signSubmit(env, session, fields);
    const tx = await env.intentRegistry.connect(env.signers.coordinator).submitFor(
      env.signers.user.address,
      salt,
      5,
      outcomeHash,
      policyHash,
      1,
      fields.auctionEndsAt,
      fields.deadline,
      ethers.ZeroAddress,
      "",
      sig,
    );
    await tx.wait();
    const ids = await env.intentRegistry.intentsOf(env.signers.user.address);
    expect(ids.length).to.equal(1);
  });

  it("accepts ERC-1271 smart-account owners", async () => {
    const { env, outcome } = await loadFixture(fixture);
    const account = await (await ethers.getContractFactory("MockSmartAccount")).deploy(env.signers.user.address);
    const now = await time.latest();
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const outcomeHash = await env.intentRegistry.hashOutcome(outcome);
    const policyHash = await env.intentRegistry.hashPolicy(ZERO_POLICY);
    const fields = {
      owner: await account.getAddress(),
      kind: 5,
      outcomeHash,
      policyHash,
      salt,
      auctionEndsAt: now + 30,
      deadline: now + 180,
      legCount: 1,
      integrator: ethers.ZeroAddress,
      metadataURI: "",
      nonce: 0n,
    };
    const sig = await signSubmit(env, env.signers.user, fields);
    await env.intentRegistry.connect(env.signers.coordinator).submitFor(
      await account.getAddress(),
      salt,
      5,
      outcomeHash,
      policyHash,
      1,
      fields.auctionEndsAt,
      fields.deadline,
      ethers.ZeroAddress,
      "",
      sig,
    );
    const ids = await env.intentRegistry.intentsOf(await account.getAddress());
    expect(ids.length).to.equal(1);
  });
});
