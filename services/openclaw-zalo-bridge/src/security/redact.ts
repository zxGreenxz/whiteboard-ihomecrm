const REDACTED = "[REDACTED]";
const MAX_LOG_DEPTH = 16;

const SENSITIVE_KEY = /(?:^|_)(?:authorization|auth|password|passwd|secret|token|credential|cookie|nonce|signature|ticket|receipt|ciphertext|imei|phone|uid|qr|prompt|session|raw_(?:(?:adapter|provider)_?payload|envelope)|api_?key|service_?role|private_?key|revocation)(?:$|_)/i;
const COMPACT_SENSITIVE_KEY = /(?:authorization|claimtoken|markernonce|mediaticket|deleteauthorization|servicerolekey|gatewaytoken|modelapikey|r2signature|r2receipt|revocationsignature|rawadapterpayload|rawproviderpayload|rawpayload|rawenvelope|ciphertext|password|cookie|imei|phone|uid|qrdata|prompt|session)$/i;

const SERIALIZED_SECRET_FIELD = /("(?:authorization|claimToken|markerNonce|password|secret|apiKey|gatewayToken|sessionToken|cookie|ciphertext|imei|x-openclaw-credential)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\]\s]+)/giu;

function isSensitiveKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  const compact = normalized.replaceAll("_", "");
  return SENSITIVE_KEY.test(`_${normalized}_`) || COMPACT_SENSITIVE_KEY.test(compact);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts credentials and common personal identifiers embedded in free text. */
export function redactText(text: string, knownSecretValues: readonly string[] = []): string {
  let output = text;

  output = output.replace(
    /(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/giu,
    "$1[REDACTED]",
  );
  output = output.replace(
    /(\bx-openclaw-(?:credential|media-ticket|delete-authorization|nonce|signature)\s*:\s*)[^\r\n]*/giu,
    "$1[REDACTED]",
  );
  output = output.replace(
    /(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;&]+/gi,
    "$1[REDACTED_TOKEN]",
  );
  output = output.replace(
    /([?&](?:x-amz-(?:signature|credential|security-token)|signature|ticket|token|access_token)=)[^&#\s]*/gi,
    "$1[REDACTED]",
  );
  output = output.replace(SERIALIZED_SECRET_FIELD, '$1"[REDACTED]"');
  output = output.replace(
    /(\b(?:claimToken|markerNonce|password|secret|apiKey|gatewayToken|sessionToken|cookie|ciphertext)\s*[:=]\s*)[^\s,;&]+/gi,
    "$1[REDACTED]",
  );
  output = output.replace(/(\bIMEI\s*[:=]\s*)[0-9A-Za-z_-]+/giu, "$1[REDACTED]");
  output = output.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
  output = output.replace(/\b(?:\+?84|0)(?:[ .-]?\d){9}\b/g, "[REDACTED_PHONE]");
  output = output.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]");
  output = output.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[REDACTED_QR]");

  const secrets = [...new Set(knownSecretValues.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }

  return output;
}

/** Creates a detached, JSON-safe value suitable for structured operational logs. */
export function redactLogValue(
  value: unknown,
  knownSecretValues: readonly string[] = [],
): unknown {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown, depth: number): unknown => {
    if (typeof candidate === "string") return redactText(candidate, knownSecretValues);
    if (
      candidate === null ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) return candidate;
    if (typeof candidate === "bigint") return candidate.toString();
    if (typeof candidate === "undefined") return undefined;
    if (typeof candidate === "function" || typeof candidate === "symbol") return `[${typeof candidate}]`;
    if (depth >= MAX_LOG_DEPTH) return "[TRUNCATED]";

    if (candidate instanceof Error) {
      return {
        name: redactText(candidate.name, knownSecretValues),
        message: redactText(candidate.message, knownSecretValues),
        ...(candidate.stack
          ? { stack: redactText(candidate.stack, knownSecretValues) }
          : {}),
      };
    }
    if (candidate instanceof Date) return candidate.toISOString();
    if (ArrayBuffer.isView(candidate)) return `[BINARY:${candidate.byteLength}]`;
    if (candidate instanceof ArrayBuffer) return `[BINARY:${candidate.byteLength}]`;

    if (typeof candidate !== "object") return String(candidate);
    if (seen.has(candidate)) return "[CIRCULAR]";
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      return candidate.map((entry) => visit(entry, depth + 1));
    }

    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(candidate)) {
      Object.defineProperty(redacted, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: isSensitiveKey(key) ? REDACTED : visit(entry, depth + 1),
      });
    }
    return redacted;
  };

  return visit(value, 0);
}
