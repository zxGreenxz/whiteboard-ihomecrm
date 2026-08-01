import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import {
  createAdminSupabaseClient,
  createBrowserSupabaseClient,
} from "../_shared/openclaw/supabase.ts";
import { handleControlRequest } from "./handler.ts";
import { createGenerationRevocationPropagator } from "./revocation.ts";

// index.ts only wires the runtime: serve, environment, and clients. All policy
// lives in handler.ts so it stays unit-testable without a live Deno server.
const environment = parseOpenClawEnvironment(Deno.env.toObject());
const propagateGenerationRevocation = createGenerationRevocationPropagator({
  gatewayUrl: Deno.env.get("OPENCLAW_MEDIA_GATEWAY_URL")?.trim() ?? "",
  privateKeyPkcs8B64: Deno.env.get("OPENCLAW_MEDIA_REVOCATION_PRIVATE_KEY_PKCS8_B64")?.trim() ?? "",
  keyGeneration: Number(Deno.env.get("OPENCLAW_MEDIA_REVOCATION_KEY_GENERATION") ?? ""),
});

Deno.serve((request: Request) =>
  handleControlRequest(request, {
    environment,
    createBrowserClient: createBrowserSupabaseClient,
    createAdminClient: createAdminSupabaseClient,
    propagateGenerationRevocation,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);
