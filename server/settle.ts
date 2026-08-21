import type { VercelRequest, VercelResponse } from "@vercel/node";
import { IntentStatus, parseIntentDraft, type Hex } from "@intentos/sdk";
import { StaticIntentFeed } from "@intentos/solver-core";
import { readBody, send } from "./_lib/json.js";
import { makeSolvers, reader } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as { intentId?: string; draft?: unknown };
    if (!body.intentId || !body.draft) return send(res, 400, { error: "missing intentId or draft" });
    const intentId = body.intentId as Hex;
    const draft = parseIntentDraft(body.draft);
    const record = await reader().getIntent(intentId);
    if (record.status !== IntentStatus.SELECTED) {
      return send(res, 409, { error: `intent is ${IntentStatus[record.status]}, not selected` });
    }

    const feed = new StaticIntentFeed();
    feed.add(intentId, draft);
    const solvers = makeSolvers(feed);
    const activity = [];
    for (const solver of solvers) {
      activity.push(...(await solver.tick()));
    }
    send(res, 200, { ok: true, activity });
  } catch (error) {
    send(res, 200, { ok: false, activity: [], error: (error as Error).message });
  }
}
