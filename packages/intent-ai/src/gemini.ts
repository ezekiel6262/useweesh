import type { AssetCatalog } from "./catalog.js";
import { intentSpecSchema, type IntentSpec } from "./spec.js";
import { LlmUnavailableError } from "./llm.js";

/**
 * Gemini parser.
 *
 * Same contract as Grok/Claude: fill an IntentSpec in tickers, decimals and percentages.
 * The compiler still resolves symbols, so a hallucinated ticker cannot become a transaction.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export function hasGeminiCredentials(apiKey?: string): boolean {
  return Boolean(
    apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY,
  );
}

export interface GeminiParserOptions {
  apiKey?: string;
  model?: string;
}

export async function parseWithGemini(
  prompt: string,
  catalog: AssetCatalog,
  options: GeminiParserOptions = {},
): Promise<{ spec: IntentSpec; model: string }> {
  const apiKey =
    options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new LlmUnavailableError("no GEMINI_API_KEY configured");

  const configured = options.model ?? process.env.INTENTOS_AI_MODEL;
  const model = configured?.startsWith("gemini") ? configured : DEFAULT_GEMINI_MODEL;
  const chainName = process.env.INTENTOS_CHAIN_NAME ?? "X Layer";
  const assets = catalog
    .all()
    .map((a) => `- ${a.symbol}${a.aliases.length ? ` (also written ${a.aliases.join(", ")})` : ""} — ${a.kind}`)
    .join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [
          {
            text: `You translate what someone wants into an IntentOS intent specification as JSON.

IntentOS runs on ${chainName}. Reply with a single JSON object, no markdown.

JSON shape:
{
  "action": "swap" | "buy_basket" | "rebalance" | "onboard_rwa",
  "inputSymbol": string,
  "inputAmount": string | null,
  "targets": [{ "symbol": string, "weightPercent": number | null }],
  "exits": [{ "symbol": string, "amount": string }],
  "maxSlippagePercent": number,
  "maxFeePercent": number | null,
  "requireRwaAttested": boolean,
  "restrictToDeclaredAssets": boolean,
  "minSolverReputationPercent": number | null,
  "ttlMinutes": number | null,
  "recurrence": { "everySeconds": number, "maxRuns": number | null } | null,
  "conditions": [{ "kind": "price"|"drawdown"|"volatility"|"time"|"portfolio-drift", "subject": string|null, "operator": "lt"|"lte"|"gt"|"gte", "value": number, "window": string|null }],
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
- action "swap" for one target, "buy_basket" for several, "rebalance" when selling to fund buys, "onboard_rwa" to bring an asset onchain.
- requireRwaAttested when they want attested / real-world / xStocks integrity.`,
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new LlmUnavailableError(`Gemini parse failed (${response.status}): ${body.slice(0, 280)}`);
  }

  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  const content = payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  if (!content) {
    throw new LlmUnavailableError(payload.error?.message ?? "Gemini did not return a usable intent specification");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LlmUnavailableError("Gemini returned non-JSON");
  }

  return { spec: intentSpecSchema.parse(parsed), model };
}
