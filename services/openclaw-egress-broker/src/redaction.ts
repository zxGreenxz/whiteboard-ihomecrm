/**
 * Broker log redaction. Proxy credentials, tokens, and ticket headers must never
 * reach a log line, even when a connection fails and the error text quotes the
 * original request.
 */

const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-openclaw-credential",
  "x-openclaw-media-ticket",
  "x-openclaw-delete-authorization",
  "cookie",
  "set-cookie",
]);

export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    result[name] = SECRET_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : value;
  }
  return result;
}

export function redactConnectTarget(target: string): string {
  // A CONNECT line may carry userinfo; strip it before logging.
  return target.replace(
    /^(?:([a-z][a-z0-9+.-]*:\/\/))?[^@/\s]+@/i,
    (_match, scheme: string | undefined) => `${scheme ?? ""}[REDACTED]@`,
  );
}

export function redactLogLine(line: string): string {
  return line
    .replace(
      /\b(proxy-authorization|authorization|cookie|set-cookie|x-openclaw-(?:credential|media-ticket|delete-authorization))\s*:\s*[^\r\n]*/gi,
      (_match, name: string) => `${name}: [REDACTED]`,
    )
    .replace(/\/\/[^@\s/]*@/g, "//[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{5,})?\b/g, "[REDACTED_JWT]");
}
