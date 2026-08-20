import type { IncomingMessage, ServerResponse } from "node:http";
import {
  catalogFromDeployment,
  explainDraft,
  parseIntent,
  type IntentSpec,
} from "@intentos/intent-ai";
import { hashOutcome, hashPolicy, type Address } from "@intentos/intent-schema";
import { loadUniverse } from "../src/universe.js";

/**
 * The hosted IntentOS playground.
 *
 * It does the one thing that is genuinely useful without a chain attached: turn a sentence into
 * the exact intent that would be committed, and show what settlement would then enforce. It
 * never signs, submits or holds anything — the closest it gets to the chain is computing the
 * hashes that would go into the registry.
 */

const { deployment, live } = loadUniverse();
const catalog = catalogFromDeployment(deployment);

// A preview parse has no recipient yet; the address only affects where outputs would land.
const PLAYGROUND_RECIPIENT = "0x0000000000000000000000000000000000000001" as Address;

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") return void response.writeHead(204).end();

  try {
    const path = url.pathname.replace(/^\/api/, "") || "/";

    if (path === "/status") {
      return send(response, 200, {
        ok: true,
        mode: live ? "live" : "playground",
        network: deployment.network,
        chainId: deployment.chainId,
        // Claude parses when a key is configured; the grammar covers everything otherwise.
        parser: process.env.ANTHROPIC_API_KEY ? "claude" : "grammar",
        assets: catalog.all().map((asset) => ({ symbol: asset.symbol, kind: asset.kind })),
      });
    }

    if (path === "/parse" && request.method === "POST") {
      const body = (await readJson(request)) as { prompt?: unknown };
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) return send(response, 400, { error: "give me something to parse" });
      if (prompt.length > 2_000) return send(response, 413, { error: "that request is too long" });

      return send(response, 200, await parse(prompt));
    }

    return send(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
  } catch (error) {
    // Unknown tickers and malformed requests are the common case here, and they are the user's
    // answer rather than a server fault — surface the message instead of a blank 500.
    return send(response, 400, { error: (error as Error).message });
  }
}

async function parse(prompt: string) {
  const parsed = await parseIntent(prompt, {
    catalog,
    recipient: PLAYGROUND_RECIPIENT,
    // No chain here, so no live quotes: floors stay open and the winning solver's own auction
    // guarantee is what would bind each leg. Said plainly in the response rather than implied.
    now: Math.floor(Date.now() / 1000),
  });

  const { draft } = parsed;
  return {
    parser: parsed.parser,
    model: parsed.model,
    fallbackReason: parsed.fallbackReason,
    explanation: explainDraft(draft, { catalog }),
    spec: serialise(parsed.spec),
    assumptions: parsed.assumptions,
    clarifications: parsed.clarifications,
    quotesAvailable: false,
    outcome: {
      kind: draft.outcome.kind,
      inputSymbol: symbolOf(draft.outcome.inputToken),
      inputAmount: draft.outcome.inputAmount.toString(),
      maxSlippageBps: draft.outcome.maxSlippageBps,
      legs: draft.outcome.legs.map((leg) => ({
        symbol: symbolOf(leg.token),
        weightBps: leg.weightBps,
        minOut: leg.minOut.toString(),
      })),
      exits: draft.outcome.exits.map((exit) => ({
        symbol: symbolOf(exit.token),
        amountIn: exit.amountIn.toString(),
      })),
    },
    policy: {
      maxNotional: draft.policy.maxNotional.toString(),
      maxFeeBps: draft.policy.maxFeeBps,
      minReputationBps: draft.policy.minReputationBps,
      requireRwaAttested: draft.policy.requireRwaAttested,
      allowlist: draft.policy.tokenAllowlist.map(symbolOf),
    },
    timing: {
      auctionSeconds: Number(draft.auctionEndsAt) - (draft.metadata.createdAt ?? Number(draft.auctionEndsAt)),
      settleSeconds: Number(draft.deadline - draft.auctionEndsAt),
    },
    metadata: {
      schedule: draft.metadata.schedule ?? null,
      conditions: draft.metadata.conditions ?? [],
    },
    // What would actually be written to IntentRegistry — the commitment, not the contents.
    commitment: {
      outcomeHash: hashOutcome(draft.outcome),
      policyHash: hashPolicy(draft.policy),
    },
  };
}

function symbolOf(token: string): string {
  return (
    catalog.all().find((asset) => asset.address.toLowerCase() === token.toLowerCase())?.symbol ??
    `${token.slice(0, 6)}…`
  );
}

function serialise(spec: IntentSpec): unknown {
  return JSON.parse(JSON.stringify(spec, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("expected a JSON body"));
      }
    });
    request.on("error", reject);
  });
}
