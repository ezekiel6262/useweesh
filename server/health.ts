import type { VercelRequest, VercelResponse } from "@vercel/node";
import ops from "./_lib/ops.js";
import { send } from "./_lib/json.js";
import { tickDueJobs } from "./_lib/recurring.js";
import { XLAYER_TESTNET_DEPLOYMENT } from "./_lib/xlayerTestnet.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const kind = String(req.query.kind ?? "");
  if (req.method === "POST" || (kind && kind !== "health")) {
    return ops(req, res);
  }
  try {
    tickDueJobs().catch(() => undefined);
    send(res, 200, {
      ok: true,
      live: true,
      network: XLAYER_TESTNET_DEPLOYMENT.network,
      chainId: XLAYER_TESTNET_DEPLOYMENT.chainId,
      parser:
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
          ? "gemini"
          : process.env.XAI_API_KEY
            ? "grok"
            : process.env.ANTHROPIC_API_KEY
              ? "claude"
              : "grammar",
      operators: {
        coordinator: Boolean(process.env.COORDINATOR_PRIVATE_KEY),
        solverA: Boolean(process.env.SOLVER_A_PRIVATE_KEY),
        solverB: Boolean(process.env.SOLVER_B_PRIVATE_KEY),
        solverC: Boolean(process.env.SOLVER_C_PRIVATE_KEY),
        solverD: Boolean(process.env.SOLVER_D_PRIVATE_KEY),
      },
    });
  } catch (error) {
    send(res, 503, { ok: false, live: false, error: (error as Error).message });
  }
}
