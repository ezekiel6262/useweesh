const TAG = "n:";

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${TAG}${item}` : item));
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_key, item) =>
    typeof item === "string" && item.startsWith(TAG) ? BigInt(item.slice(TAG.length)) : item,
  ) as T;
}

export function readBody(req: { body?: unknown }): unknown {
  if (req.body == null || req.body === "") return undefined;
  if (typeof req.body === "string") return decode(req.body);
  return decode(encode(req.body));
}

export function send(res: any, status: number, value: unknown) {
  const body = encode(value);
  if (res && typeof res.setHeader === "function") {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.statusCode = status;
    if (typeof res.end === "function") {
      res.end(body);
      return;
    }
    if (typeof res.status === "function") {
      res.status(status).send(body);
      return;
    }
  }
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
