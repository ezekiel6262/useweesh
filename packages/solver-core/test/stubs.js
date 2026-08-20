/**
 * A priced stand-in for the chain, so the planner and the auction can be tested without one.
 * Prices are per whole unit and decimal-aware, matching MockDexRouter's arithmetic.
 */
export const USDT = "0x0000000000000000000000000000000000000011";
export const TSLA = "0x0000000000000000000000000000000000000021";
export const NVDA = "0x0000000000000000000000000000000000000022";
export const AAPL = "0x0000000000000000000000000000000000000023";

export const DECIMALS = { [USDT]: 6, [TSLA]: 18, [NVDA]: 18, [AAPL]: 18 };

/**
 * @param prices  venue -> token -> USD price per whole unit
 * @param feeBps  venue -> swap fee
 */
export function makePublicClient(venues) {
  return {
    async readContract({ address, functionName, args }) {
      if (functionName !== "getAmountsOut") throw new Error(`unexpected call ${functionName}`);
      const venue = venues[address.toLowerCase()];
      if (!venue) throw new Error("unknown venue");

      const [amountIn, path] = args;
      let amount = amountIn;
      for (let i = 0; i + 1 < path.length; i++) {
        amount = quote(venue, path[i], path[i + 1], amount);
      }
      return [amountIn, amount];
    },
  };
}

function quote(venue, tokenIn, tokenOut, amountIn) {
  const priceIn = venue.prices[tokenIn];
  const priceOut = venue.prices[tokenOut];
  if (priceIn === undefined || priceOut === undefined) throw new Error("pair not listed");

  const decIn = BigInt(DECIMALS[tokenIn]);
  const decOut = BigInt(DECIMALS[tokenOut]);
  // value in USD micro-units, then back out into the destination token's decimals
  const usd = (amountIn * BigInt(Math.round(priceIn * 1e6))) / 10n ** decIn;
  let out = (usd * 10n ** decOut) / BigInt(Math.round(priceOut * 1e6));
  out = (out * BigInt(10_000 - venue.feeBps)) / 10_000n;
  return out;
}

export function outcome(overrides = {}) {
  return {
    kind: 1,
    inputToken: USDT,
    inputAmount: 10_000_000_000n,
    recipient: "0x000000000000000000000000000000000000beef",
    maxSlippageBps: 100,
    legs: [
      { token: TSLA, weightBps: 5_000, minOut: 0n },
      { token: NVDA, weightBps: 5_000, minOut: 0n },
    ],
    exits: [],
    ...overrides,
  };
}

export function draft(overrides = {}) {
  const { policy: policyOverrides, ...rest } = overrides;
  return {
    outcome: outcome(rest.outcome ?? {}),
    policy: {
      maxNotional: 0n,
      validAfter: 0n,
      validUntil: 0n,
      maxFeeBps: 30,
      minReputationBps: 0,
      requireRwaAttested: false,
      requireCompliant: false,
      sponsorGas: false,
      tokenAllowlist: [],
      ...policyOverrides,
    },
    salt: "0x" + "01".repeat(32),
    auctionEndsAt: 1_800_000_020n,
    deadline: 1_800_000_600n,
    metadata: {},
    ...rest,
  };
}
