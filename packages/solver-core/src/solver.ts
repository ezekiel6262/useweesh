import type { Address, Hex } from "viem";
import { IntentStatus, type IntentDraft } from "@intentos/intent-schema";
import { IntentOSClient, conditionsHold, verifyDraftAgainstRecord } from "@intentos/sdk";
import { planIntent, planHashOf } from "./planner.js";
import { Quoter, type Venue } from "./quotes.js";
import { BALANCED, type SolverStrategy } from "./strategy.js";

/**
 * A running solver.
 *
 * Solvers are the working half of IntentOS: they watch declared outcomes, work out how to reach
 * them, bid what they are willing to guarantee, and settle what they win. Nothing here is
 * trusted by the protocol — the bid is a promise the settlement contract enforces — so a solver
 * can be anyone's code, including an agent that also submits intents of its own.
 */

/** Where a solver learns about intents whose contents are not onchain. */
export interface IntentFeed {
  openIntents(): Promise<{ intentId: Hex; draft: IntentDraft }[]>;
  /** Price and other observations used to evaluate an intent's declared preconditions. */
  observations?(): Promise<Record<string, number>>;
}

export interface SolverOptions {
  client: IntentOSClient;
  feed: IntentFeed;
  strategy?: SolverStrategy;
  venues?: Venue[];
  /** Base asset used as the intermediate hop and as the unit of account. */
  baseToken?: Address;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface SolverActivity {
  intentId: Hex;
  action: "bid" | "declined" | "settled" | "failed" | "skipped";
  detail: string;
  at: number;
}

export class Solver {
  readonly strategy: SolverStrategy;
  readonly quoter: Quoter;
  readonly activity: SolverActivity[] = [];

  private readonly bidded = new Set<Hex>();
  private readonly settling = new Set<Hex>();
  /** Reasons already reported, so a standing decline is not repeated every tick. */
  private readonly reported = new Map<Hex, string>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: SolverOptions) {
    this.strategy = options.strategy ?? BALANCED;
    this.quoter = new Quoter({
      publicClient: options.client.publicClient,
      venues: options.venues ?? options.client.deployment.routers.map((r) => ({ name: r.name, address: r.address })),
      intermediate: options.baseToken ?? options.client.deployment.tokens.USDT,
    });
  }

  get address(): Address {
    return this.options.client.address;
  }

  /** The solver's own chain client, for callers that want its registry record or balances. */
  get client(): IntentOSClient {
    return this.options.client;
  }

  /** Register and bond, unless this solver is already active. */
  async ensureRegistered(bond: bigint, metadataURI = ""): Promise<void> {
    const existing = await this.options.client.getSolver(this.address);
    if (existing.registered) return;
    await this.options.client.registerSolver(metadataURI || `intentos://solver/${this.strategy.name}`, bond);
    this.log(`registered as a ${this.strategy.name} solver`);
  }

  /** One pass over the feed: bid on what is open, settle what has been won. */
  async tick(): Promise<SolverActivity[]> {
    const before = this.activity.length;
    const intents = await this.options.feed.openIntents();
    const observations = (await this.options.feed.observations?.()) ?? {};
    // One clock read per pass: every deadline in the protocol is in chain time, which can sit
    // well away from the machine's.
    const now = BigInt(await this.options.client.chainNow());

    for (const { intentId, draft } of intents) {
      try {
        await this.consider(intentId, draft, observations, now);
      } catch (error) {
        this.record(intentId, "declined", `error while considering: ${(error as Error).message}`);
      }
    }

    return this.activity.slice(before);
  }

  private async consider(
    intentId: Hex,
    draft: IntentDraft,
    observations: Record<string, number>,
    now: bigint,
  ): Promise<void> {
    const record = await this.options.client.getIntent(intentId);

    if (record.status === IntentStatus.SELECTED) {
      if (record.selectedSolver.toLowerCase() === this.address.toLowerCase()) {
        await this.settle(intentId, draft);
      }
      return;
    }
    if (record.status !== IntentStatus.OPEN) return;
    if (this.bidded.has(intentId)) return;
    if (now > record.auctionEndsAt) return;

    // Never bid on a draft that is not the one committed onchain.
    const verification = verifyDraftAgainstRecord(draft, record, intentId);
    if (!verification.ok) {
      this.record(intentId, "skipped", `draft does not match the commitment: ${verification.problems.join("; ")}`);
      return;
    }

    // An intent whose preconditions do not hold is left alone rather than served at a bad moment.
    const conditions = conditionsHold(draft, observations);
    if (!conditions.hold) {
      this.record(intentId, "skipped", `conditions not met: ${conditions.failed.join("; ")}`);
      return;
    }

    const { plan, declined } = await planIntent(intentId, draft, {
      quoter: this.quoter,
      strategy: this.strategy,
      solver: this.address,
    });

    if (!plan) {
      this.record(intentId, "declined", declined ?? "no plan");
      return;
    }

    await this.options.client.placeBid(intentId, {
      feeBps: plan.feeBps,
      etaSeconds: plan.etaSeconds,
      planHash: planHashOf(plan),
      guaranteedOut: plan.guaranteedOut,
    });
    this.bidded.add(intentId);
    this.record(
      intentId,
      "bid",
      `${plan.feeBps} bps fee, ${(plan.scoring.successProbability * 100).toFixed(1)}% confidence, ${plan.scoring.notes.join(", ")}`,
    );
  }

  /** Re-plan at settlement time: the quote that won the auction may have moved since. */
  private async settle(intentId: Hex, draft: IntentDraft): Promise<void> {
    if (this.settling.has(intentId)) return;
    this.settling.add(intentId);

    try {
      const { plan, declined } = await planIntent(intentId, draft, {
        quoter: this.quoter,
        strategy: this.strategy,
        solver: this.address,
      });

      if (!plan) {
        await this.options.client.reportFailure(intentId, declined ?? "no executable plan");
        this.record(intentId, "failed", `gave the intent back: ${declined ?? "no plan"}`);
        return;
      }

      const hash = await this.options.client.settle(intentId, draft, plan.entryRoutes, plan.exitRoutes);
      this.record(intentId, "settled", `settled in ${hash}`);
    } catch (error) {
      // A revert here is the solver's problem, not the user's: hand the intent back so another
      // solver can take it, and wear the reputation hit.
      const message = (error as Error).message;
      try {
        await this.options.client.reportFailure(intentId, message.slice(0, 120));
      } catch {
        /* the intent may already have moved on */
      }
      this.record(intentId, "failed", message);
    } finally {
      this.settling.delete(intentId);
    }
  }

  start(intervalMs = 2_000): void {
    if (this.timer) return;
    const run = () => {
      void this.tick().catch((error) => this.log(`tick failed: ${(error as Error).message}`));
    };
    run();
    this.timer = setInterval(run, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private record(intentId: Hex, action: SolverActivity["action"], detail: string): void {
    const key = `${action}:${detail}`;
    if (this.reported.get(intentId) === key) return; // a standing reason, already said once
    this.reported.set(intentId, key);

    this.activity.push({ intentId, action, detail, at: Date.now() });
    this.log(`${action} ${intentId.slice(0, 10)}… — ${detail}`);
  }

  private log(message: string, detail?: Record<string, unknown>): void {
    this.options.log?.(`[${this.strategy.name}] ${message}`, detail);
  }
}

/** A feed backed by an in-process list. Used by the demo and the tests. */
export class StaticIntentFeed implements IntentFeed {
  private readonly intents = new Map<Hex, IntentDraft>();
  private observed: Record<string, number> = {};

  add(intentId: Hex, draft: IntentDraft): void {
    this.intents.set(intentId, draft);
  }

  remove(intentId: Hex): void {
    this.intents.delete(intentId);
  }

  observe(values: Record<string, number>): void {
    this.observed = { ...this.observed, ...values };
  }

  async openIntents() {
    return [...this.intents].map(([intentId, draft]) => ({ intentId, draft }));
  }

  async observations() {
    return this.observed;
  }
}
