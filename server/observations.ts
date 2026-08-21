import type { VercelRequest, VercelResponse } from "@vercel/node";
import { send } from "./_lib/json.js";
import { liveObservations } from "./_lib/observations.js";

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  try {
    send(res, 200, await liveObservations());
  } catch (error) {
    send(res, 500, { error: (error as Error).message });
  }
}
