#!/usr/bin/env node
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

mkdirSync("api", { recursive: true });
const entries = readdirSync("server").filter((name) => name.endsWith(".ts"));

for (const name of entries) {
  const outfile = join("api", name.replace(/\.ts$/, ".js"));
  await build({
    entryPoints: [join("server", name)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
    footer: { js: "module.exports = module.exports.default || module.exports;" },
  });
  console.log("bundled", name, "->", outfile);
}
