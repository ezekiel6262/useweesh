import type { Address, PublicClient } from "viem";
import { DEX_ROUTER_ABI, type Route } from "@intentos/intent-schema";

/**
 * Venue quoting.
 *
 * IntentOS does not run its own liquidity — it routes through what is already on X Layer. A
 * solver's edge is knowing which venue is best for which leg at which size, so quoting every
 * allowlisted router (and every sensible path through them) is the first thing a solver does.
 */

export interface Venue {
  name: string;
  address: Address;
}

export interface Quote {
  venue: Venue;
  route: Route;
  amountIn: bigint;
  amountOut: bigint;
}

export interface QuoterOptions {
  publicClient: PublicClient;
  venues: Venue[];
  /** Token to try as an intermediate hop when no direct pool exists. */
  intermediate?: Address;
  /** Quotes are cached per block; a solver quotes the same pair many times per auction. */
  cacheMs?: number;
}

export class Quoter {
  private readonly cache = new Map<string, { at: number; quote: Quote | null }>();

  constructor(private readonly options: QuoterOptions) {}

  get venues(): Venue[] {
    return this.options.venues;
  }

  /** Every path worth trying for a pair: direct on each venue, then one hop via the base asset. */
  private pathsFor(tokenIn: Address, tokenOut: Address): Address[][] {
    const paths: Address[][] = [[tokenIn, tokenOut]];
    const mid = this.options.intermediate;
    if (mid && mid !== tokenIn && mid !== tokenOut) {
      paths.push([tokenIn, mid, tokenOut]);
    }
    return paths;
  }

  /** The best quote across every venue and path, or null when nothing can price the leg. */
  async best(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote | null> {
    if (amountIn === 0n) return null;
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null;

    const key = `${tokenIn}:${tokenOut}:${amountIn}`;
    const cached = this.cache.get(key);
    const ttl = this.options.cacheMs ?? 2_000;
    if (cached && Date.now() - cached.at < ttl) return cached.quote;

    const quotes = await this.all(tokenIn, tokenOut, amountIn);
    const best = quotes.reduce<Quote | null>((a, b) => (a === null || b.amountOut > a.amountOut ? b : a), null);
    this.cache.set(key, { at: Date.now(), quote: best });
    return best;
  }

  /** Every quote, kept separately so a solver can reason about venue spread and not just the max. */
  async all(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<Quote[]> {
    const attempts = this.options.venues.flatMap((venue) =>
      this.pathsFor(tokenIn, tokenOut).map((path) => ({ venue, path })),
    );

    const results = await Promise.all(
      attempts.map(async ({ venue, path }) => {
        try {
          const amounts = (await this.options.publicClient.readContract({
            address: venue.address,
            abi: DEX_ROUTER_ABI,
            functionName: "getAmountsOut",
            args: [amountIn, path],
          })) as readonly bigint[];

          const amountOut = amounts[amounts.length - 1]!;
          if (amountOut === 0n) return null;
          return { venue, route: { router: venue.address, path }, amountIn, amountOut } satisfies Quote;
        } catch {
          // An unpriced pair is normal — not every venue lists every asset.
          return null;
        }
      }),
    );

    return results.filter((q): q is Quote => q !== null);
  }

  /** What `amount` of `token` is worth in the base asset. Used to compare heterogeneous baskets. */
  async valueIn(token: Address, base: Address, amount: bigint): Promise<bigint | null> {
    if (token.toLowerCase() === base.toLowerCase()) return amount;
    const quote = await this.best(token, base, amount);
    return quote?.amountOut ?? null;
  }
}
