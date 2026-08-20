import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DeploymentFile } from "@intentos/intent-ai";

/**
 * Finds the deployment the tooling should talk to.
 *
 * Order: an explicit path, then INTENTOS_DEPLOYMENT, then the network named by
 * INTENTOS_NETWORK, then whichever local deployment exists. Nothing is guessed — if no
 * deployment file is found the caller is told exactly where it looked.
 */
export function loadDeployment(pathOrNetwork?: string): DeploymentFile {
  const candidates = deploymentCandidates(pathOrNetwork);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")) as DeploymentFile;
    }
  }
  throw new Error(
    `no IntentOS deployment found. Looked at:\n  ${candidates.join("\n  ")}\n` +
      `Run \`npm run deploy:local\` first, or set INTENTOS_DEPLOYMENT to a deployment file.`,
  );
}

function deploymentCandidates(pathOrNetwork?: string): string[] {
  const root = repoRoot();
  const dir = process.env.INTENTOS_DEPLOYMENTS_DIR ?? join(root, "deployments");
  const names = [pathOrNetwork, process.env.INTENTOS_NETWORK, "localhost", "hardhat", "xlayerTestnet"].filter(
    Boolean,
  ) as string[];

  const candidates: string[] = [];
  if (pathOrNetwork?.endsWith(".json")) candidates.push(resolve(pathOrNetwork));
  if (process.env.INTENTOS_DEPLOYMENT) candidates.push(resolve(process.env.INTENTOS_DEPLOYMENT));
  for (const name of names) candidates.push(join(dir, `${name}.json`));
  return [...new Set(candidates)];
}

/** Walk up until the workspace root (the directory holding `deployments` or the root manifest). */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "deployments")) || existsSync(join(dir, "tsconfig.base.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
