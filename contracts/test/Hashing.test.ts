import { expect } from "chai";
import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The other half of the encoding contract. packages/intent-schema/test/hash.test.js replays this
 * same fixture through the TypeScript implementation; if either side drifts, one of the two
 * suites goes red and settlement is never allowed to fail with OutcomeMismatch in production.
 *
 * Regenerate with: npx hardhat run scripts/gen-vectors.ts
 */
describe("IntentLib hashing", () => {
  const vectors = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "packages", "intent-schema", "test", "vectors.json"), "utf8"),
  );

  async function deployRegistry() {
    const [signer] = await ethers.getSigners();
    const solvers = await (await ethers.getContractFactory("SolverRegistry")).deploy(signer!.address, 0);
    return (await ethers.getContractFactory("IntentRegistry")).deploy(signer!.address, await solvers.getAddress());
  }

  const revive = (value: any): any => {
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
    }
    return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value;
  };

  it("has vectors to check", () => {
    expect(vectors.length).to.be.greaterThan(0);
  });

  for (const vector of vectors as any[]) {
    it(`reproduces the fixture hashes for: ${vector.name}`, async () => {
      const registry = await deployRegistry();
      expect(await registry.hashOutcome(revive(vector.outcome))).to.equal(vector.expected.outcomeHash);
      expect(await registry.hashPolicy(revive(vector.policy))).to.equal(vector.expected.policyHash);
    });
  }

  it("derives intent ids that depend on the registry and the chain", async () => {
    const registry = await deployRegistry();
    const vector = vectors[0];
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const onchain = await registry.computeIntentId(
      vector.owner,
      vector.expected.outcomeHash,
      vector.expected.policyHash,
      vector.salt,
      vector.auctionEndsAt,
      vector.deadline,
    );

    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address", "address", "bytes32", "bytes32", "bytes32", "uint64", "uint64"],
        [
          ethers.keccak256(ethers.toUtf8Bytes("IntentOS.Intent.v1")),
          chainId,
          await registry.getAddress(),
          vector.owner,
          vector.expected.outcomeHash,
          vector.expected.policyHash,
          vector.salt,
          vector.auctionEndsAt,
          vector.deadline,
        ],
      ),
    );
    expect(onchain).to.equal(expected);
  });
});
