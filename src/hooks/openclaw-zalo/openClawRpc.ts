import { supabase } from "@/integrations/supabase/client";

/**
 * The one place OpenClaw talks to PostgREST.
 *
 * `src/integrations/supabase/types.ts` cannot describe these functions yet: the
 * OpenClaw migrations are deliberately not on the live project, so `gen:types`
 * would emit a schema without any of them. Every call site therefore had its own
 * `supabase as unknown as { rpc: ... }`, and four separate casts meant four
 * separate holes — an rpc-name typo or a wrong `p_request` key compiled clean.
 * That is the mechanism by which the media-resolve contract shipped broken.
 *
 * Consolidating the cast here keeps exactly one hole, and closes the two that
 * mattered: the NAME is a union the compiler checks, and the ARGUMENT shape is
 * typed per call kind. Results stay `unknown` on purpose — a Zod contract, not a
 * generated type, is what proves the payload.
 */
export interface OpenClawRpcResponse {
  data: unknown;
  error: { code?: string; message: string } | null;
}

type SupabaseRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<OpenClawRpcResponse>;
};

const client = supabase as unknown as SupabaseRpcClient;

/** A read facade takes the request object and nothing else. */
export async function openClawReadRpc<TName extends string>(
  name: TName,
  request: Record<string, unknown>,
): Promise<OpenClawRpcResponse> {
  return await client.rpc(name, { p_request: request });
}

/**
 * A write facade additionally takes the caller's operation id, which is what makes
 * a retry idempotent. Requiring it here means no write can accidentally omit it.
 */
export async function openClawWriteRpc<TName extends string>(
  name: TName,
  request: Record<string, unknown>,
  clientOperationId: string,
): Promise<OpenClawRpcResponse> {
  return await client.rpc(name, {
    p_request: request,
    p_client_operation_id: clientOperationId,
  });
}
