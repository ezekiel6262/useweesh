import type { VercelRequest, VercelResponse } from "@vercel/node";
import { parseIntentDraft, type Hex } from "@intentos/sdk";
import { StaticIntentFeed } from "@intentos/solver-core";
import { readBody, send } from "./_lib/json.js";
import { liveObservations } from "./_lib/observations.js";
import { makeSolvers } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as { intentId?: string; draft?: unknown };
    if (!body.intentId || !body.draft) return send(res, 400, { error: "missing intentId or draft" });
    const draft = parseIntentDraft(body.draft);
    const feed = new StaticIntentFeed();
    feed.add(body.intentId as Hex, draft);
    try {
      feed.observe(await liveObservations());
    } catch {
      feed.observe({ volume: 2_500_000, funding: 0.012, volatility: 18 });
    }
    let solvers;
    try {
      solvers = makeSolvers(feed);
    } catch (error) {
      return send(res, 200, {
        ok: false,
        activity: [],
        skipped: `solvers unavailable: ${(error as Error).message}`,
      });
    }
    const activity = [];
    for (const solver of solvers) {
      try {
        activity.push(...(await solver.tick()));
      } catch (error) {
        activity.push({
          intentId: body.intentId,
          action: "failed",
          detail: (error as Error).message,
          at: Math.floor(Date.now() / 1000),
        });
      }
    }
    send(res, 200, { ok: true, activity });
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
