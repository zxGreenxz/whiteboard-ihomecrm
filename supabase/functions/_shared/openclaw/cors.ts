import { OpenClawHttpError } from "./errors.ts";

export function buildCorsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new OpenClawHttpError(403, "ORIGIN_DENIED", "Origin is not allowed.");
  }
  if (origin === "*" || allowedOrigins.some((entry) => entry.includes("*"))) {
    throw new OpenClawHttpError(500, "CORS_CONFIG_INVALID", "Wildcard origins are forbidden.", {
      expose: false,
    });
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    // `apikey` and `x-client-info` are added by supabase-js on EVERY call: the
    // former by fetchWithAuth, the latter from DEFAULT_HEADERS. A cross-origin POST
    // with a JSON body always preflights, and the browser compares the full
    // Access-Control-Request-Headers list against this one - so omitting them
    // blocked the request before it ever reached the function, with nothing in the
    // server log to show for it. The other browser-invoked functions in this repo
    // (admin-create-user, send-push) already allow exactly these.
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

export function requireNoBrowserOrigin(origin: string | null): void {
  if (origin !== null) {
    throw new OpenClawHttpError(
      403,
      "BROWSER_ORIGIN_FORBIDDEN",
      "Runtime endpoints reject browser Origin headers.",
    );
  }
}
