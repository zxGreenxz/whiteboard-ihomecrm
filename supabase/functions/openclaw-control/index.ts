import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { createBrowserSupabaseClient } from "../_shared/openclaw/supabase.ts";
import { handleControlRequest } from "./handler.ts";

// index.ts only wires the runtime: serve, environment, and clients. All policy
// lives in handler.ts so it stays unit-testable without a live Deno server.
const environment = parseOpenClawEnvironment(Deno.env.toObject());

Deno.serve((request: Request) =>
  handleControlRequest(request, {
    environment,
    createBrowserClient: createBrowserSupabaseClient,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);