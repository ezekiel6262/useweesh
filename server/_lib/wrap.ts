/**
 * Load-safe JSON wrapper for Vercel. Heavy handlers import viem/SDK and can throw
 * at module eval; the platform then returns "A server error has occurred" as text.
 * Catch that here and always `res.end` JSON so the app can parse the body.
 */

export function jsonSend(res: any, status: number, value: unknown) {
  const body = JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `n:${item}` : item));
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  };
  if (res && typeof res.end === "function") {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(status === 204 ? "" : body);
    return;
  }
  return new Response(status === 204 ? null : body, { status, headers });
}

export function wrapHandler(load: () => Promise<any>) {
  return async function handler(req: any, res: any) {
    if (req?.method === "OPTIONS") return jsonSend(res, 204, {});
    try {
      const mod = await load();
      const impl = typeof mod === "function" ? mod : (mod?.default ?? mod);
      const fn = typeof impl === "function" ? impl : impl?.default;
      if (typeof fn !== "function") throw new Error("handler export missing");
      return await fn(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonSend(res, 500, { error: message || "handler failed to load" });
    }
  };
}
