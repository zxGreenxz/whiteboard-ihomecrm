/**
 * Response helpers. Every gateway response is private, uncacheable, and never
 * sniffable. Object bodies are always attachments so a stored file can never be
 * rendered inline by a browser.
 */

const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-site",
};

export function jsonResponse(body: unknown, status: number, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}

export function errorResponse(code: string, status: number, extra: Record<string, string> = {}) {
  // Only a stable code travels back: no upstream text, no key, no ticket data.
  return jsonResponse({ error: { code } }, status, extra);
}

export function objectResponse(
  body: ReadableStream | ArrayBuffer | null,
  contentType: string,
  fileName: string,
) {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return new Response(body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
    },
  });
}

export function corsHeadersFor(
  origin: string | null,
  allowedOrigins: readonly string[],
): Record<string, string> | null {
  if (!origin || !allowedOrigins.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-openclaw-media-ticket",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}