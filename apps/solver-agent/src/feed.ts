import type { Hex } from "viem";
import type { IntentDraft, IntentFeed } from "./types.js";

/**
 * A solver's view of the intent mempool, over HTTP.
 *
 * The coordinator publishes drafts; this reads them. Nothing here trusts the response — the
 * solver checks each draft against the onchain commitment before it plans anything, so a
 * coordinator that served a doctored draft would only be wasting its own credibility.
 */
export class HttpIntentFeed implements IntentFeed {
  constructor(
    private readonly apiUrl: string,
    private readonly observationsUrl?: string,
  ) {}

  async openIntents(): Promise<{ intentId: Hex; draft: IntentDraft }[]> {
    const response = await fetch(`${this.apiUrl}/api/feed`);
    if (!response.ok) throw new Error(`feed returned ${response.status}`);
    const body = decode<{ intents: { intentId: Hex; draft: IntentDraft }[] }>(await response.text());
    return body.intents;
  }

  async observations(): Promise<Record<string, number>> {
    if (!this.observationsUrl) return {};
    try {
      const response = await fetch(this.observationsUrl);
      return response.ok ? ((await response.json()) as Record<string, number>) : {};
    } catch {
      // An intent with unmet conditions is skipped, so a missing price feed fails closed.
      return {};
    }
  }
}

/** Mirror of the service's bigint-tagged JSON. */
function decode<T>(text: string): T {
  return JSON.parse(text, (_key, item) =>
    typeof item === "string" && item.startsWith("n:") ? BigInt(item.slice(2)) : item,
  ) as T;
}
