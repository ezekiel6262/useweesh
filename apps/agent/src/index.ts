import type { Address, Hex } from "viem";
import {
  IntentAgent,
  IntentOSClient,
  IntentStatus,
  formatAmount,
  loadDeployment,
  statusLabel,
  type IntentDraft,
} from "@intentos/sdk";

/**
 * The IntentOS agent CLI — what an autonomous agent does, in one command.
 *
 *   npm run agent -- "put 5,000 USDT into NVDA and AAPL, 60/40, max 0.4% slippage"
 *   npm run agent -- --dry-run "rebalance out of TSLA into SPY"
 *   npm run agent -- --history
 *   npm run agent -- --history 0xOwner
 *
 * It declares an outcome, publishes the draft so solvers can see what they are bidding on, and
 * follows the intent until it settles. No route, venue or transaction is ever named by the
 * caller: that is the solvers' job, and the contract's job is to hold them to it.
 */

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const historyOnly = argv.includes("--history");
  const request = argv.filter((arg) => !arg.startsWith("--")).join(" ").trim();

  if (!historyOnly && !request) {
    console.error(`usage: npm run agent -- [--dry-run] "<what you want to happen>"`);
    console.error(`       npm run agent -- --history [0xOwner]`);
    process.exitCode = 1;
    return;
  }

  const deployment = loadDeployment(process.env.INTENTOS_NETWORK);
  const privateKey = process.env.AGENT_PRIVATE_KEY as Hex | undefined;
  if (!privateKey && !dryRun && !historyOnly) {
    throw new Error("set AGENT_PRIVATE_KEY to submit an intent, or pass --dry-run to preview one");
  }

  const client = new IntentOSClient({
    deployment,
    rpcUrl: process.env.INTENTOS_RPC,
    // A preview needs no signer; use a throwaway address so the draft is still well formed.
    privateKey: privateKey ?? ("0x" + "11".repeat(32)) as Hex,
  });
  const agent = new IntentAgent(client);
  const apiUrl = (process.env.INTENTOS_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

  if (historyOnly) {
    const ownerArg = request.startsWith("0x") && request.length === 42 ? (request as Address) : undefined;
    const owner = ownerArg ?? (privateKey ? client.account?.address : undefined);
    if (!owner) throw new Error("pass an owner address, or set AGENT_PRIVATE_KEY");
    const rows = await agent.history(owner);
    console.log(`\nhistory for ${owner} (${rows.length})\n`);
    if (!rows.length) {
      console.log("  (none)\n");
      return;
    }
    for (const row of rows) {
      const when = row.createdAt ? new Date(Number(row.createdAt) * 1000).toISOString() : "";
      console.log(`  ${statusLabel(row.status).padEnd(14)} ${row.intentId}  ${when}  ${row.bidCount} bids`);
    }
    console.log();
    return;
  }

  console.log(`\n"${request}"\n`);

  const declaration = await agent.declare(request, {
    dryRun,
    auctionSeconds: Number(process.env.AUCTION_SECONDS ?? 15),
    ttlSeconds: Number(process.env.INTENT_TTL_SECONDS ?? 900),
    quote: makeQuoter(client),
    relayUrl: dryRun ? undefined : `${apiUrl}/api/relay`,
  });

  console.log(declaration.explanation);
  console.log(`\nparsed by ${declaration.parsed.parser}${declaration.parsed.model ? ` (${declaration.parsed.model})` : ""}`);
  for (const assumption of declaration.parsed.assumptions) console.log(`  assumed — ${assumption}`);

  if (declaration.heldFor?.length) {
    console.log(`\nnot submitted, this needs an answer first:`);
    for (const question of declaration.heldFor) console.log(`  · ${question}`);
    return;
  }
  if (!declaration.submitted) {
    console.log(`\n(dry run — nothing was submitted)\n`);
    return;
  }

  const intentId = declaration.intentId!;
  console.log(`\nintent ${intentId}`);
  console.log(`tx     ${declaration.txHash}`);

  await publish(apiUrl, intentId, declaration.draft, declaration.txHash);

  const record = await agent.track(intentId, {
    pollMs: 1_500,
    timeoutMs: Number(process.env.INTENT_TTL_SECONDS ?? 900) * 1_000,
    onUpdate: (update) => console.log(`  ${statusLabel(update.status)}`),
  });

  if (record.status !== IntentStatus.FULFILLED) {
    console.log(`\nintent ended ${statusLabel(record.status)}\n`);
    return;
  }

  console.log(`\nfulfilled by ${record.selectedSolver}\n`);
  for (const holding of await agent.portfolio()) {
    if (holding.balance === 0n) continue;
    console.log(`  ${holding.symbol.padEnd(7)} ${formatAmount(holding.balance, holding.decimals, 4)}`);
  }
  console.log();
}

/** Publish the draft behind the commitment, so solvers can see what they are serving. */
async function publish(apiUrl: string, intentId: Hex, draft: IntentDraft, txHash?: Hex): Promise<void> {
  const body = JSON.stringify({ intentId, draft, txHash }, (_key, value) =>
    typeof value === "bigint" ? `n:${value}` : value,
  );

  try {
    const response = await fetch(`${apiUrl}/api/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!response.ok) {
      const failure = (await response.json()) as { error?: string };
      console.log(`  could not publish to the mempool: ${failure.error ?? response.statusText}`);
      return;
    }
    console.log(`published to ${apiUrl}`);
  } catch {
    // An intent that no solver can see is still a valid commitment; it just will not be served.
    console.log(`  no coordinator at ${apiUrl} — solvers will not see this intent`);
  }
}

function makeQuoter(client: IntentOSClient) {
  return async (tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<bigint> => {
    let best = 0n;
    for (const router of client.deployment.routers) {
      try {
        const amounts = (await client.publicClient.readContract({
          address: router.address,
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
        const out = amounts[amounts.length - 1]!;
        if (out > best) best = out;
      } catch {
        // Not listed here.
      }
    }
    if (best === 0n) throw new Error("no venue prices this leg");
    return best;
  };
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
});
