import type { Address } from "viem";

/** One tradable asset known to IntentOS on the connected chain. */
export interface CatalogAsset {
  symbol: string;
  address: Address;
  decimals: number;
  /** Aliases users actually type: "TSLA", "Tesla", "$TSLA" for TSLAx. */
  aliases: string[];
  kind: "base" | "xstock" | "rwa" | "token";
}

/**
 * Resolves the tickers people write into the addresses IntentOS can trade.
 *
 * This is the only place a symbol becomes an address. Nothing upstream — including the language
 * model — is allowed to name an address directly, so an asset the deployment does not know about
 * fails resolution instead of producing a transaction against an unknown contract.
 */
export class AssetCatalog {
  private readonly bySymbol = new Map<string, CatalogAsset>();

  constructor(assets: CatalogAsset[] = []) {
    for (const asset of assets) this.add(asset);
  }

  add(asset: CatalogAsset): void {
    this.bySymbol.set(asset.symbol.toLowerCase(), asset);
    for (const alias of asset.aliases) {
      const key = alias.toLowerCase();
      if (!this.bySymbol.has(key)) this.bySymbol.set(key, asset);
    }
  }

  /** Resolve a user-written ticker. Returns undefined rather than guessing. */
  find(symbol: string): CatalogAsset | undefined {
    const cleaned = symbol.trim().replace(/^\$/, "").toLowerCase();
    return this.bySymbol.get(cleaned) ?? this.bySymbol.get(`${cleaned}x`);
  }

  resolve(symbol: string): CatalogAsset {
    const asset = this.find(symbol);
    if (!asset) {
      throw new UnknownAssetError(symbol, this.symbols());
    }
    return asset;
  }

  has(symbol: string): boolean {
    return this.find(symbol) !== undefined;
  }

  /** Canonical symbols, deduplicated — aliases are not listed. */
  symbols(): string[] {
    return [...new Set([...this.bySymbol.values()].map((a) => a.symbol))];
  }

  all(): CatalogAsset[] {
    return [...new Set(this.bySymbol.values())];
  }

  tradable(): CatalogAsset[] {
    return this.all().filter((a) => a.kind !== "base");
  }
}

export class UnknownAssetError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly known: string[],
  ) {
    super(`no asset called "${symbol}" on this deployment — known assets: ${known.join(", ")}`);
    this.name = "UnknownAssetError";
  }
}

/** Shape of the JSON written by contracts/scripts/deploy.ts. */
export interface DeploymentFile {
  network: string;
  chainId: number;
  contracts: Record<string, Address>;
  roles?: Record<string, Address>;
  tokens: Record<string, Address>;
  routers: { name: string; address: Address }[];
}

const BASE_SYMBOLS = new Set(["USDT", "USDC", "DAI"]);

/** Common ways people refer to an xStock: TSLAx is "TSLA", "Tesla", "$TSLA". */
const COMPANY_NAMES: Record<string, string[]> = {
  TSLAx: ["tesla"],
  NVDAx: ["nvidia"],
  AAPLx: ["apple"],
  SPYx: ["spy", "s&p", "sp500", "s&p500"],
  GOOGLx: ["google", "alphabet"],
  MSFTx: ["microsoft"],
  AMZNx: ["amazon"],
  METAx: ["meta", "facebook"],
};

/** Build a catalog from a deployment file, inferring decimals from the symbol convention. */
export function catalogFromDeployment(deployment: DeploymentFile): AssetCatalog {
  const catalog = new AssetCatalog();

  for (const [symbol, address] of Object.entries(deployment.tokens)) {
    const isBase = BASE_SYMBOLS.has(symbol.toUpperCase());
    const isXStock = symbol.endsWith("x") && symbol.length > 2;

    const aliases: string[] = [];
    if (isXStock) {
      aliases.push(symbol.slice(0, -1)); // TSLAx -> TSLA
      aliases.push(...(COMPANY_NAMES[symbol] ?? []));
    }

    catalog.add({
      symbol,
      address,
      decimals: isBase ? 6 : 18,
      aliases,
      kind: isBase ? "base" : isXStock ? "xstock" : "token",
    });
  }

  return catalog;
}

/** Parse a human decimal amount ("10,000", "10k", "2.5") into base units. */
export function parseAmount(input: string, decimals: number): bigint {
  const cleaned = input.trim().toLowerCase().replace(/[,_\s]/g, "").replace(/^\$/, "");
  const suffixed = /^(\d*\.?\d+)([km])$/.exec(cleaned);

  let normalized = cleaned;
  if (suffixed) {
    const multiplier = suffixed[2] === "k" ? 1_000 : 1_000_000;
    normalized = String(Number(suffixed[1]) * multiplier);
  }
  if (!/^\d*\.?\d+$/.test(normalized)) {
    throw new Error(`cannot read "${input}" as an amount`);
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/** Render base units back as a readable decimal, trimming trailing zeros. */
export function formatAmount(value: bigint, decimals: number, maxFractionDigits = 4): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(decimals, "0").slice(0, maxFractionDigits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}
