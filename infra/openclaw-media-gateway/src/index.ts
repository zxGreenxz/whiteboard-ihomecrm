import { browserOrigins, type MediaGatewayEnv } from "./env";
import { isCanonicalObjectKey } from "./object-key";
import { corsHeadersFor, errorResponse, jsonResponse } from "./responses";
import { TicketStateStore } from "./ticket-state";

export { TicketStateDurableObject as TicketState } from "./ticket-state-do";

/**
 * The complete public surface of the gateway. Anything else is a 404 before any
 * binding is touched.
 */
export const GATEWAY_ROUTES = Object.freeze([
  "PUT /v1/object",
  "POST /v1/object/read",
  "POST /v1/object/verify",
  "DELETE /v1/object",
  "POST /v1/internal/revoke-generation",
  "GET /health",
] as const);

export function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
}

export function isKnownRoute(method: string, pathname: string): boolean {
  return (GATEWAY_ROUTES as readonly string[]).includes(routeKey(method, pathname));
}

/** The internal revocation route never speaks CORS and never sees a browser. */
export function isInternalRoute(pathname: string): boolean {
  return pathname.startsWith("/v1/internal/");
}

export default {
  async fetch(request: Request, env: MediaGatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const origin = request.headers.get("origin");

    if (!isKnownRoute(method, url.pathname)) {
      if (method === "OPTIONS" && !isInternalRoute(url.pathname)) {
        const cors = corsHeadersFor(origin, browserOrigins(env));
        if (cors) return new Response(null, { status: 204, headers: cors });
      }
      return errorResponse("ROUTE_NOT_FOUND", 404);
    }

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok" }, 200);
    }

    if (isInternalRoute(url.pathname)) {
      // Browser traffic can never reach the revocation route.
      if (origin !== null) return errorResponse("ORIGIN_FORBIDDEN", 403);
      return errorResponse("NOT_IMPLEMENTED", 501);
    }

    return errorResponse("NOT_IMPLEMENTED", 501);
  },
};

export { TicketStateStore };