import type { AssetCatalog, CatalogAsset } from "./catalog.js";
import { emptySpec, type IntentSpec } from "./spec.js";

/**
 * A deterministic parser for the phrasings IntentOS is asked for most often.
 *
 * It exists for two reasons. It is the fallback when no ANTHROPIC_API_KEY is configured, so a
 * demo, a test run and an offline agent all still work end to end. And it is the reference the
 * model-backed parser is checked against — both produce an IntentSpec, and both go through the
 * same compiler and the same validation.
 */

const PERCENT = String.raw`(\d+(?:\.\d+)?)\s*(?:%|percent)`;
const AMOUNT = String.raw`\$?\d[\d,_]*(?:\.\d+)?\s*[km]?`;

export interface GrammarResult {
  spec: IntentSpec;
  /** Parts of the sentence the grammar did not account for. */
  unparsed: string[];
}

export function parseWithGrammar(prompt: string, catalog: AssetCatalog): GrammarResult {
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const spec = emptySpec();
  const unparsed: string[] = [];

  const mentions = findAssetMentions(text, catalog);
  const input = findInput(text, catalog, mentions);
  const exits = findExits(text, catalog, mentions);

  spec.inputSymbol = input?.asset.symbol ?? defaultBase(catalog).symbol;
  spec.inputAmount = input?.amount ?? null;
  spec.exits = exits.map((e) => ({ symbol: e.asset.symbol, amount: e.amount }));

  const exitIndices = new Set(exits.map((e) => e.index));
  const targets = mentions.filter(
    (m) => m.asset.symbol !== spec.inputSymbol && !exitIndices.has(m.index),
  );

  spec.targets = dedupeBySymbol(targets).map((m) => ({
    symbol: m.asset.symbol,
    weightPercent: findWeightFor(text, m),
  }));

  // Equal weighting is the stated default whenever the user did not weight the legs.
  const anyWeighted = spec.targets.some((t) => t.weightPercent !== null);
  if (!anyWeighted || /\bequal(?:ly|-weight(?:ed)?)?\b/.test(text)) {
    spec.targets = spec.targets.map((t) => ({ ...t, weightPercent: null }));
  }

  // "60/40", "40/30/30" — a ratio written once for the whole basket, in the order the assets
  // were named. Common enough in how people actually describe a portfolio to be worth reading.
  if (spec.targets.every((t) => t.weightPercent === null) && !/\bequal(?:ly|-weight(?:ed)?)?\b/.test(text)) {
    const ratio = findRatio(text, spec.targets.length);
    if (ratio) {
      spec.targets = spec.targets.map((target, i) => ({ ...target, weightPercent: ratio[i]! }));
    }
  }

  spec.action = detectAction(text, spec);
  spec.requireCompliant = /\b(kyb|kyc|compliant solvers?|only compliant|kyb'?d)\b/.test(text);
  spec.sponsorGas = /\b(gasless(?:ly)?|sponsor(?:ed)? gas|pay(?:s|ing)? (?:the )?gas)\b/.test(text);
  spec.minSolverReputationPercent = findReputationFloor(text);
  spec.requireRwaAttested = /\b(attested|verified|regulated)\b/.test(text) || spec.action === "onboard_rwa";
  spec.restrictToDeclaredAssets = /\b(only these|nothing else|no other (?:assets|tokens)|exactly these)\b/.test(text);
  spec.ttlMinutes = findTtlMinutes(text);
  spec.recurrence = findRecurrence(text);
  spec.conditions = findConditions(text, catalog);

  if (spec.action === "pay") {
    const payee = /0x[a-fA-F0-9]{40}/.exec(prompt);
    spec.payTo = payee ? payee[0] : null;
    if (spec.targets.length === 0) {
      spec.targets = [{ symbol: spec.inputSymbol, weightPercent: 100 }];
    }
    spec.maxSlippagePercent = findSlippage(text) ?? 0;
    spec.maxFeePercent = findFeeCap(text) ?? 0;
    if (!spec.payTo) spec.clarifications.push("Which address should receive the payment?");
  } else {
    spec.maxSlippagePercent = findSlippage(text) ?? 1;
    spec.maxFeePercent = findFeeCap(text);
  }

  if (spec.targets.length === 0) {
    spec.clarifications.push("Which assets should the intent end up holding?");
  }
  if (spec.inputAmount === null && spec.action !== "rebalance") {
    spec.clarifications.push(`How much ${spec.inputSymbol} should be deployed?`);
  }
  if (!input && spec.action !== "rebalance") {
    spec.assumptions.push(`Assumed the position is funded in ${spec.inputSymbol}.`);
  }
  if (!/slippage/.test(text)) {
    spec.assumptions.push("Assumed a 1% slippage tolerance per leg.");
  }

  spec.summary = describeSpec(spec);
  return { spec, unparsed };
}

interface Mention {
  asset: CatalogAsset;
  index: number;
  matched: string;
}

/** Locate every catalog asset named in the text, longest alias first so "SPY" beats "S&P". */
function findAssetMentions(text: string, catalog: AssetCatalog): Mention[] {
  const terms: { term: string; asset: CatalogAsset }[] = [];
  for (const asset of catalog.all()) {
    terms.push({ term: asset.symbol.toLowerCase(), asset });
    for (const alias of asset.aliases) terms.push({ term: alias.toLowerCase(), asset });
  }
  terms.sort((a, b) => b.term.length - a.term.length);

  const mentions: Mention[] = [];
  const claimed: [number, number][] = [];

  for (const { term, asset } of terms) {
    const pattern = new RegExp(String.raw`(?<![a-z0-9])\$?${escapeRegex(term)}(?![a-z0-9])`, "g");
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      const end = start + match[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      mentions.push({ asset, index: start, matched: match[0] });
    }
  }

  return mentions.sort((a, b) => a.index - b.index);
}

function dedupeBySymbol(mentions: Mention[]): Mention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    if (seen.has(m.asset.symbol)) return false;
    seen.add(m.asset.symbol);
    return true;
  });
}

/** The funding leg: an amount immediately attached to a base asset. */
function findInput(
  text: string,
  catalog: AssetCatalog,
  mentions: Mention[],
): { asset: CatalogAsset; amount: string } | undefined {
  for (const mention of mentions) {
    const before = text.slice(Math.max(0, mention.index - 24), mention.index);
    const match = new RegExp(String.raw`(${AMOUNT})\s*(?:of\s+)?$`).exec(before);
    if (match && mention.asset.kind === "base") {
      return { asset: mention.asset, amount: normalizeAmount(match[1]!) };
    }
  }

  // "deploy 10,000 into ..." with the base asset left implicit.
  const bare = new RegExp(String.raw`\b(?:allocate|deploy|invest|put|spend|use)\s+(${AMOUNT})\b`).exec(text);
  if (bare) {
    const attached = new RegExp(String.raw`${escapeRegex(bare[1]!)}\s*(?:of\s+)?([a-z]{3,6})`).exec(text);
    const named = attached ? catalog.find(attached[1]!) : undefined;
    return { asset: named ?? defaultBase(catalog), amount: normalizeAmount(bare[1]!) };
  }

  return undefined;
}

/** Positions being sold: "sell 10 TSLA", "exit 5 NVDAx", "trim 2 SPY". */
function findExits(
  text: string,
  catalog: AssetCatalog,
  mentions: Mention[],
): { asset: CatalogAsset; amount: string; index: number }[] {
  const exits: { asset: CatalogAsset; amount: string; index: number }[] = [];
  const verb = /\b(?:sell|exit|close|unwind|trim|liquidate|dispose of)\b/g;

  for (const match of text.matchAll(verb)) {
    // Everything up to the next "buy"/"into" belongs to the sell side.
    const rest = text.slice(match.index! + match[0].length);
    const stop = rest.search(/\b(?:buy|into|and buy|then buy|acquire)\b/);
    const clause = stop === -1 ? rest : rest.slice(0, stop);
    const offset = match.index! + match[0].length;

    const pattern = new RegExp(String.raw`(${AMOUNT})\s+(?:shares?\s+of\s+)?(\$?[a-z][a-z0-9&]*)`, "g");
    for (const found of clause.matchAll(pattern)) {
      const asset = catalog.find(found[2]!);
      if (!asset || asset.kind === "base") continue;
      // Point at the ticker itself, not at the amount, so this lines up with the mention list.
      const tickerIndex = offset + found.index! + found[0].lastIndexOf(found[2]!);
      exits.push({ asset, amount: normalizeAmount(found[1]!), index: tickerIndex });
    }
  }

  // Keep only exits that line up with a real mention, so "sell 10 of it" does not invent one.
  const known = new Set(mentions.map((m) => m.asset.symbol));
  return exits.filter((e) => known.has(e.asset.symbol));
}

/** A weight written just before or just after the asset it applies to. */
function findWeightFor(text: string, mention: Mention): number | null {
  const before = text.slice(Math.max(0, mention.index - 28), mention.index);
  const beforeMatch = new RegExp(String.raw`${PERCENT}\s*(?:in|into|to|of|on|toward)?\s*$`).exec(before);
  if (beforeMatch) return Number(beforeMatch[1]);

  const after = text.slice(mention.index + mention.matched.length, mention.index + mention.matched.length + 24);
  const afterMatch = new RegExp(String.raw`^\s*(?:at|=|:)?\s*${PERCENT}`).exec(after);
  if (afterMatch) return Number(afterMatch[1]);

  return null;
}

/** A whole-basket ratio like "60/40", if one is written and it matches the leg count. */
function findRatio(text: string, legCount: number): number[] | null {
  if (legCount < 2) return null;

  for (const match of text.matchAll(/\b(\d{1,3}(?:\s*\/\s*\d{1,3})+)\b/g)) {
    const parts = match[1]!.split("/").map((part) => Number(part.trim()));
    if (parts.length !== legCount) continue;
    if (parts.some((part) => !Number.isFinite(part) || part <= 0)) continue;

    // Only read it as a split when it plausibly is one — "1/2 of my TSLA" is not a basket ratio.
    const total = parts.reduce((sum, part) => sum + part, 0);
    if (total !== 100 && total !== 10) continue;
    return parts;
  }
  return null;
}

function detectAction(text: string, spec: IntentSpec): IntentSpec["action"] {
  if (/\b(tokeni[sz]e|bring .* onchain|onboard|issue .* onchain)\b/.test(text)) return "onboard_rwa";
  if (spec.exits.length > 0 || /\brebalance|reweight|rotate\b/.test(text)) return "rebalance";
  const namesXstock = spec.targets.some((t) => !isStableSymbol(t.symbol));
  if (!namesXstock && /\b(pay(?:ing|ment|roll|out)?|subscription)\b/.test(text)) return "pay";
  return spec.targets.length > 1 ? "buy_basket" : "swap";
}

function isStableSymbol(symbol: string): boolean {
  return /^(USDT|USDC|USDG|DAI)$/i.test(symbol);
}

function findSlippage(text: string): number | null {
  const patterns = [
    new RegExp(String.raw`(?:max(?:imum)?\s+)?${PERCENT}\s*(?:max(?:imum)?\s*)?slippage`),
    new RegExp(String.raw`slippage\s*(?:of|under|below|at most|<=?|max(?:imum)?)?\s*${PERCENT}`),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return null;
}

function findFeeCap(text: string): number | null {
  const match = new RegExp(
    String.raw`fees?\s*(?:of|under|below|at most|no more than|<=?|max(?:imum)?)?\s*${PERCENT}`,
  ).exec(text);
  return match ? Number(match[1]) : null;
}

function findReputationFloor(text: string): number | null {
  const match = new RegExp(
    String.raw`(?:reputation|track record|reliability)\s*(?:of|above|over|at least|>=?)?\s*${PERCENT}`,
  ).exec(text);
  return match ? Number(match[1]) : null;
}

function findTtlMinutes(text: string): number | null {
  const match = /\b(?:within|inside|expires? in|valid for|good for)\s+(\d+)\s*(second|minute|min|hour|hr|day)s?\b/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  switch (match[2]) {
    case "second":
      return Math.max(1, Math.round(value / 60));
    case "hour":
    case "hr":
      return value * 60;
    case "day":
      return value * 60 * 24;
    default:
      return value;
  }
}

function findRecurrence(text: string): IntentSpec["recurrence"] {
  const named: Record<string, number> = {
    hour: 3_600,
    hourly: 3_600,
    day: 86_400,
    daily: 86_400,
    week: 604_800,
    weekly: 604_800,
    month: 2_592_000,
    monthly: 2_592_000,
  };

  if (/\bevery monday\b/.test(text)) {
    return { everySeconds: named.week!, maxRuns: null };
  }

  const everyN = /\bevery\s+(\d+)\s*(hour|day|week|month)s?\b/.exec(text);
  if (everyN) {
    return { everySeconds: Number(everyN[1]) * named[everyN[2]!]!, maxRuns: null };
  }

  const simple = /\b(?:every|each)\s+(hour|day|week|month)\b|\b(hourly|daily|weekly|monthly)\b/.exec(text);
  if (simple) {
    const unit = (simple[1] ?? simple[2])!;
    return { everySeconds: named[unit]!, maxRuns: null };
  }

  return null;
}

/** "only if TSLA is below 300", "when volatility is under 30". */
function findConditions(text: string, catalog: AssetCatalog): IntentSpec["conditions"] {
  const conditions: IntentSpec["conditions"] = [];

  const priceRule = /\b(?:only )?(?:if|when|once)\s+(\$?[a-z][a-z0-9&]*)\s+(?:is\s+)?(?:trading\s+)?(below|under|above|over|less than|greater than|more than)\s+\$?(\d[\d,._]*(?:\.\d+)?)/g;
  for (const match of text.matchAll(priceRule)) {
    const subject = match[1]!;
    const asset = catalog.find(subject);
    const isVolatility = /^(volatility|vol|iv)$/.test(subject);
    const below = /below|under|less than/.test(match[2]!);

    if (!asset && !isVolatility) continue;
    conditions.push({
      kind: isVolatility ? "volatility" : "price",
      subject: asset?.symbol ?? subject,
      operator: below ? "lt" : "gt",
      value: Number(match[3]!.replace(/[,_]/g, "")),
      window: null,
    });
  }

  const driftRule = new RegExp(String.raw`\b(?:drift|drifts|off target|out of band)\s*(?:by|of|more than|over|>)?\s*${PERCENT}`).exec(text);
  if (driftRule) {
    conditions.push({ kind: "portfolio-drift", subject: null, operator: "gt", value: Number(driftRule[1]), window: null });
  }

  const volumeRule = /\b(?:24h\s+)?volume\s+(?:exceeds|above|over|>)\s+\$?(\d[\d,_]*)/g;
  for (const match of text.matchAll(volumeRule)) {
    conditions.push({
      kind: "volume",
      subject: null,
      operator: "gt",
      value: Number(match[1]!.replace(/[,_]/g, "")),
      window: "24h",
    });
  }

  if (/\bfunding is positive\b/.test(text)) {
    conditions.push({ kind: "funding", subject: null, operator: "gt", value: 0, window: null });
  }

  const volSpike = /\bvolatility spikes? above\s+(\d+(?:\.\d+)?)/.exec(text);
  if (volSpike) {
    conditions.push({ kind: "volatility", subject: "volatility", operator: "gt", value: Number(volSpike[1]), window: null });
  }

  return conditions;
}

function defaultBase(catalog: AssetCatalog): CatalogAsset {
  return catalog.all().find((a) => a.kind === "base") ?? catalog.all()[0]!;
}

function normalizeAmount(raw: string): string {
  return raw.trim().replace(/^\$/, "").replace(/[,_\s]/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A one-line restatement, used as the intent's summary when the model did not write one. */
export function describeSpec(spec: IntentSpec): string {
  const legs = spec.targets
    .map((t) => (t.weightPercent === null ? t.symbol : `${t.weightPercent}% ${t.symbol}`))
    .join(", ");

  switch (spec.action) {
    case "rebalance": {
      const sold = spec.exits.map((e) => `${e.amount} ${e.symbol}`).join(", ");
      return `Rebalance: sell ${sold || "nothing"} and hold ${legs || "nothing"}.`;
    }
    case "onboard_rwa":
      return `Bring ${legs || "an asset"} onchain and take a position in it.`;
    case "pay":
      return `Pay ${spec.inputAmount ?? "?"} ${spec.inputSymbol} to ${spec.payTo ?? "the named address"}${spec.sponsorGas ? ", gaslessly" : ""}.`;
    case "swap":
      return `Swap ${spec.inputAmount ?? "?"} ${spec.inputSymbol} into ${legs || "?"}.`;
    default:
      return `Allocate ${spec.inputAmount ?? "?"} ${spec.inputSymbol} across ${legs || "?"}${
        spec.targets.every((t) => t.weightPercent === null) ? " at equal weight" : ""
      }.`;
  }
}
