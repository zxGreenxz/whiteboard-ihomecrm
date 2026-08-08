// Byte-identical to the canonicalisation the control plane signs and verifies
// with (`supabase/functions/_shared/openclaw/crypto.ts`). A receipt this service
// signs is verified there against the same bytes, so any divergence here - key
// ordering, number formatting, escaping - turns every upload into
// GATEWAY_RECEIPT_INVALID with nothing in the message to say why.

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${
      Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(",")
    }}`;
  }
  throw new TypeError("Unsupported canonical JSON value.");
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid base64url value.");
  return new Uint8Array(Buffer.from(value, "base64url"));
}
