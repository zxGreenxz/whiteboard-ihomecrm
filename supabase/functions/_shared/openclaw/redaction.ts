const REDACTED = "[REDACTED]";

const SECRET_KEY_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "claimtoken",
  "markernonce",
  "xopenclawmediaticket",
  "xopenclawdeleteauthorization",
  "supabaseaccesstoken",
  "supabasepat",
  "supabaseservicerolekey",
  "supabaseanonkey",
  "gatewaytoken",
  "gatewayreceipt",
  "credential",
  "workloadcredential",
  "runtimecredential",
  "cellcredential",
  "maintenancecredential",
  "workloadtoken",
  "runtimetoken",
  "runtimetokensigningkey",
  "ticket",
  "signature",
  "cookie",
  "setcookie",
  "session",
  "sessionid",
  "sessiontoken",
  "sessionsecret",
  "sessionciphertext",
  "imei",
  "phone",
  "phonenumber",
  "qrpayload",
  "qrdata",
  "qrcode",
  "qrtoken",
  "ciphertext",
  "modelapikey",
  "openaiapikey",
  "anthropicapikey",
  "googleapikey",
  "geminiapikey",
  "r2signature",
  "r2ticket",
  "r2receipt",
  "receipt",
  "revocationsignature",
  "accesstoken",
  "refreshtoken",
  "servicerolekey",
  "password",
  "secret",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(input: unknown, knownSecrets: string[] = []): string {
  let output = String(input ?? "");
  for (const secret of [...knownSecrets]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length)) {
    output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }

  const replacements: Array<[RegExp, string]> = [
    [/\bsbp_[A-Za-z0-9_-]+\b/gi, "[REDACTED_PAT]"],
    [
      /\b(authorization\s*:\s*(?:bearer|basic))\s+[^\s,;]+/gi,
      "$1 [REDACTED_TOKEN]",
    ],
    [
      /["']?(authorization|proxyAuthorization|claimToken|markerNonce|credential|workloadCredential|runtimeToken|runtimeTokenSigningKey|ticket|signature|session|sessionId|access_token|refresh_token|service_role_key|password|cookie|set-cookie|imei|qrPayload|qrData|qrCode|qrToken)["']?\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]\r\n]+)/gi,
      "$1$2[REDACTED_SECRET]",
    ],
    [
      /([?&](?:token|ticket|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&#\s]+/gi,
      "$1[REDACTED_SECRET]",
    ],
    [
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{5,})?\b/g,
      "[REDACTED_JWT]",
    ],
    [/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi, "[REDACTED_QR]"],
    [/(?<![A-Za-z0-9])(?:\+?84|0)\d{8,10}(?![A-Za-z0-9])/g, "[REDACTED_PHONE]"],
  ];
  for (const [pattern, replacement] of replacements) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactLogValue(
  value: unknown,
  knownSecrets: string[] = [],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: redactText(value.name, knownSecrets),
      message: redactText(value.message, knownSecrets),
      stack: value.stack ? redactText(value.stack, knownSecrets) : undefined,
    };
  }
  if (typeof value !== "object") return redactText(value, knownSecrets);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactLogValue(entry, knownSecrets, seen));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_KEY_NAMES.has(normalizedKey(key))
      ? REDACTED
      : redactLogValue(entry, knownSecrets, seen);
  }
  return result;
}
