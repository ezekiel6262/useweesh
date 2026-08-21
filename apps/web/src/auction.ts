import { PREVIEW_ASSETS, PREVIEW_VENUES } from "./universe.js";

export interface AuctionInput {
  outcome: {
    kind: number;
    inputSymbol: string;
    inputAmount: string;
    maxSlippageBps: number;
    legs: { symbol: string; weightBps: number; minOut: string }[];
    exits: { symbol: string; amountIn: string }[];
  };
}

/**
 * A client-side preview of the solver auction.
 *
 * The hosted playground has no chain, so it cannot place real bids. It *can* run the same
 * quoting arithmetic the solvers use against the demo venue book, which is what makes the
 * preview honest about relative fills even though nothing is signed. Numbers here are labelled
 * as a preview — `npm run demo` is the path that reads them back from a live settlement.
 */

export interface PreviewLegQuote {
  symbol: string;
  weightBps: number;
  amountIn: string;
  bestQuote: string;
  venue: string;
  userFloor: string;
}

export interface PreviewSolverLeg {
  symbol: string;
  guaranteed: string;
  venue: string;
}

export interface PreviewSolver {
  name: string;
  action: "bid" | "declined";
  reason?: string;
  feeBps?: number;
  confidence?: number;
  etaSeconds?: number;
  legs?: PreviewSolverLeg[];
}

export interface AuctionPreview {
  kind: number;
  inputSymbol: string;
  notional: string;
  legs: PreviewLegQuote[];
  solvers: PreviewSolver[];
  winner?: string;
  winnerFeeBps?: number;
  settlement?: { symbol: string; before: string; after: string; change: string }[];
  note: string;
}

const STRATEGIES = [
  { name: "conservative", safetyMarginBps: 60, feeBps: 15, minEdgeBps: 20, etaSeconds: 35, riskAversion: 1.6 },
  { name: "aggressive", safetyMarginBps: 15, feeBps: 8, minEdgeBps: 5, etaSeconds: 20, riskAversion: 0.4 },
] as const;

function meta(symbol: string) {
  return PREVIEW_ASSETS.find((a) => a.symbol === symbol) ?? {
    symbol,
    usdPrice: 1,
    decimals: 18,
    name: symbol,
  };
}

function toUsd(amount: bigint, symbol: string): number {
  const asset = meta(symbol);
  return (Number(amount) / 10 ** asset.decimals) * asset.usdPrice;
}

function fromUsd(usd: number, symbol: string): bigint {
  const asset = meta(symbol);
  const units = usd / asset.usdPrice;
  if (!Number.isFinite(units) || units <= 0) return 0n;
  return BigInt(Math.floor(units * 10 ** asset.decimals));
}

function quoteLeg(amountIn: bigint, inSymbol: string, outSymbol: string) {
  const usd = toUsd(amountIn, inSymbol);
  let best = 0n;
  let venue = PREVIEW_VENUES[0]!.name;

  for (const book of PREVIEW_VENUES) {
    const skew = book.priceSkewBps[outSymbol] ?? 0;
    const fee = book.feeBps;
    const adjustedUsd = usd * (1 - fee / 10_000) * (1 - skew / 10_000);
    const out = fromUsd(adjustedUsd, outSymbol);
    if (out > best) {
      best = out;
      venue = book.name;
    }
  }
  return { out: best, venue };
}

function format(amount: bigint, symbol: string, digits = 4): string {
  const decimals = meta(symbol).decimals;
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const frac = (amount % unit).toString().padStart(decimals, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

export function previewAuction(view: AuctionInput): AuctionPreview {
  const inputSymbol = view.outcome.inputSymbol;
  let budget = BigInt(view.outcome.inputAmount);

  // A rebalance is funded by the exits. Convert them into the base asset at the book.
  if (view.outcome.exits.length > 0 && budget === 0n) {
    let raisedUsd = 0;
    for (const exit of view.outcome.exits) {
      raisedUsd += toUsd(BigInt(exit.amountIn), exit.symbol);
    }
    budget = fromUsd(raisedUsd * 0.997, inputSymbol);
  }

  const quotedAmounts = view.outcome.legs.map((leg, index, all) => {
    const isLast = index === all.length - 1;
    const sized = isLast
      ? budget - all.slice(0, -1).reduce((sum, other) => sum + (budget * BigInt(other.weightBps)) / 10_000n, 0n)
      : (budget * BigInt(leg.weightBps)) / 10_000n;
    const quoted = quoteLeg(sized, inputSymbol, leg.symbol);
    const impliedFloor = quoted.out - (quoted.out * BigInt(view.outcome.maxSlippageBps)) / 10_000n;
    const userFloor = BigInt(leg.minOut) > 0n ? BigInt(leg.minOut) : impliedFloor;
    return { ...quoted, sized, impliedFloor, userFloor, symbol: leg.symbol, weightBps: leg.weightBps };
  });

  const legs: PreviewLegQuote[] = quotedAmounts.map((quoted) => ({
    symbol: quoted.symbol,
    weightBps: quoted.weightBps,
    amountIn: format(quoted.sized, inputSymbol, 2),
    bestQuote: format(quoted.out, quoted.symbol),
    venue: quoted.venue,
    userFloor: format(quoted.userFloor, quoted.symbol),
  }));

  const solvers: PreviewSolver[] = STRATEGIES.map((strategy) => {
    const solverLegs: PreviewSolverLeg[] = [];
    let tightest = 1;
    for (let i = 0; i < view.outcome.legs.length; i++) {
      const quoted = quotedAmounts[i]!;
      const guaranteed = quoted.out - (quoted.out * BigInt(strategy.safetyMarginBps)) / 10_000n;
      const userFloor = quoted.userFloor;
      const edgeBps = quoted.out === 0n ? 0 : Number(((guaranteed - userFloor) * 10_000n) / quoted.out);
      if (guaranteed < userFloor || edgeBps < strategy.minEdgeBps) {
        return {
          name: strategy.name,
          action: "declined" as const,
          reason: `leg ${i} (${view.outcome.legs[i]!.symbol}) cannot be guaranteed above the user's floor`,
        };
      }
      const ratio = Number(guaranteed) / Number(quoted.out);
      if (ratio < tightest) tightest = ratio;
      solverLegs.push({
        symbol: view.outcome.legs[i]!.symbol,
        guaranteed: format(guaranteed, view.outcome.legs[i]!.symbol),
        venue: quoted.venue,
      });
    }
    const n = view.outcome.legs.length;
    const confidence = Math.max(0.55, Math.min(0.97, 0.99 - (1 - tightest) * 8 - (n - 1) * 0.015 * strategy.riskAversion));
    return {
      name: strategy.name,
      action: "bid" as const,
      feeBps: strategy.feeBps,
      confidence: Math.round(confidence * 1000) / 10,
      etaSeconds: strategy.etaSeconds,
      legs: solverLegs,
    };
  });

  const bidders = solvers.filter((s) => s.action === "bid");
  const winner = bidders.sort((a, b) => (a.feeBps ?? 99) - (b.feeBps ?? 99) || (b.confidence ?? 0) - (a.confidence ?? 0))[0];

  const settlement: AuctionPreview["settlement"] = [];
  if (winner && budget > 0n) {
    settlement.push({
      symbol: inputSymbol,
      before: format(budget, inputSymbol, 2),
      after: "0",
      change: `−${format(budget, inputSymbol, 2)}`,
    });
  }
  for (let i = 0; i < view.outcome.legs.length; i++) {
    const quoted = quotedAmounts[i]!;
    const fill = quoted.out - (quoted.out * 8n) / 10_000n; // ~8 bps inside the quote, above the guarantee
    const symbol = view.outcome.legs[i]!.symbol;
    settlement.push({
      symbol,
      before: "0",
      after: format(fill, symbol),
      change: `+${format(fill, symbol)}`,
    });
  }

  return {
    kind: view.outcome.kind,
    inputSymbol,
    notional: format(budget, inputSymbol, 2),
    legs,
    solvers,
    winner: winner?.name,
    winnerFeeBps: winner?.feeBps,
    settlement: winner ? settlement : undefined,
    note:
      "Preview against the demo venue book, not a live settlement. " +
      "On a chain, IntentSettlement sizes the legs from the committed weights and reverts if any floor is missed.",
  };
}
