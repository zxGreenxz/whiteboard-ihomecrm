import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import {
  createAdminSupabaseClient,
  createBrowserSupabaseClient,
} from "../_shared/openclaw/supabase.ts";
import { handleQrRequest } from "./handler.ts";

const baseEnvironment = parseOpenClawEnvironment(Deno.env.toObject());
const qrEncryptionKeyB64 = Deno.env.get("OPENCLAW_QR_ENCRYPTION_KEY_B64")?.trim() ?? "";
if (qrEncryptionKeyB64.length === 0) {
  throw new Error("OPENCLAW_QR_ENCRYPTION_KEY_B64 is required.");
}

const environment = { ...baseEnvironment, qrEncryptionKeyB64 };

Deno.serve((request: Request) =>
  handleQrRequest(request, {
    environment,
    createBrowserClient: createBrowserSupabaseClient,
    createAdminClient: createAdminSupabaseClient,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);