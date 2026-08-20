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

export function send(res: { setHeader: Function; status: Function }, status: number, value: unknown) {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.status(status).send(encode(value));
}
