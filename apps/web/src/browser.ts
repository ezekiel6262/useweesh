import {
  catalogFromDeployment,
  explainDraft,
  parseIntent,
  type IntentSpec,
} from "@intentos/intent-ai";
import { hashOutcome, hashPolicy, type Address } from "@intentos/intent-schema";
import { previewAuction } from "./auction.js";
import {
  authorizeCoordinatorSession,
  challengeSelection,
  connectWallet,
  mintTestUsdt,
  readBalances,
  submitDraft,
  vaultBalance,
  vaultDeposit,
  vaultWithdraw,
} from "./live.js";
import { PREVIEW_ASSETS, PREVIEW_SOLVERS, PREVIEW_UNIVERSE, PREVIEW_VENUES } from "./universe.js";

/**
 * The playground, compiled to run in the browser.
 *
 * Parsing an intent is pure computation — a grammar, a symbol catalog, unit conversion and
 * hashing — so it needs no server at all. Running it client-side means the hosted page can never
 * see, sign or submit anything: there is nothing to send. The Claude-backed parser needs a key
 * and therefore a server, so a self-hosted deployment gets that path and this one does not.
 */

const catalog = catalogFromDeployment(PREVIEW_UNIVERSE);

// A preview parse has no owner yet; the recipient only decides where outputs would land.
const PLAYGROUND_RECIPIENT = "0x0000000000000000000000000000000000000001" as Address;

export interface ParsedView {
  parser: string;
  explanation: string;
  spec: IntentSpec;
  assumptions: string[];
  clarifications: string[];
  quotesAvailable: boolean;
  outcome: {
    kind: number;
    kindLabel: string;
    inputSymbol: string;
    inputAmount: string;
    maxSlippageBps: number;
    legs: { symbol: string; weightBps: number; minOut: string }[];
    exits: { symbol: string; amountIn: string }[];
  };
  policy: {
    maxNotional: string;
    maxFeeBps: number;
    minReputationBps: number;
    requireRwaAttested: boolean;
    requireCompliant: boolean;
    sponsorGas: boolean;
    allowlist: string[];
  };
  timing: { auctionSeconds: number; settleSeconds: number };
  metadata: { schedule: unknown; conditions: unknown[] };
  commitment: { outcomeHash: string; policyHash: string };
}

const KIND_LABEL = ["SWAP", "BASKET", "REBALANCE", "RWA_ONBOARD", "BATCH", "PAYMENT"] as const;

export async function parse(prompt: string): Promise<ParsedView> {
  const parsed = await parseIntent(prompt, {
    catalog,
    recipient: PLAYGROUND_RECIPIENT,
    // No chain here, so no live quotes: floors stay open and the winning solver's own auction
    // guarantee is what would bind each leg. The page says so rather than implying otherwise.
    prefer: "grammar",
    now: Math.floor(Date.now() / 1000),
  });

  const { draft } = parsed;
  return {
    parser: parsed.parser,
    explanation: explainDraft(draft, { catalog }),
    spec: parsed.spec,
    assumptions: parsed.assumptions,
    clarifications: parsed.clarifications,
    quotesAvailable: false,
    outcome: {
      kind: draft.outcome.kind,
      kindLabel: KIND_LABEL[draft.outcome.kind] ?? `KIND_${draft.outcome.kind}`,
      inputSymbol: symbolOf(draft.outcome.inputToken),
      inputAmount: draft.outcome.inputAmount.toString(),
      maxSlippageBps: draft.outcome.maxSlippageBps,
      legs: draft.outcome.legs.map((leg) => ({
        symbol: symbolOf(leg.token),
        weightBps: leg.weightBps,
        minOut: leg.minOut.toString(),
      })),
      exits: draft.outcome.exits.map((exit) => ({
        symbol: symbolOf(exit.token),
        amountIn: exit.amountIn.toString(),
      })),
    },
    policy: {
      maxNotional: draft.policy.maxNotional.toString(),
      maxFeeBps: draft.policy.maxFeeBps,
      minReputationBps: draft.policy.minReputationBps,
      requireRwaAttested: draft.policy.requireRwaAttested,
      requireCompliant: draft.policy.requireCompliant,
      sponsorGas: draft.policy.sponsorGas,
      allowlist: draft.policy.tokenAllowlist.map(symbolOf),
    },
    timing: {
      auctionSeconds:
        Number(draft.auctionEndsAt) - (draft.metadata.createdAt ?? Number(draft.auctionEndsAt)),
      settleSeconds: Number(draft.deadline - draft.auctionEndsAt),
    },
    metadata: { schedule: draft.metadata.schedule ?? null, conditions: draft.metadata.conditions ?? [] },
    // Exactly what IntentRegistry would store: the commitment, never the contents.
    commitment: { outcomeHash: hashOutcome(draft.outcome), policyHash: hashPolicy(draft.policy) },
  };
}

export const assets = PREVIEW_ASSETS.map((asset) => ({
  symbol: asset.symbol,
  kind: asset.kind,
  name: asset.name,
  assetRef: asset.assetRef,
  attested: asset.attested,
  class: asset.class,
  usdPrice: asset.usdPrice,
}));

export const solvers = PREVIEW_SOLVERS;
export const venues = PREVIEW_VENUES.map((v) => ({ name: v.name, feeBps: v.feeBps }));

function symbolOf(token: string): string {
  return (
    catalog.all().find((asset) => asset.address.toLowerCase() === token.toLowerCase())?.symbol ??
    `${token.slice(0, 6)}…`
  );
}

declare global {
  interface Window {
    IntentOS: {
      parse: typeof parse;
      previewAuction: typeof previewAuction;
      assets: typeof assets;
      solvers: typeof solvers;
      venues: typeof venues;
      connectWallet: typeof connectWallet;
      mintTestUsdt: typeof mintTestUsdt;
      readBalances: typeof readBalances;
      submitDraft: typeof submitDraft;
      authorizeCoordinatorSession: typeof authorizeCoordinatorSession;
      challengeSelection: typeof challengeSelection;
      vaultDeposit: typeof vaultDeposit;
      vaultWithdraw: typeof vaultWithdraw;
      vaultBalance: typeof vaultBalance;
    };
  }
}

window.IntentOS = {
  parse,
  previewAuction,
  assets,
  solvers,
  venues,
  connectWallet,
  mintTestUsdt,
  readBalances,
  submitDraft,
  authorizeCoordinatorSession,
  challengeSelection,
  vaultDeposit,
  vaultWithdraw,
  vaultBalance,
};
