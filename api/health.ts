export const config = { maxDuration: 60 };

export default async function handler(req: { method?: string; query?: Record<string, unknown> }, res?: { statusCode: number; setHeader: Function; end: Function }) {
  const payload = JSON.stringify({
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
  });
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (req?.method === "POST" || (req?.query?.kind && String(req.query.kind) !== "health")) {
    const { default: ops } = await import("../server/_lib/ops");
    return ops(req as any, res as any);
  }
  if (res && typeof res.end === "function") {
    res.statusCode = req?.method === "OPTIONS" ? 204 : 200;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(req?.method === "OPTIONS" ? "" : payload);
    return;
  }
  return new Response(req?.method === "OPTIONS" ? null : payload, {
    status: req?.method === "OPTIONS" ? 204 : 200,
    headers,
  });
}
