import {
  IntentAgent,
  IntentOSClient,
  IntentStatus,
  formatAmount,
  loadDeployment,
  sleep,
  statusLabel,
  type IntentDraft,
} from "@intentos/sdk";
import { AGGRESSIVE, CONSERVATIVE, Coordinator, Solver, StaticIntentFeed } from "@intentos/solver-core";
import { LOCAL_KEYS } from "./accounts.js";
import { good, heading, portfolioDelta, quote, step, table, warn } from "./report.js";

/**
 * The IntentOS loop, end to end, on a live chain.
 *
 * A user states an outcome in a sentence. It is parsed into a committed intent, two solvers with
 * different strategies compete to serve it, the coordinator picks a winner it can be slashed for
 * picking badly, and the winner settles onchain under the user's own constraints. Nothing here
 * is mocked: every number printed was read back from the chain after the transaction landed.
 *
 *   npm run chain          # terminal 1
 *   npm run deploy:local   # terminal 2
 *   npm run demo
 */

const AUCTION_SECONDS = 12;

async function main() {
  const deployment = loadDeployment(process.env.INTENTOS_NETWORK ?? "localhost");
  const rpcUrl = process.env.INTENTOS_RPC ?? "http://127.0.0.1:8545";

  heading("IntentOS — an Intent Operating System for X Layer");
  step(`network ${deployment.network} (chain ${deployment.chainId}) via ${rpcUrl}`);
  step(`registry ${deployment.contracts.intentRegistry}`);
  step(`assets   ${Object.keys(deployment.tokens).join(", ")}`);
  step(`venues   ${deployment.routers.map((r) => r.name).join(", ")}`);

  const user = new IntentOSClient({ deployment, rpcUrl, privateKey: LOCAL_KEYS.user });
  const agent = new IntentAgent(user);
  const feed = new StaticIntentFeed();

  const solvers = [
    new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: LOCAL_KEYS.solverA }),
      feed,
      strategy: AGGRESSIVE,
      log: (message) => step(message),
    }),
    new Solver({
      client: new IntentOSClient({ deployment, rpcUrl, privateKey: LOCAL_KEYS.solverB }),
      feed,
      strategy: CONSERVATIVE,
      log: (message) => step(message),
    }),
  ];

  const coordinator = new Coordinator({
    client: new IntentOSClient({ deployment, rpcUrl, privateKey: LOCAL_KEYS.coordinator }),
    log: (message) => step(message),
  });

  heading("Solver network");
  for (const solver of solvers) {
    await solver.ensureRegistered(10n ** 16n);
    const record = await solver.client.getSolver(solver.address);
    step(
      `${solver.strategy.name.padEnd(13)} ${solver.address.slice(0, 10)}…  ` +
        `reputation ${(record.reputationBps / 100).toFixed(0)}%  bond ${formatAmount(record.bond, 18, 3)}`,
    );
  }

  await runScenario({
    title: "A four-asset xStocks basket, stated in one sentence",
    request:
      "Allocate 10,000 USDT across TSLA, NVDA, AAPL and SPY xStocks with equal weight, " +
      "max 0.5% slippage, only attested assets, fees under 0.25%",
    agent,
    user,
    feed,
    solvers,
    coordinator,
  });

  await runScenario({
    title: "Rotating an existing position, atomically",
    request: "Rebalance: sell 3 TSLA and 4 NVDA, then buy AAPL and SPY equally with 1% max slippage",
    agent,
    user,
    feed,
    solvers,
    coordinator,
  });

  heading("Solver standings");
  const rows: Record<string, string>[] = [];
  for (const solver of solvers) {
    const record = await solver.client.getSolver(solver.address);
    rows.push({
      solver: solver.strategy.name,
      reputation: `${(record.reputationBps / 100).toFixed(0)}%`,
      fulfilled: String(record.fulfilled),
      failed: String(record.failed),
      routed: `${formatAmount(record.notionalSettled, 6, 0)} USDT`,
    });
  }
  table(rows);

  console.log();
  good("The loop closed: stated outcome, competing solvers, verified settlement — all on one chain.");
  console.log();
}

interface ScenarioArgs {
  title: string;
  request: string;
  agent: IntentAgent;
  user: IntentOSClient;
  feed: StaticIntentFeed;
  solvers: Solver[];
  coordinator: Coordinator;
}

async function runScenario(args: ScenarioArgs): Promise<void> {
  const { agent, user, feed, solvers, coordinator } = args;

  heading(args.title);
  console.log(`  "${args.request}"\n`);

  const before = await agent.portfolio();

  // 1. Parse. Claude does this when a key is configured; the grammar parser otherwise.
  const declaration = await agent.declare(args.request, {
    auctionSeconds: AUCTION_SECONDS,
    ttlSeconds: 600,
    quote: makeQuoteFn(user),
  });

  step(`parsed by ${declaration.parsed.parser}${declaration.parsed.model ? ` (${declaration.parsed.model})` : ""}`);
  if (declaration.parsed.fallbackReason) {
    warn(`model unavailable — ${declaration.parsed.fallbackReason}`);
  }
  quote(declaration.explanation);

  if (!declaration.submitted) {
    warn(`held back: ${(declaration.heldFor ?? []).join("; ")}`);
    return;
  }

  const intentId = declaration.intentId!;
  const draft = declaration.draft;
  good(`intent ${intentId.slice(0, 14)}… committed onchain`);

  // 2. Publish to the solver feed and let the auction run.
  feed.add(intentId, draft);
  console.log();
  step("solvers are bidding…");
  // Chain time, not wall time: the auction window is enforced against block timestamps.
  await runUntil(solvers, async () => (await user.chainNow()) > Number(draft.auctionEndsAt), 1_200);

  const bids = await agent.bidsFor(intentId);
  if (bids.length === 0) {
    warn("no solver bid on this intent");
    feed.remove(intentId);
    return;
  }

  table(
    bids.map((bid) => ({
      solver: solverName(solvers, bid.solver),
      fee: `${(bid.feeBps / 100).toFixed(2)}%`,
      eta: `${bid.etaSeconds}s`,
      guarantees: bid.guaranteedOut.map((g, i) => `${formatAmount(g, 18, 2)} ${legSymbol(user, draft, i)}`).join("  "),
    })),
  );

  // 3. Close the auction.
  const report = await coordinator.close(intentId, draft);
  if (!report.selected) {
    warn(`no winner: ${report.skipped}`);
    feed.remove(intentId);
    return;
  }
  good(`winner: ${solverName(solvers, report.selected.solver)} at ${(report.selected.feeBps / 100).toFixed(2)}% fee`);

  // 4. The winner settles. Everything the user declared is enforced by the contract.
  await runUntil(solvers, async () => (await user.getIntent(intentId)).status !== IntentStatus.SELECTED, 1_000, 20);

  const record = await user.getIntent(intentId);
  feed.remove(intentId);

  if (record.status !== IntentStatus.FULFILLED) {
    warn(`intent ended ${statusLabel(record.status)}`);
    return;
  }

  good("settled onchain");
  console.log();
  portfolioDelta(before, await agent.portfolio(), user.catalog);
}

/** Run every solver's tick loop until `done`, or until the attempt budget runs out. */
async function runUntil(
  solvers: Solver[],
  done: () => boolean | Promise<boolean>,
  intervalMs: number,
  maxTicks = 30,
): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await Promise.all(solvers.map((solver) => solver.tick().catch(() => [])));
    if (await done()) return;
    await sleep(intervalMs);
  }
}

function makeQuoteFn(client: IntentOSClient) {
  const router = client.deployment.routers[0]!.address;
  return async (tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint) => {
    const amounts = (await client.publicClient.readContract({
      address: router,
      abi: [
        {
          type: "function",
          name: "getAmountsOut",
          stateMutability: "view",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "path", type: "address[]" },
          ],
          outputs: [{ name: "amounts", type: "uint256[]" }],
        },
      ] as const,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    })) as readonly bigint[];
    return amounts[amounts.length - 1]!;
  };
}

function solverName(solvers: Solver[], address: string): string {
  return solvers.find((s) => s.address.toLowerCase() === address.toLowerCase())?.strategy.name ?? address.slice(0, 10);
}

function legSymbol(client: IntentOSClient, draft: IntentDraft, index: number): string {
  const token = draft.outcome.legs[index]?.token;
  return client.catalog.all().find((a) => a.address.toLowerCase() === token?.toLowerCase())?.symbol ?? "?";
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
});
