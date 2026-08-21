/**
 * Seed a live IntentOS deployment with diverse intents so the registry is not empty at demo time.
 *
 *   npx tsx scripts/seedIntents.ts
 *
 * Uses COORDINATOR / SOLVER_* keys from the environment (or .env). Does not print keys.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  IntentKind,
  IntentOSClient,
  catalogFromDeployment,
  parseIntent,
  retimeDraft,
  type DeploymentFile,
  type Hex,
  type IntentDraft,
} from "@intentos/sdk";
import { Coordinator, Solver, StaticIntentFeed, AGGRESSIVE, CONSERVATIVE, RWA_DESK, PAYROLL } from "@intentos/solver-core";
import { SolverCapability } from "@intentos/intent-schema";

function loadEnv() {
  const path = join(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function key(name: string): Hex {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

function loadDeployment(): DeploymentFile {
  const file = join(process.cwd(), "deployments", "xlayerTestnet.json");
  return JSON.parse(readFileSync(file, "utf8")) as DeploymentFile;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function parseFor(client: IntentOSClient, prompt: string, extra?: Partial<IntentDraft["policy"]>) {
  const catalog = catalogFromDeployment(client.deployment);
  const parsed = await parseIntent(prompt, {
    catalog,
    recipient: client.address,
    now: await client.chainNow(),
    auctionSeconds: 30,
    ttlSeconds: 180,
    prefer: "grammar",
  });
  const draft = retimeDraft(parsed.draft, {
    now: await client.chainNow(),
    auctionSeconds: 30,
    ttlSeconds: 180,
  });
  if (extra) draft.policy = { ...draft.policy, ...extra };
  return draft;
}

async function main() {
  loadEnv();
  const deployment = loadDeployment();
  const rpcUrl = process.env.INTENTOS_RPC ?? process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech";
  const seeder = new IntentOSClient({ deployment, rpcUrl, privateKey: key("PRIVATE_KEY") });
  const coordinator = new Coordinator({
    client: new IntentOSClient({ deployment, rpcUrl, privateKey: key("COORDINATOR_PRIVATE_KEY") }),
  });
  const feed = new StaticIntentFeed();
  const solvers = [
    new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: key("SOLVER_A_PRIVATE_KEY") }),
      feed,
      strategy: AGGRESSIVE,
      capabilities: SolverCapability.AI | SolverCapability.RWA | SolverCapability.STABLE | SolverCapability.GASLESS,
    }),
    new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: key("SOLVER_B_PRIVATE_KEY") }),
      feed,
      strategy: CONSERVATIVE,
      kyb: true,
      capabilities:
        SolverCapability.COMPLIANT |
        SolverCapability.RWA |
        SolverCapability.STABLE |
        SolverCapability.AGENT |
        SolverCapability.GASLESS,
    }),
    new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: key("SOLVER_C_PRIVATE_KEY") }),
      feed,
      strategy: RWA_DESK,
      capabilities: SolverCapability.RWA | SolverCapability.AGENT | SolverCapability.GASLESS,
      acceptKinds: [IntentKind.RWA_ONBOARD, IntentKind.BASKET, IntentKind.REBALANCE],
    }),
    new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: key("SOLVER_D_PRIVATE_KEY") }),
      feed,
      strategy: PAYROLL,
      capabilities: SolverCapability.STABLE | SolverCapability.GASLESS,
      acceptKinds: [IntentKind.PAYMENT],
    }),
  ];

  console.log(`seed -> ${deployment.network} registry ${deployment.contracts.intentRegistry}`);
  console.log(`seeder ${seeder.address}`);
  console.log(`reference solvers ${solvers.length} (operated by IntentOS)`);

  const prompts: { label: string; prompt: string; policy?: Partial<IntentDraft["policy"]>; fail?: boolean }[] = [
    { label: "PAYMENTS 1", prompt: "Pay 250 USDG gaslessly to 0x000000000000000000000000000000000000cafe" },
    { label: "PAYMENTS 2", prompt: "Pay 80 USDG to 0x000000000000000000000000000000000000bEEF" },
    { label: "PAYMENTS 3", prompt: "Swap 400 USDT into USDG with 0.1% max slippage" },
    { label: "RWA 1", prompt: "Allocate 1,200 USDT across TSLA, NVDA and AAPL xStocks equally, only attested assets" },
    { label: "RWA 2", prompt: "put 800 USDT into NVDA and AAPL, 60/40, only attested assets" },
    { label: "RWA 3", prompt: "Buy 500 USDT of TSLAx with 0.5% max slippage, only attested assets" },
    {
      label: "COMPLIANT fail-select",
      prompt: "Using only compliant solvers, swap 300 USDT into USDG",
      policy: { requireCompliant: true },
    },
    {
      label: "COMPLIANT ok",
      prompt: "Using only compliant solvers, allocate 600 USDT equally across TSLA and NVDA xStocks, only attested assets",
      policy: { requireCompliant: true },
    },
    { label: "AGENT 1", prompt: "put 350 USDT into NVDA and AAPL, 70/30, only attested assets" },
    { label: "AGENT 2", prompt: "Swap 200 USDT into TSLAx with 1% max slippage" },
    { label: "FAIL guarantee", prompt: "Swap 150 USDT into TSLAx with 0.01% max slippage", fail: true },
  ];

  for (const item of prompts) {
    try {
      const draft = await parseFor(seeder, item.prompt, item.policy);
      if (item.label.startsWith("AGENT")) draft.metadata.source = "agent.declare";
      const submitted = await seeder.submitIntent(draft, {
        metadataURI: `${item.label}: ${(draft.metadata.prompt ?? item.prompt).slice(0, 80)}`,
        auctionSeconds: 30,
      });
      console.log(`${item.label} submitted ${submitted.intentId}`);
      feed.add(submitted.intentId, submitted.draft);
      for (const solver of solvers) {
        const activity = await solver.tick();
        for (const row of activity) console.log(`  ${row.action} ${row.detail}`);
      }
      const waitMs = Math.max(2_000, Number(submitted.draft.auctionEndsAt) * 1000 - Date.now() + 2_000);
      await sleep(Math.min(waitMs, 20_000));
      const closed = await coordinator.close(submitted.intentId, submitted.draft);
      if (closed.skipped) {
        console.log(`  close skipped: ${closed.skipped}`);
        continue;
      }
      console.log(`  selected ${closed.selected?.solver} bid ${closed.selected?.bidId}`);
      if (item.fail) {
        const winner = solvers.find((s) => s.address.toLowerCase() === closed.selected?.solver.toLowerCase());
        if (winner) {
          try {
            await winner.client.reportFailure(submitted.intentId, "seeded missed guarantee");
            console.log(`  reported failure (honest revert / slash path)`);
          } catch (error) {
            console.log(`  fail path: ${(error as Error).message}`);
          }
        }
        continue;
      }
      for (const solver of solvers) {
        const activity = await solver.tick();
        for (const row of activity) console.log(`  ${row.action} ${row.detail}`);
      }
    } catch (error) {
      console.log(`${item.label} error: ${(error as Error).message}`);
    }
  }

  const count = await seeder.publicClient.readContract({
    address: seeder.addresses.intentRegistry!,
    abi: [{ type: "function", name: "intentCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "intentCount",
  });
  console.log(`done. registry intentCount=${count}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
