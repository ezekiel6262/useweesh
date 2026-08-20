import { ethers } from "hardhat";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regenerate the shared hashing fixture from the contracts, which are the source of truth.
 *
 *   npx hardhat run scripts/gen-vectors.ts
 *
 * Both sides of the encoding are then pinned: contracts/test/Hashing.test.ts replays the
 * fixture against the contract, and packages/intent-schema/test/hash.test.ts replays it
 * against the TypeScript implementation. If either drifts, exactly one of them goes red.
 */

const A = (n: number) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));

const CASES = [
  {
    name: "single-leg swap",
    outcome: {
      kind: 0,
      inputToken: A(0x11),
      inputAmount: 10_000_000_000n,
      recipient: A(0xbeef),
      maxSlippageBps: 50,
      legs: [{ token: A(0x21), weightBps: 10_000, minOut: 30_000_000_000_000_000_000n }],
      exits: [],
    },
    policy: {
      maxNotional: 0n,
      validAfter: 0n,
      validUntil: 0n,
      maxFeeBps: 30,
      minReputationBps: 0,
      requireRwaAttested: false,
      tokenAllowlist: [] as string[],
    },
    salt: "0x" + "01".repeat(32),
    auctionEndsAt: 1_800_000_020n,
    deadline: 1_800_000_600n,
    owner: A(0xa11ce),
  },
  {
    name: "four-leg xStocks basket with allowlist and attestation requirement",
    outcome: {
      kind: 1,
      inputToken: A(0x11),
      inputAmount: 10_000_000_000n,
      recipient: A(0xbeef),
      maxSlippageBps: 100,
      legs: [
        { token: A(0x21), weightBps: 2_500, minOut: 7_500_000_000_000_000_000n },
        { token: A(0x22), weightBps: 2_500, minOut: 13_800_000_000_000_000_000n },
        { token: A(0x23), weightBps: 2_500, minOut: 10_800_000_000_000_000_000n },
        { token: A(0x24), weightBps: 2_500, minOut: 3_900_000_000_000_000_000n },
      ],
      exits: [],
    },
    policy: {
      maxNotional: 25_000_000_000n,
      validAfter: 1_800_000_000n,
      validUntil: 1_800_090_000n,
      maxFeeBps: 25,
      minReputationBps: 4_000,
      requireRwaAttested: true,
      tokenAllowlist: [A(0x21), A(0x22), A(0x23), A(0x24)],
    },
    salt: "0x" + "02".repeat(32),
    auctionEndsAt: 1_800_000_030n,
    deadline: 1_800_001_200n,
    owner: A(0xa11ce),
  },
  {
    name: "rebalance with two exits and three entries",
    outcome: {
      kind: 2,
      inputToken: A(0x11),
      inputAmount: 0n,
      recipient: A(0xbeef),
      maxSlippageBps: 75,
      legs: [
        { token: A(0x22), weightBps: 4_000, minOut: 1n },
        { token: A(0x23), weightBps: 4_000, minOut: 2n },
        { token: A(0x24), weightBps: 2_000, minOut: 3n },
      ],
      exits: [
        { token: A(0x21), amountIn: 5_000_000_000_000_000_000n, minOut: 1_600_000_000n },
        { token: A(0x25), amountIn: 2_000_000_000_000_000_000n, minOut: 390_000_000n },
      ],
    },
    policy: {
      maxNotional: 0n,
      validAfter: 0n,
      validUntil: 1_800_090_000n,
      maxFeeBps: 40,
      minReputationBps: 6_000,
      requireRwaAttested: false,
      tokenAllowlist: [],
    },
    salt: "0x" + "03".repeat(32),
    auctionEndsAt: 1_800_000_045n,
    deadline: 1_800_003_600n,
    owner: A(0xa11ce),
  },
];

async function main() {
  const [signer] = await ethers.getSigners();
  const solvers = await (await ethers.getContractFactory("SolverRegistry")).deploy(signer!.address, 0);
  const registry = await (await ethers.getContractFactory("IntentRegistry"))
    .deploy(signer!.address, await solvers.getAddress());
  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  const vectors = [];
  for (const c of CASES) {
    const outcomeHash = await registry.hashOutcome(c.outcome);
    const policyHash = await registry.hashPolicy(c.policy);
    const intentId = await registry.computeIntentId(
      c.owner,
      outcomeHash,
      policyHash,
      c.salt,
      c.auctionEndsAt,
      c.deadline,
    );
    vectors.push({
      name: c.name,
      chainId,
      registry: registryAddress,
      owner: c.owner,
      salt: c.salt,
      auctionEndsAt: c.auctionEndsAt.toString(),
      deadline: c.deadline.toString(),
      outcome: serialize(c.outcome),
      policy: serialize(c.policy),
      expected: { outcomeHash, policyHash, intentId },
    });
  }

  // The fixture is generated against a fixed registry address and chain id so it stays stable.
  const out = join(__dirname, "..", "..", "packages", "intent-schema", "test", "vectors.json");
  writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
  console.log(`wrote ${out} (${vectors.length} vectors)`);
}

function serialize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
