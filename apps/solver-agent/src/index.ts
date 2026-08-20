import type { Hex } from "viem";
import { IntentOSClient, loadDeployment } from "@intentos/sdk";
import { STRATEGIES, Solver, type SolverStrategy } from "@intentos/solver-core";
import { HttpIntentFeed } from "./feed.js";

/**
 * Runs one or more solvers against a live IntentOS deployment.
 *
 *   SOLVER_KEYS=0xabc…,0xdef… SOLVER_STRATEGIES=aggressive,conservative npm run solvers
 *
 * Each key is an independent solver: it bonds itself, watches the mempool, bids what it is
 * willing to guarantee, and settles what it wins. Running two with different strategies is the
 * point — the auction only means something when the bids disagree.
 */

const DEFAULT_KEYS = [
  // Hardhat accounts #4 and #5, matching the local demo. Public test keys, no value anywhere.
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as Hex[];

async function main() {
  const deployment = loadDeployment(process.env.INTENTOS_NETWORK);
  const rpcUrl = process.env.INTENTOS_RPC;
  const apiUrl = process.env.INTENTOS_API_URL ?? "http://localhost:8787";
  const intervalMs = Number(process.env.SOLVER_INTERVAL_MS ?? 2_000);
  const bond = BigInt(process.env.SOLVER_BOND_WEI ?? 10n ** 16n);

  const keys = (process.env.SOLVER_KEYS?.split(",").map((k) => k.trim()) as Hex[]) ?? DEFAULT_KEYS;
  const names = process.env.SOLVER_STRATEGIES?.split(",").map((s) => s.trim()) ?? ["aggressive", "conservative"];

  const feed = new HttpIntentFeed(apiUrl, process.env.INTENTOS_OBSERVATIONS_URL);

  console.log(`\nIntentOS solvers -> ${deployment.network} (chain ${deployment.chainId})`);
  console.log(`  mempool ${apiUrl}`);

  const solvers: Solver[] = [];
  for (const [i, key] of keys.entries()) {
    const strategy: SolverStrategy = STRATEGIES[names[i % names.length]!] ?? STRATEGIES.balanced!;
    const solver = new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: key }),
      feed,
      strategy,
      log: (message) => console.log(`  ${message}`),
    });

    await solver.ensureRegistered(bond);
    const record = await solver.client.getSolver(solver.address);
    console.log(
      `  ${strategy.name.padEnd(13)} ${solver.address}  reputation ${(record.reputationBps / 100).toFixed(0)}%`,
    );
    solvers.push(solver);
  }

  console.log(`\nwatching for intents every ${intervalMs}ms — ctrl-c to stop\n`);
  for (const solver of solvers) solver.start(intervalMs);

  const shutdown = () => {
    for (const solver of solvers) solver.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
});
