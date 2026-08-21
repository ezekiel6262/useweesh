#!/usr/bin/env node
/**
 * Bundle each server handler (and its SDK/viem graph) into CJS so Vercel Node
 * functions never `require()` ESM workspace packages at runtime.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

mkdirSync("bundled", { recursive: true });
const entries = [
  ...readdirSync("server")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ entry: join("server", name), out: name.replace(/\.ts$/, ".cjs") })),
  { entry: join("server", "_lib", "ops.ts"), out: "ops.cjs" },
];

for (const { entry, out } of entries) {
  const outfile = join("bundled", out);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
    sourcemap: false,
    legalComments: "none",
    // Keep Node builtins external; inline workspace packages and viem.
    packages: undefined,
    footer: { js: "module.exports = module.exports.default || module.exports;" },
  });
  console.log("bundled", entry, "->", outfile);
}

writeFileSync(join("bundled", ".gitkeep"), "");
