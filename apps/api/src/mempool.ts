import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import type { IntentDraft } from "@intentos/sdk";
import { decode, encode } from "./json.js";

/**
 * The intent mempool.
 *
 * Only the hashes of an intent go onchain, so the outcome itself has to reach solvers some other
 * way. This is that channel: a public, append-only record of the drafts behind the commitments.
 * Nothing here is trusted — a solver checks every draft against the registry before bidding, and
 * a draft that does not match its commitment is simply unservable.
 */

export interface PooledIntent {
  intentId: Hex;
  draft: IntentDraft;
  owner: Hex;
  submittedAt: number;
  prompt?: string;
  explanation?: string;
  /** How the intent was produced, e.g. "claude:claude-opus-5" or "grammar". */
  source?: string;
  txHash?: Hex;
}

export class Mempool {
  private readonly intents = new Map<Hex, PooledIntent>();

  constructor(private readonly persistPath?: string) {
    if (persistPath && existsSync(persistPath)) {
      try {
        const stored = decode<PooledIntent[]>(readFileSync(persistPath, "utf8"));
        for (const intent of stored) this.intents.set(intent.intentId, intent);
      } catch {
        // A corrupt pool file is not worth failing to start over; solvers re-learn from chain.
      }
    }
  }

  add(intent: PooledIntent): void {
    this.intents.set(intent.intentId, intent);
    this.persist();
  }

  get(intentId: Hex): PooledIntent | undefined {
    return this.intents.get(intentId);
  }

  /** Newest first — the dashboard and solver feeds both want recent intents. */
  list(limit = 100): PooledIntent[] {
    return [...this.intents.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, limit);
  }

  size(): number {
    return this.intents.size;
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, encode([...this.intents.values()]));
    } catch {
      // Persistence is a convenience; losing it costs a restart's worth of history, not funds.
    }
  }
}
