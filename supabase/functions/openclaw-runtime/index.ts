import { parseOpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { verifyRuntimeRequest } from "../_shared/openclaw/runtime-auth.ts";
import { createAdminSupabaseClient } from "../_shared/openclaw/supabase.ts";
import { handleRuntimeRequest } from "./handler.ts";
import { loadTicketSigningConfiguration } from "./ticket-keyring.ts";

const source = Deno.env.toObject();
const environment = parseOpenClawEnvironment(source);
const ticketSigning = await loadTicketSigningConfiguration(source);

Deno.serve((request: Request) =>
  handleRuntimeRequest(request, {
    environment,
    createServiceClient: createAdminSupabaseClient,
    verifyRuntimeRequest,
    signGatewayPayload: ticketSigning.signGatewayPayload,
    ticketKeyGeneration: ticketSigning.ticketKeyGeneration,
    historicalTicketSigningKeys: ticketSigning.historicalTicketSigningKeys,
    logger: {
      error: (message, context) => console.error(message, context),
    },
  })
);
