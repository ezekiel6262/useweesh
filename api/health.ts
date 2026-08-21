import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method === "POST" || (req.query.kind && String(req.query.kind) !== "health")) {
    const { default: ops } = await import("../server/_lib/ops");
    return ops(req, res);
  }
  res.status(200).send(
    JSON.stringify({
      ok: true,
      live: true,
      network: "xlayerTestnet",
      chainId: 1952,
      parser: "live",
      operators: {
        coordinator: Boolean(process.env.COORDINATOR_PRIVATE_KEY),
        solverA: Boolean(process.env.SOLVER_A_PRIVATE_KEY),
        solverB: Boolean(process.env.SOLVER_B_PRIVATE_KEY),
        solverC: Boolean(process.env.SOLVER_C_PRIVATE_KEY),
        solverD: Boolean(process.env.SOLVER_D_PRIVATE_KEY),
      },
    }),
  );
}
