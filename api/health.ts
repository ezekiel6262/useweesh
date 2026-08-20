import type { VercelRequest, VercelResponse } from "@vercel/node";
import { send } from "./_lib/json.js";
import { loadLiveDeployment } from "./_lib/runtime.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const deployment = loadLiveDeployment();
    send(res, 200, {
      ok: true,
      live: true,
      network: deployment.network,
      chainId: deployment.chainId,
      parser: process.env.XAI_API_KEY ? "grok" : process.env.ANTHROPIC_API_KEY ? "claude" : "grammar",
      operators: {
        coordinator: Boolean(process.env.COORDINATOR_PRIVATE_KEY),
        solverA: Boolean(process.env.SOLVER_A_PRIVATE_KEY),
        solverB: Boolean(process.env.SOLVER_B_PRIVATE_KEY),
      },
    });
  } catch (error) {
    send(res, 503, { ok: false, live: false, error: (error as Error).message });
  }
}
