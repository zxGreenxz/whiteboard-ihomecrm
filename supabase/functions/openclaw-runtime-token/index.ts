import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { exchangeRuntimeCredential } from "../_shared/openclaw/runtime-auth.ts";
import { createAdminSupabaseClient } from "../_shared/openclaw/supabase.ts";
import { handleRuntimeTokenRequest } from "./handler.ts";

const environment = parseOpenClawEnvironment(Deno.env.toObject());

Deno.serve((request: Request) =>
  handleRuntimeTokenRequest(request, {
    environment,
    createServiceClient: createAdminSupabaseClient,
    exchangeRuntimeCredential,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);