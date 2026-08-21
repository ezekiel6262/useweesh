import type { VercelRequest, VercelResponse } from "@vercel/node";
import { conditionsHold, parseIntentDraft, type Hex } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { liveObservations } from "./_lib/observations.js";
import { makeCoordinator } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as { intentId?: string; draft?: unknown };
    if (!body.intentId || !body.draft) return send(res, 400, { error: "missing intentId or draft" });
    const draft = parseIntentDraft(body.draft);
    try {
      const observations = await liveObservations();
      const gate = conditionsHold(draft, observations);
      if (!gate.hold) {
        return send(res, 200, {
          intentId: body.intentId,
          ranking: [],
          skipped: `conditions not met: ${gate.failed.join("; ")}`,
          observations,
        });
      }
    } catch {
      // If the feed is down, close as usual rather than stall the auction.
    }
    const report = await makeCoordinator().close(body.intentId as Hex, draft);
    send(res, 200, report);
  } catch (error) {
    send(res, 200, {
      intentId: (readBody(req) as { intentId?: string })?.intentId,
      ranking: [],
      skipped: (error as Error).message,
    });
  }
}
