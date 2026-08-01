import { base64UrlEncode, canonicalJson, signEs256, utf8 } from "../_shared/openclaw/crypto.ts";
import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { createBrowserSupabaseClient } from "../_shared/openclaw/supabase.ts";
import { handleObjectTicketRequest } from "./handler.ts";

const environment = parseOpenClawEnvironment(Deno.env.toObject());

const privateKeyPkcs8 = Deno.env.get("OPENCLAW_TICKET_PRIVATE_KEY_B64")?.trim() ?? "";
if (privateKeyPkcs8.length === 0) {
  throw new Error("OPENCLAW_TICKET_PRIVATE_KEY_B64 is required.");
}

const signingKey = await crypto.subtle.importKey(
  "pkcs8",
  Uint8Array.from(atob(privateKeyPkcs8), (character) => character.charCodeAt(0)),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);

Deno.serve((request: Request) =>
  handleObjectTicketRequest(request, {
    environment,
    createBrowserClient: createBrowserSupabaseClient,
    signTicket: async (claims) =>
      base64UrlEncode(await signEs256(signingKey, utf8(canonicalJson(claims)))),
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);