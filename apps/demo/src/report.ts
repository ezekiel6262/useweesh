import { formatAmount, type AssetCatalog } from "@intentos/sdk";

/** Small terminal helpers so the demo reads like a report rather than a log dump. */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}\n${DIM}${"─".repeat(Math.min(78, text.length + 20))}${RESET}`);
}

export function step(text: string): void {
  console.log(`${DIM}·${RESET} ${text}`);
}

export function good(text: string): void {
  console.log(`${GREEN}✓${RESET} ${text}`);
}

export function warn(text: string): void {
  console.log(`${YELLOW}!${RESET} ${text}`);
}

export function quote(text: string): void {
  for (const line of text.split("\n")) console.log(`  ${DIM}${line}${RESET}`);
}

export function table(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)));

  console.log(`  ${DIM}${columns.map((c, i) => c.padEnd(widths[i]!)).join("  ")}${RESET}`);
  for (const row of rows) {
    console.log(`  ${columns.map((c, i) => (row[c] ?? "").padEnd(widths[i]!)).join("  ")}`);
  }
}

export interface Holding {
  symbol: string;
  balance: bigint;
  decimals: number;
}

/** Portfolio movement, showing only what actually changed. */
export function portfolioDelta(before: Holding[], after: Holding[], catalog: AssetCatalog): void {
  const rows: Record<string, string>[] = [];

  for (const [i, holding] of after.entries()) {
    const previous = before[i]!.balance;
    const delta = holding.balance - previous;
    if (delta === 0n) continue;

    rows.push({
      asset: holding.symbol,
      before: formatAmount(previous, holding.decimals, 3),
      after: formatAmount(holding.balance, holding.decimals, 3),
      change: `${delta > 0n ? "+" : "-"}${formatAmount(delta < 0n ? -delta : delta, holding.decimals, 3)}`,
    });
  }

  if (rows.length === 0) {
    warn("nothing moved");
    return;
  }
  table(rows);
  void catalog;
}
