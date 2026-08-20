import type { VercelRequest, VercelResponse } from "@vercel/node";
import { parseIntentDraft, type Hex } from "@intentos/sdk";
import { readBody, send } from "./_lib/json.js";
import { makeCoordinator } from "./_lib/runtime.js";

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });

  try {
    const body = (readBody(req) ?? {}) as { intentId?: string; draft?: unknown };
    if (!body.intentId || !body.draft) return send(res, 400, { error: "missing intentId or draft" });
    const report = await makeCoordinator().close(body.intentId as Hex, parseIntentDraft(body.draft));
    send(res, 200, report);
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
