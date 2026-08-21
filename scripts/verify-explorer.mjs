#!/usr/bin/env node
/**
 * Prepare standard-json-input for OKX Explorer / OKLink verification of the 1952 deployment.
 * Chain 1952 has no Sourcify instance and no OKX verify key in this repo, so this writes
 * the compiler input a human (or a later API key) can paste into the explorer UI.
 *
 *   npm run verify:explorer
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const artifacts = join(root, "contracts", "artifacts", "build-info");
const outDir = join(root, "verify");
const deploymentPath = join(root, "deployments", "xlayerTestnet.json");

if (!existsSync(deploymentPath)) {
  console.error("missing deployments/xlayerTestnet.json");
  process.exit(1);
}

const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
mkdirSync(outDir, { recursive: true });

const names = {
  solverRegistry: "SolverRegistry",
  rwaRegistry: "RWARegistry",
  policyEngine: "PolicyEngine",
  intentRegistry: "IntentRegistry",
  settlement: "IntentSettlement",
  recurringRegistry: "RecurringRegistry",
  tslaVault: "RwaVault",
};

writeFileSync(
  join(outDir, "README.md"),
  [
    "# Explorer verification (X Layer testnet 1952)",
    "",
    "There is no Sourcify endpoint and no OKX/OKLink API key configured for chain 1952.",
    "Upload each `standard-json-input` below in the explorer Verify Contract form:",
    "",
    `- Explorer: ${deployment.explorer ?? "https://web3.okx.com/explorer/xlayer-testnet"}`,
    "- Compiler: solc 0.8.24, optimizer on, 200 runs, via-IR.",
    "",
    ...Object.entries(names).map(
      ([key, name]) => `- ${name} \`${deployment.contracts[key]}\``,
    ),
    "",
    "Constructor args are in `constructor-args.json`. Paste the matching standard JSON input",
    "and set the contract path to `contracts/<Name>.sol:<Name>`.",
    "",
  ].join("\n"),
);

let copied = 0;
if (existsSync(artifacts)) {
  const { readdirSync } = await import("node:fs");
  for (const file of readdirSync(artifacts).filter((n) => n.endsWith(".json"))) {
    const info = JSON.parse(readFileSync(join(artifacts, file), "utf8"));
    if (!info.input) continue;
    writeFileSync(join(outDir, `standard-json-${file}`), JSON.stringify(info.input, null, 2));
    copied += 1;
  }
}

writeFileSync(
  join(outDir, "constructor-args.json"),
  JSON.stringify(
    {
      chainId: deployment.chainId,
      contracts: deployment.contracts,
      roles: deployment.roles,
      note: "Re-run deploy:testnet after a protocol change, then this script, then paste into the explorer.",
    },
    null,
    2,
  ),
);

console.log(`wrote ${copied} compiler inputs to verify/ for chain ${deployment.chainId}`);
console.log("explorer has no verify key here; upload standard-json-input manually.");
