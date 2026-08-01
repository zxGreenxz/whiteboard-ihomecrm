import {
  browserOrigins,
  gatewayBindingsAreReachable,
  gatewayConfigurationIsValid,
  type MediaGatewayEnv,
} from "./env";
import { isCanonicalObjectKey } from "./object-key";
import { corsHeadersFor, emptyResponse, errorResponse, jsonResponse } from "./responses";
import { TicketStateStore } from "./ticket-state";
import { handleRevokeGeneration } from "./handlers/revoke-generation";
import { handleUpload } from "./handlers/upload";
import { handleRead } from "./handlers/read";
import { handleDelete } from "./handlers/delete";
import { handleVerify } from "./handlers/verify";
import { pinnedBrowserJwksIsUsable } from "./ticket-verifier";

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

    if (method === "OPTIONS") {
      if (url.pathname === "/v1/object/read") {
        const cors = corsHeadersFor(origin, browserOrigins(env));
        if (cors) return emptyResponse(204, cors);
      }
      return errorResponse("ROUTE_NOT_FOUND", 404);
    }

    if (!isKnownRoute(method, url.pathname)) return errorResponse("ROUTE_NOT_FOUND", 404);

    if (url.pathname === "/health") {
      const locallyValid = await gatewayConfigurationIsValid(env);
      const ready = locallyValid && await gatewayBindingsAreReachable(env) &&
        await pinnedBrowserJwksIsUsable(env);
      return ready
        ? jsonResponse({ status: "ok" }, 200)
        : jsonResponse({ status: "unavailable" }, 503);
    }

    if (isInternalRoute(url.pathname)) {
      // Browser traffic can never reach the revocation route.
      if (origin !== null) return errorResponse("ORIGIN_FORBIDDEN", 403);
      return await handleRevokeGeneration(request, env);
    }

    let cors: Record<string, string> | null = null;
    if (origin !== null) {
      if (method !== "POST" || url.pathname !== "/v1/object/read") {
        return errorResponse("ORIGIN_FORBIDDEN", 403);
      }
      cors = corsHeadersFor(origin, browserOrigins(env));
      if (!cors) return errorResponse("ORIGIN_FORBIDDEN", 403);
    }

    let response: Response;
    if (method === "PUT" && url.pathname === "/v1/object") {
      response = await handleUpload(request, env);
    } else if (method === "POST" && url.pathname === "/v1/object/read") {
      response = await handleRead(request, env);
    } else if (method === "DELETE" && url.pathname === "/v1/object") {
      response = await handleDelete(request, env);
    } else if (method === "POST" && url.pathname === "/v1/object/verify") {
      response = await handleVerify(request, env);
    } else {
      response = errorResponse("NOT_IMPLEMENTED", 501);
    }
    if (cors) {
      for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    }
    return response;
  },
};

export { TicketStateStore };
