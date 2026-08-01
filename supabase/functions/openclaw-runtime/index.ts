import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { verifyRuntimeRequest } from "../_shared/openclaw/runtime-auth.ts";
import { createAdminSupabaseClient } from "../_shared/openclaw/supabase.ts";
import { handleRuntimeRequest } from "./handler.ts";

const environment = parseOpenClawEnvironment(Deno.env.toObject());

Deno.serve((request: Request) =>
  handleRuntimeRequest(request, {
    environment,
    createServiceClient: createAdminSupabaseClient,
    verifyRuntimeRequest,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);