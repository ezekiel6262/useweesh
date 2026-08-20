import type { AssetCatalog } from "./catalog.js";
import { intentSpecSchema, type IntentSpec } from "./spec.js";
import { LlmUnavailableError } from "./llm.js";

/**
 * Grok (xAI / SpaceXAI) parser.
 *
 * Same job as the Claude path: fill an IntentSpec in tickers, decimals and percentages.
 * The compiler still resolves symbols, so a hallucinated ticker cannot become a transaction.
 */

export const DEFAULT_GROK_MODEL = "grok-4.5";
const GROK_URL = "https://api.x.ai/v1/chat/completions";

export function hasGrokCredentials(apiKey?: string): boolean {
  return Boolean(apiKey ?? process.env.XAI_API_KEY);
}

export interface GrokParserOptions {
  apiKey?: string;
  model?: string;
}

export async function parseWithGrok(
  prompt: string,
  catalog: AssetCatalog,
  options: GrokParserOptions = {},
): Promise<{ spec: IntentSpec; model: string }> {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) throw new LlmUnavailableError("no XAI_API_KEY configured");

  const model = options.model ?? process.env.INTENTOS_AI_MODEL ?? DEFAULT_GROK_MODEL;
  const chainName = process.env.INTENTOS_CHAIN_NAME ?? "X Layer";
  const assets = catalog
    .all()
    .map((a) => `- ${a.symbol}${a.aliases.length ? ` (also written ${a.aliases.join(", ")})` : ""} — ${a.kind}`)
    .join("\n");

  const response = await fetch(GROK_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You translate what someone wants into an IntentOS intent specification as JSON.

IntentOS runs on ${chainName}. Reply with a single JSON object, no markdown.

JSON shape:
{
  "action": "swap" | "buy_basket" | "rebalance" | "onboard_rwa" | "pay",
  "inputSymbol": string,
  "inputAmount": string | null,
  "targets": [{ "symbol": string, "weightPercent": number | null }],
  "exits": [{ "symbol": string, "amount": string }],
  "maxSlippagePercent": number,
  "maxFeePercent": number | null,
  "requireRwaAttested": boolean,
  "requireCompliant": boolean,
  "sponsorGas": boolean,
  "payTo": string | null,
  "restrictToDeclaredAssets": boolean,
  "minSolverReputationPercent": number | null,
  "ttlMinutes": number | null,
  "recurrence": { "everySeconds": number, "maxRuns": number | null } | null,
  "conditions": [{ "kind": "price"|"drawdown"|"volatility"|"time"|"portfolio-drift"|"volume"|"funding", "subject": string|null, "operator": "lt"|"lte"|"gt"|"gte", "value": number, "window": string|null }],
  "summary": string,
  "assumptions": string[],
  "clarifications": string[]
}

Assets available:
${assets}

Rules:
- Use only those tickers. Unknown names go in clarifications, never as targets.
- Amounts are decimal strings in whole units ("10000", "2.5"), never wei.
- Equal split → every weightPercent is null.
- action "swap" for one target, "buy_basket" for several, "rebalance" when selling to fund buys, "onboard_rwa" to bring an asset onchain, "pay" for a stablecoin payment.
- requireRwaAttested for attested / RWA / xStocks integrity. requireCompliant for KYB'd solvers. sponsorGas when they ask to go gasless. payTo is the 0x recipient on a payment.`,
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new LlmUnavailableError(`Grok parse failed (${response.status}): ${body.slice(0, 280)}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new LlmUnavailableError("Grok did not return a usable intent specification");

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LlmUnavailableError("Grok returned non-JSON");
  }

  return { spec: intentSpecSchema.parse(parsed), model };
}
