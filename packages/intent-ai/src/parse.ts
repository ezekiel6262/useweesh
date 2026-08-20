import type { Address, IntentDraft } from "@intentos/intent-schema";
import type { AssetCatalog } from "./catalog.js";
import { compileSpec, type CompileOptions } from "./compile.js";
import { parseWithGrammar } from "./grammar.js";
import { LlmUnavailableError, hasAnthropicCredentials, parseWithLlm, type LlmParserOptions } from "./llm.js";
import { hasGeminiCredentials, parseWithGemini } from "./gemini.js";
import { hasGrokCredentials, parseWithGrok } from "./grok.js";
import type { IntentSpec } from "./spec.js";

/**
 * The entry point the API, the SDK and the demos all use.
 *
 * Gemini parses the request when a Google key is configured; Grok and Claude are fallbacks.
 * The deterministic grammar takes over when no model is configured, or when the model call fails.
 * Either way the spec goes through the same compiler and the same validation.
 */

export interface ParseOptions extends Omit<CompileOptions, "prompt" | "source">, LlmParserOptions {
  catalog: AssetCatalog;
  recipient: Address;
  /** Force a parser instead of preferring the model when credentials exist. */
  prefer?: "auto" | "llm" | "grammar";
}

export interface ParsedIntent {
  draft: IntentDraft;
  spec: IntentSpec;
  /** Which parser produced the spec, and the model when one was used. */
  parser: "gemini" | "grok" | "claude" | "grammar";
  model?: string;
  /** Set when the model was meant to run but could not. */
  fallbackReason?: string;
  assumptions: string[];
  clarifications: string[];
}

export async function parseIntent(prompt: string, options: ParseOptions): Promise<ParsedIntent> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("nothing to parse");

  const wantsLlm =
    options.prefer === "llm" ||
    (options.prefer !== "grammar" &&
      (Boolean(options.client) ||
        hasGeminiCredentials() ||
        hasGrokCredentials() ||
        hasAnthropicCredentials(options.apiKey)));

  let spec: IntentSpec | undefined;
  let parser: ParsedIntent["parser"] = "grammar";
  let model: string | undefined;
  let fallbackReason: string | undefined;

  if (wantsLlm) {
    try {
      if (hasGeminiCredentials() && !options.client) {
        const result = await parseWithGemini(trimmed, options.catalog);
        spec = result.spec;
        model = result.model;
        parser = "gemini";
      } else if (hasGrokCredentials() && !options.client) {
        const result = await parseWithGrok(trimmed, options.catalog);
        spec = result.spec;
        model = result.model;
        parser = "grok";
      } else {
        const result = await parseWithLlm(trimmed, options.catalog, options);
        spec = result.spec;
        model = result.model;
        parser = "claude";
      }
    } catch (error) {
      if (options.prefer === "llm") throw error;
      fallbackReason =
        error instanceof LlmUnavailableError ? error.message : `model parse failed: ${(error as Error).message}`;
    }
  }

  if (!spec) {
    spec = parseWithGrammar(trimmed, options.catalog).spec;
  }

  const draft = await compileSpec(spec, {
    ...options,
    prompt: trimmed,
    source: parser === "grammar" ? "grammar" : `${parser}:${model}`,
  });

  return {
    draft,
    spec,
    parser,
    model,
    fallbackReason,
    assumptions: spec.assumptions,
    clarifications: spec.clarifications,
  };
}
