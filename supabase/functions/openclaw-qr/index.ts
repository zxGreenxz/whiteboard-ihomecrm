import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import {
  createAdminSupabaseClient,
  createBrowserSupabaseClient,
} from "../_shared/openclaw/supabase.ts";
import { createQrRequestHandler } from "./handler.ts";

const baseEnvironment = parseOpenClawEnvironment(Deno.env.toObject());
const handleQrRequest = await createQrRequestHandler(
  {
    environment: baseEnvironment,
    createBrowserClient: createBrowserSupabaseClient,
    createAdminClient: createAdminSupabaseClient,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  },
  Deno.env.get("OPENCLAW_QR_ENCRYPTION_KEY_B64")?.trim() ?? "",
);

Deno.serve(handleQrRequest);
