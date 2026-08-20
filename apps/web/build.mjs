#!/usr/bin/env node
/**
 * Bundle the playground for the browser.
 *
 * esbuild reads the workspace packages directly, so there is no build ordering to get right and
 * no compiled `dist` to depend on — which is what keeps this deployable from a bare checkout.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/browser.ts"],
  outfile: "public/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  // Never reached in the browser build — the playground parses with the grammar — but the
  // dynamic import still needs somewhere to go, and the SDK is Node-only.
  external: ["@anthropic-ai/sdk", "@anthropic-ai/sdk/helpers/zod"],
  define: { "process.env.NODE_ENV": '"production"', "process.env.ANTHROPIC_API_KEY": "undefined" },
});

console.log("built public/app.js");
