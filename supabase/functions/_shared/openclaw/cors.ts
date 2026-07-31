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
    "Access-Control-Allow-Headers": "authorization, content-type, x-request-id",
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
