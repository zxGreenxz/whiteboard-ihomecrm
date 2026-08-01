import { createHash } from "node:crypto";

/**
 * Canonical JSON + checksum helpers shared by the spool and the drain worker.
 * The spool stores canonical bytes so a checksum can prove a row was not
 * silently corrupted on disk.
 */

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>).sort();
    return `{${
      entries
        .map((key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
        )
        .join(",")
    }}`;
  }
  throw new TypeError("Unsupported canonical JSON value.");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function payloadChecksum(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * The fallback fingerprint is used only when the provider gave neither a stable
 * event id nor a stable message id. It is explicitly at-least-once: two
 * genuinely different events can collide, which the caller must report.
 */
export function fallbackFingerprint(input: {
  organizationId: string;
  accountId: string;
  eventKind: string;
  providerConversationId: string;
  providerSenderId: string;
  sourceTimestamp: string;
  providerEventType: string;
  content: unknown;
  mediaChecksums: readonly (string | null)[];
}): string {
  return sha256Hex(`ihome-openclaw-inbound-fallback-v1\0${canonicalJson(input)}`);
}
