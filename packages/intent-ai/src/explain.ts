import { IntentKind, IntentStatus, type IntentDraft, type Outcome } from "@intentos/intent-schema";
import { type AssetCatalog, formatAmount } from "./catalog.js";

/**
 * Renders an intent back in the words a person would use to check it.
 *
 * Confirmation matters more here than in most systems: a user is signing off on an outcome, not
 * on a transaction they can read. Everything shown is derived from the committed draft, so what
 * is confirmed is exactly what settlement will enforce.
 */

export interface ExplainOptions {
  catalog: AssetCatalog;
  /** Include the guardrails as well as the trade. */
  includePolicy?: boolean;
}

export function explainDraft(draft: IntentDraft, options: ExplainOptions): string {
  const lines = [explainOutcome(draft.outcome, options.catalog)];

  const seconds = Number(draft.deadline - BigInt(Math.floor(Date.now() / 1000)));
  if (seconds > 0) {
    lines.push(`Solvers have ${humanDuration(Number(draft.auctionEndsAt - draft.deadline) + seconds)} to bid; the intent stops being servable in ${humanDuration(seconds)}.`);
  }

  if (options.includePolicy !== false) {
    lines.push(...explainPolicy(draft, options.catalog));
  }

  if (draft.metadata.conditions?.length) {
    for (const condition of draft.metadata.conditions) {
      const comparison = condition.operator.startsWith("l") ? "below" : "above";
      lines.push(`Only serve while ${condition.subject ?? condition.kind} is ${comparison} ${condition.value}.`);
    }
  }
  if (draft.metadata.schedule) {
    const runs = draft.metadata.schedule.maxRuns ? `, ${draft.metadata.schedule.maxRuns} times` : "";
    lines.push(`Repeats every ${humanDuration(draft.metadata.schedule.everySeconds)}${runs}.`);
  }

  return lines.join("\n");
}

export function explainOutcome(outcome: Outcome, catalog: AssetCatalog): string {
  const input = catalog.find(addressKey(catalog, outcome.inputToken)) ?? undefined;
  const inputSymbol = symbolFor(catalog, outcome.inputToken);
  const inputDecimals = input?.decimals ?? 18;

  const legs = outcome.legs
    .map((leg) => {
      const symbol = symbolFor(catalog, leg.token);
      const weight = (leg.weightBps / 100).toFixed(leg.weightBps % 100 === 0 ? 0 : 2);
      const floor =
        leg.minOut > 0n
          ? ` (at least ${formatAmount(leg.minOut, catalog.find(symbol)?.decimals ?? 18)} ${symbol})`
          : "";
      return `${weight}% ${symbol}${floor}`;
    })
    .join(", ");

  switch (outcome.kind) {
    case IntentKind.REBALANCE: {
      const exits = outcome.exits
        .map((exit) => {
          const symbol = symbolFor(catalog, exit.token);
          return `${formatAmount(exit.amountIn, catalog.find(symbol)?.decimals ?? 18)} ${symbol}`;
        })
        .join(", ");
      const topUp = outcome.inputAmount > 0n ? `, plus ${formatAmount(outcome.inputAmount, inputDecimals)} ${inputSymbol} of new capital` : "";
      return `Sell ${exits}${topUp}, and put the proceeds into ${legs}, with at most ${bps(outcome.maxSlippageBps)} slippage per leg.`;
    }
    case IntentKind.RWA_ONBOARD:
      return `Bring ${formatAmount(outcome.inputAmount, inputDecimals)} ${inputSymbol} into ${legs}, an attested tokenized real-world asset, with at most ${bps(outcome.maxSlippageBps)} slippage.`;
    case IntentKind.SWAP:
      return `Swap ${formatAmount(outcome.inputAmount, inputDecimals)} ${inputSymbol} into ${legs}, with at most ${bps(outcome.maxSlippageBps)} slippage.`;
    default:
      return `Deploy ${formatAmount(outcome.inputAmount, inputDecimals)} ${inputSymbol} across ${legs}, with at most ${bps(outcome.maxSlippageBps)} slippage per leg.`;
  }
}

function explainPolicy(draft: IntentDraft, catalog: AssetCatalog): string[] {
  const { policy } = draft;
  const lines: string[] = [];

  lines.push(`Solver fee is capped at ${bps(policy.maxFeeBps)} of the notional.`);
  if (policy.maxNotional > 0n) {
    const decimals = catalog.find(symbolFor(catalog, draft.outcome.inputToken))?.decimals ?? 18;
    lines.push(`Settlement may never spend more than ${formatAmount(policy.maxNotional, decimals)} ${symbolFor(catalog, draft.outcome.inputToken)}.`);
  }
  if (policy.minReputationBps > 0) {
    lines.push(`Only solvers with a reputation of ${bps(policy.minReputationBps)} or better may serve this.`);
  }
  if (policy.requireRwaAttested) {
    lines.push("Every asset acquired must carry a live RWA attestation onchain.");
  }
  if (policy.tokenAllowlist.length > 0) {
    lines.push(`The intent is pinned to ${policy.tokenAllowlist.map((t) => symbolFor(catalog, t)).join(", ")} and cannot touch anything else.`);
  }
  return lines;
}

export function statusLabel(status: IntentStatus): string {
  return {
    [IntentStatus.NONE]: "unknown",
    [IntentStatus.OPEN]: "taking bids",
    [IntentStatus.SELECTED]: "awaiting settlement",
    [IntentStatus.FULFILLED]: "fulfilled",
    [IntentStatus.CANCELLED]: "cancelled",
    [IntentStatus.EXPIRED]: "expired",
  }[status];
}

function symbolFor(catalog: AssetCatalog, address: string): string {
  const match = catalog.all().find((a) => a.address.toLowerCase() === address.toLowerCase());
  return match?.symbol ?? `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function addressKey(catalog: AssetCatalog, address: string): string {
  return symbolFor(catalog, address);
}

function bps(value: number): string {
  return `${(value / 100).toFixed(value % 100 === 0 ? 0 : 2)}%`;
}

export function humanDuration(seconds: number): string {
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const value = Math.round(seconds / size);
      return `${value} ${name}${value === 1 ? "" : "s"}`;
    }
  }
  return "moments";
}
