import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import {
  IntentOSClient,
  IntentStatus,
  explainDraft,
  formatAmount,
  loadDeployment,
  parseIntent,
  parseIntentDraft,
  statusLabel,
  verifyDraftAgainstRecord,
  type IntentDraft,
} from "@intentos/sdk";
import { Coordinator } from "@intentos/solver-core";
import { decode, encode } from "./json.js";
import { Mempool, type PooledIntent } from "./mempool.js";
import { HttpError, Router } from "./server.js";

/**
 * The IntentOS coordinator service.
 *
 * It does three jobs, none of which give it power over a user's funds: it turns requests into
 * validated intents, it publishes the drafts behind onchain commitments so solvers can serve
 * them, and it closes auctions on behalf of agents that would rather not stay online. The last
 * of those is backed by a bond anyone can slash — see IntentRegistry.challengeSelection.
 */

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const deployment = loadDeployment(process.env.INTENTOS_NETWORK);
  const rpcUrl = process.env.INTENTOS_RPC;
  const port = Number(process.env.API_PORT ?? 8787);

  const reader = new IntentOSClient({ deployment, rpcUrl });
  const mempool = new Mempool(process.env.INTENTOS_MEMPOOL ?? join(here, "..", ".mempool.json"));

  // The auctioneer key is optional: without it the service still parses and publishes intents,
  // and owners close their own auctions.
  const auctioneerKey = process.env.COORDINATOR_PRIVATE_KEY as Hex | undefined;
  const coordinator = auctioneerKey
    ? new Coordinator({
        client: new IntentOSClient({ deployment, rpcUrl, privateKey: auctioneerKey }),
        log: (message) => console.log(`[coordinator] ${message}`),
      })
    : undefined;

  const router = new Router({ staticDir: join(here, "..", "public"), serialize: encode, parse: decode });

  router.get("/health", () => ({ ok: true, network: deployment.network, chainId: deployment.chainId }));

  router.get("/api/deployment", () => ({
    network: deployment.network,
    chainId: deployment.chainId,
    contracts: deployment.contracts,
    routers: deployment.routers,
    assets: reader.catalog.all(),
    coordinator: coordinator ? "active" : "disabled",
    aiParser: process.env.ANTHROPIC_API_KEY ? "claude" : "grammar",
  }));

  /** Parse a request into a draft without submitting anything. */
  router.post("/api/parse", async ({ body }) => {
    const { prompt, recipient } = expect(body, ["prompt", "recipient"]);
    const parsed = await parseIntent(String(prompt), {
      catalog: reader.catalog,
      recipient: recipient as Address,
      now: await reader.chainNow(),
      quote: makeQuoter(reader),
    });

    return {
      draft: parsed.draft,
      spec: parsed.spec,
      parser: parsed.parser,
      model: parsed.model,
      fallbackReason: parsed.fallbackReason,
      assumptions: parsed.assumptions,
      clarifications: parsed.clarifications,
      explanation: explainDraft(parsed.draft, { catalog: reader.catalog }),
    };
  });

  /**
   * Publish a submitted intent so solvers can see what they are being asked to serve.
   * The draft is checked against the onchain commitment before it is accepted, so the pool
   * cannot be filled with drafts nobody could settle.
   */
  router.post("/api/intents", async ({ body }) => {
    const { intentId, draft } = expect(body, ["intentId", "draft"]);
    const validated = parseIntentDraft(draft) as IntentDraft;

    const record = await reader.getIntent(intentId as Hex);
    if (record.status === IntentStatus.NONE) throw new HttpError(404, "that intent is not onchain");

    const verification = verifyDraftAgainstRecord(validated, record, intentId as Hex);
    if (!verification.ok) {
      throw new HttpError(400, `draft does not match the commitment: ${verification.problems.join("; ")}`);
    }

    const pooled: PooledIntent = {
      intentId: intentId as Hex,
      draft: validated,
      owner: record.owner as Hex,
      submittedAt: Date.now(),
      prompt: validated.metadata.prompt,
      source: validated.metadata.source,
      explanation: explainDraft(validated, { catalog: reader.catalog }),
      txHash: (body as any).txHash,
    };
    mempool.add(pooled);
    return { published: true, intentId };
  });

  router.get("/api/intents", async ({ query }) => {
    const limit = Number(query.get("limit") ?? 50);
    const pooled = mempool.list(limit);
    return { intents: await Promise.all(pooled.map((intent) => describe(reader, intent))) };
  });

  router.get("/api/intents/:id", async ({ params }) => {
    const pooled = mempool.get(params.id as Hex);
    if (!pooled) throw new HttpError(404, "unknown intent");
    const described = await describe(reader, pooled);
    return { ...described, draft: pooled.draft, explanation: pooled.explanation };
  });

  /** The solver feed: open intents with their drafts, oldest deadline first. */
  router.get("/api/feed", async () => {
    const now = BigInt(await reader.chainNow());
    const open: { intentId: Hex; draft: IntentDraft }[] = [];

    for (const pooled of mempool.list(200)) {
      const record = await reader.getIntent(pooled.intentId);
      const servable =
        record.status === IntentStatus.OPEN ||
        (record.status === IntentStatus.SELECTED && record.deadline > now);
      if (servable) open.push({ intentId: pooled.intentId, draft: pooled.draft });
    }
    return { intents: open };
  });

  router.get("/api/solvers", async () => {
    const addresses = await reader.listSolvers();
    const solvers = await Promise.all(
      addresses.map(async (address) => {
        const record = await reader.getSolver(address);
        return {
          address,
          reputationBps: record.reputationBps,
          fulfilled: record.fulfilled,
          failed: record.failed,
          bond: record.bond,
          notionalSettled: record.notionalSettled,
          metadataURI: record.metadataURI,
        };
      }),
    );
    return { solvers: solvers.sort((a, b) => b.reputationBps - a.reputationBps) };
  });

  router.get("/api/rwa", async () => {
    const assets = await Promise.all(
      reader.catalog.tradable().map(async (asset) => {
        const attestation = await reader.attestationOf(asset.address);
        return {
          symbol: asset.symbol,
          address: asset.address,
          attested: await reader.isAttested(asset.address),
          assetRef: attestation.assetRef,
          documentURI: attestation.documentURI,
          attestedAt: Number(attestation.attestedAt),
          reviewBy: Number(attestation.reviewBy),
        };
      }),
    );
    return { assets };
  });

  router.post("/api/intents/:id/close", async ({ params }) => {
    if (!coordinator) throw new HttpError(503, "this service has no auctioneer key configured");
    const pooled = mempool.get(params.id as Hex);
    if (!pooled) throw new HttpError(404, "unknown intent");
    return coordinator.close(pooled.intentId, pooled.draft);
  });

  router.listen(port, () => {
    console.log(`\nIntentOS coordinator on http://localhost:${port}`);
    console.log(`  network    ${deployment.network} (chain ${deployment.chainId})`);
    console.log(`  parser     ${process.env.ANTHROPIC_API_KEY ? "Claude" : "grammar (no ANTHROPIC_API_KEY set)"}`);
    console.log(`  auctioneer ${coordinator ? "active" : "disabled (set COORDINATOR_PRIVATE_KEY)"}`);
    console.log(`  pool       ${mempool.size()} intent(s)\n`);
  });

  if (coordinator) startAuctionLoop(reader, coordinator, mempool);
}

/** Close every auction that is ready. Runs on a timer so agents need not stay online. */
function startAuctionLoop(reader: IntentOSClient, coordinator: Coordinator, mempool: Mempool): void {
  const tick = async () => {
    coordinator.refresh();
    for (const pooled of mempool.list(100)) {
      try {
        const record = await reader.getIntent(pooled.intentId);
        if (record.status !== IntentStatus.OPEN) continue;
        await coordinator.close(pooled.intentId, pooled.draft);
      } catch (error) {
        console.error(`[coordinator] ${pooled.intentId.slice(0, 10)}…: ${(error as Error).message}`);
      }
    }
  };
  setInterval(() => void tick(), 2_000);
}

/** An intent as the dashboard wants it: the commitment, its live status, and its bids. */
async function describe(reader: IntentOSClient, pooled: PooledIntent) {
  const record = await reader.getIntent(pooled.intentId);
  const bids = await reader.getBids(pooled.intentId);
  const inputAsset = reader.catalog
    .all()
    .find((a) => a.address.toLowerCase() === pooled.draft.outcome.inputToken.toLowerCase());

  return {
    intentId: pooled.intentId,
    owner: record.owner,
    status: record.status,
    statusLabel: statusLabel(record.status),
    kind: pooled.draft.outcome.kind,
    prompt: pooled.prompt,
    source: pooled.source,
    summary: pooled.draft.metadata.summary,
    explanation: pooled.explanation,
    submittedAt: pooled.submittedAt,
    auctionEndsAt: Number(record.auctionEndsAt),
    deadline: Number(record.deadline),
    selectedSolver: record.selectedSolver,
    notional: inputAsset
      ? `${formatAmount(pooled.draft.outcome.inputAmount, inputAsset.decimals, 2)} ${inputAsset.symbol}`
      : undefined,
    legs: pooled.draft.outcome.legs.map((leg) => ({
      symbol: symbolOf(reader, leg.token),
      weightBps: leg.weightBps,
      minOut: leg.minOut,
    })),
    exits: pooled.draft.outcome.exits.map((exit) => ({
      symbol: symbolOf(reader, exit.token),
      amountIn: exit.amountIn,
    })),
    policy: {
      maxFeeBps: pooled.draft.policy.maxFeeBps,
      minReputationBps: pooled.draft.policy.minReputationBps,
      requireRwaAttested: pooled.draft.policy.requireRwaAttested,
      allowlisted: pooled.draft.policy.tokenAllowlist.length > 0,
    },
    bids: bids.map((bid) => ({
      bidId: bid.bidId,
      solver: bid.solver,
      feeBps: bid.feeBps,
      etaSeconds: bid.etaSeconds,
      withdrawn: bid.withdrawn,
      guaranteedOut: bid.guaranteedOut,
    })),
  };
}

function symbolOf(reader: IntentOSClient, token: string): string {
  return (
    reader.catalog.all().find((a) => a.address.toLowerCase() === token.toLowerCase())?.symbol ??
    `${token.slice(0, 6)}…`
  );
}

/** Live quotes so parsed intents carry real floors rather than open ones. */
function makeQuoter(reader: IntentOSClient) {
  const routers = reader.deployment.routers;
  return async (tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> => {
    let best = 0n;
    for (const router of routers) {
      try {
        const amounts = (await reader.publicClient.readContract({
          address: router.address,
          abi: QUOTE_ABI,
          functionName: "getAmountsOut",
          args: [amountIn, [tokenIn, tokenOut]],
        })) as readonly bigint[];
        const out = amounts[amounts.length - 1]!;
        if (out > best) best = out;
      } catch {
        // Venue does not list the pair.
      }
    }
    if (best === 0n) throw new Error("no venue prices this leg");
    return best;
  };
}

const QUOTE_ABI = [
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
] as const;

function expect(body: unknown, keys: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new HttpError(400, "expected a JSON object");
  const record = body as Record<string, unknown>;
  const missing = keys.filter((key) => record[key] === undefined);
  if (missing.length > 0) throw new HttpError(400, `missing: ${missing.join(", ")}`);
  return record;
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
});
