import type { Hex } from "viem";

/**
 * The well-known Hardhat development keys, in the same order scripts/deploy.ts assigns roles.
 * These are public test keys with no value on any real network — never reuse them anywhere.
 */
export const LOCAL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  treasury: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  coordinator: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
  user: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex,
  solverA: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" as Hex,
  solverB: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as Hex,
} as const;
