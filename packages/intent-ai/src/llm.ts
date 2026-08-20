import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AssetCatalog } from "./catalog.js";
import { intentSpecSchema, type IntentSpec } from "./spec.js";

/**
 * The model-backed half of intent parsing.
 *
 * Claude reads the request and fills in an IntentSpec through structured outputs, so the reply is
 * schema-shaped rather than prose that needs scraping. It is asked for tickers, decimals and
 * percentages only — the compiler resolves those against the onchain catalog — and the spec it
 * returns is validated before anything downstream sees it.
 */

export const DEFAULT_MODEL = "claude-opus-5";

export interface LlmParserOptions {
  apiKey?: string;
  model?: string;
  client?: Anthropic;
  /** Effort spent on the parse. Intent parsing is short and benefits from real reasoning. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export function hasAnthropicCredentials(apiKey?: string): boolean {
  return Boolean(apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

function systemPrompt(catalog: AssetCatalog, chainName: string): string {
  const assets = catalog
    .all()
    .map((a) => `- ${a.symbol}${a.aliases.length ? ` (also written ${a.aliases.join(", ")})` : ""} — ${a.kind}`)
    .join("\n");

  return `You translate what someone wants into an IntentOS intent specification.

IntentOS runs on ${chainName}. A user or an AI agent states an outcome; competing solvers then
work out how to reach it. Your job is only the first half: read the request and describe the
outcome precisely enough that a solver could be held to it.

Assets available on this deployment:
${assets}

Rules that matter:
- Use only the tickers listed above. If the request names something not on the list, leave it out
  of the targets and raise it in clarifications. Never invent a ticker or an address.
- Amounts are decimal strings in whole units ("10000", "2.5"), never wei and never scaled.
- Weights are percentages that add up to 100. If the user asked for an equal split, or did not
  weight the assets at all, set every weightPercent to null rather than dividing it out yourself.
- action: "swap" for one target, "buy_basket" for several, "rebalance" when existing positions
  are being sold to fund new ones, "onboard_rwa" when the point is bringing an asset onchain.
- exits are only for a rebalance: the positions being sold, with the quantity of each.
- maxSlippagePercent defaults to 1 unless the user gave a tolerance.
- Set requireRwaAttested when the user cares that the assets are genuine tokenized real-world
  assets. Set restrictToDeclaredAssets when they want the intent pinned to exactly these assets.
- Record anything you filled in yourself under assumptions. Use clarifications only for things a
  human really must answer — a missing amount, an unknown asset, a contradiction. Do not ask about
  details you were able to assume sensibly.
- summary is one plain sentence restating the outcome, the way you would confirm it back.`;
}

/** Parse a request into an IntentSpec with Claude. Throws LlmUnavailableError without credentials. */
export async function parseWithLlm(
  prompt: string,
  catalog: AssetCatalog,
  options: LlmParserOptions = {},
): Promise<{ spec: IntentSpec; model: string }> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!options.client && !hasAnthropicCredentials(apiKey)) {
    throw new LlmUnavailableError("no Anthropic credentials configured");
  }

  const client = options.client ?? new Anthropic(apiKey ? { apiKey } : {});
  const model = options.model ?? process.env.INTENTOS_AI_MODEL ?? DEFAULT_MODEL;
  const chainName = process.env.INTENTOS_CHAIN_NAME ?? "X Layer";

  const response = await client.messages.parse({
    model,
    max_tokens: 4_000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: options.effort ?? "medium",
      format: zodOutputFormat(intentSpecSchema),
    },
    system: systemPrompt(catalog, chainName),
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new LlmUnavailableError(
      `the request was declined${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ""}`,
    );
  }
  if (!response.parsed_output) {
    throw new LlmUnavailableError("the model did not return a usable intent specification");
  }

  // Validated again on the way out: what comes back is a proposal, not an instruction.
  return { spec: intentSpecSchema.parse(response.parsed_output), model };
}
