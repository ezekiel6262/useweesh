/**
 * JSON that survives bigints.
 *
 * Every amount in IntentOS is a bigint in base units, and JSON has no way to carry one without
 * losing precision above 2^53. Tagged strings keep the round trip exact in both directions, and
 * a client that does not decode them still sees a readable number rather than a mangled one.
 */

const TAG = "n:";

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${TAG}${item}` : item));
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_key, item) =>
    typeof item === "string" && item.startsWith(TAG) ? BigInt(item.slice(TAG.length)) : item,
  ) as T;
}

/** Plain JSON with bigints rendered as decimal strings, for readers that do not decode tags. */
export function toPlain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)));
}
