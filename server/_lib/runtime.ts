import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import {
  IntentOSClient,
  catalogFromDeployment,
  type DeploymentFile,
} from "@intentos/sdk";
import { IntentKind, SolverCapability } from "@intentos/intent-schema";
import { AGGRESSIVE, CONSERVATIVE, PAYROLL, RWA_DESK, Coordinator, Solver, StaticIntentFeed } from "@intentos/solver-core";
import { XLAYER_TESTNET_DEPLOYMENT } from "./xlayerTestnet.js";

export function loadLiveDeployment(): DeploymentFile {
  if (process.env.INTENTOS_DEPLOYMENT_JSON) {
    return JSON.parse(process.env.INTENTOS_DEPLOYMENT_JSON) as DeploymentFile;
  }
  const file = join(process.cwd(), "deployments", "xlayerTestnet.json");
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as DeploymentFile;
  }
  return XLAYER_TESTNET_DEPLOYMENT;
}

export function rpcUrl(): string {
  return process.env.INTENTOS_RPC ?? process.env.XLAYER_TESTNET_RPC ?? "https://testrpc.xlayer.tech";
}

export function reader(): IntentOSClient {
  return new IntentOSClient({ deployment: loadLiveDeployment(), rpcUrl: rpcUrl() });
}

function key(name: string): Hex | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  return (value.startsWith("0x") ? value : `0x${value}`) as Hex;
}

export function operatorClient(envName: string): IntentOSClient {
  const privateKey = key(envName);
  if (!privateKey) throw new Error(`missing ${envName}`);
  return new IntentOSClient({
    deployment: loadLiveDeployment(),
    rpcUrl: rpcUrl(),
    privateKey,
  });
}

export function makeSolvers(feed: StaticIntentFeed) {
  const gaslessRwa = SolverCapability.AI | SolverCapability.RWA | SolverCapability.STABLE | SolverCapability.GASLESS;
  const a = new Solver({
    client: operatorClient("SOLVER_A_PRIVATE_KEY"),
    feed,
    strategy: AGGRESSIVE,
    kyb: false,
    capabilities: gaslessRwa,
  });
  const b = new Solver({
    client: operatorClient("SOLVER_B_PRIVATE_KEY"),
    feed,
    strategy: CONSERVATIVE,
    kyb: true,
    capabilities:
      SolverCapability.COMPLIANT |
      SolverCapability.RWA |
      SolverCapability.STABLE |
      SolverCapability.AGENT |
      SolverCapability.GASLESS,
  });
  const solvers = [a, b];
  if (key("SOLVER_C_PRIVATE_KEY")) {
    solvers.push(
      new Solver({
        client: operatorClient("SOLVER_C_PRIVATE_KEY"),
        feed,
        strategy: RWA_DESK,
        kyb: false,
        capabilities: SolverCapability.RWA | SolverCapability.AGENT | SolverCapability.GASLESS,
        acceptKinds: [IntentKind.RWA_ONBOARD, IntentKind.BASKET, IntentKind.REBALANCE],
        requireAttested: true,
      }),
    );
  }
  if (key("SOLVER_D_PRIVATE_KEY")) {
    solvers.push(
      new Solver({
        client: operatorClient("SOLVER_D_PRIVATE_KEY"),
        feed,
        strategy: PAYROLL,
        kyb: false,
        capabilities: SolverCapability.STABLE | SolverCapability.GASLESS,
        acceptKinds: [IntentKind.PAYMENT],
      }),
    );
  }
  return solvers;
}

export function makeCoordinator(): Coordinator {
  return new Coordinator({ client: operatorClient("COORDINATOR_PRIVATE_KEY") });
}

export function catalog() {
  return catalogFromDeployment(loadLiveDeployment());
}
