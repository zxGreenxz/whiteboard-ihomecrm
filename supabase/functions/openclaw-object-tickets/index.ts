import { base64UrlEncode, canonicalJson, signEs256, utf8 } from "../_shared/openclaw/crypto.ts";
import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { createBrowserSupabaseClient } from "../_shared/openclaw/supabase.ts";
import { handleObjectTicketRequest, importObjectTicketSigningKey } from "./handler.ts";

const environment = parseOpenClawEnvironment(Deno.env.toObject());

const gatewayKeyGeneration = Number(
  Deno.env.get("OPENCLAW_TICKET_KEY_GENERATION")?.trim() ?? "",
);
if (!Number.isSafeInteger(gatewayKeyGeneration) || gatewayKeyGeneration < 1) {
  throw new Error("OPENCLAW_TICKET_KEY_GENERATION must be a positive integer.");
}

const signingKey = await importObjectTicketSigningKey(
  Deno.env.get("OPENCLAW_TICKET_PRIVATE_KEY_B64")?.trim() ?? "",
);

Deno.serve((request: Request) =>
  handleObjectTicketRequest(request, {
    environment,
    createBrowserClient: createBrowserSupabaseClient,
    signTicket: async (claims) =>
      base64UrlEncode(await signEs256(signingKey, utf8(canonicalJson(claims)))),
    gatewayKeyGeneration,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);
