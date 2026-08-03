import { supabase } from "@/integrations/supabase/client";

/**
 * The QR login flow goes through the `openclaw-qr` EDGE FUNCTION, not through
 * `supabase.rpc`.
 *
 * This is not a stylistic choice. The scannable code is AES-256-GCM ciphertext in
 * the database; the only key lives in the Edge function's `OPENCLAW_QR_ENCRYPTION_KEY_B64`
 * environment, and the browser-facing SQL RPC `openclaw_consume_qr_challenge_v1`
 * deliberately returns `{challengeId, status, materialVersion}` with no ciphertext
 * at all. A client that calls the RPC directly can never obtain a QR to display.
 *
 * The function is a single slug with no internal routing: one POST, and the
 * `operation` field in the body selects BEGIN, POLL or CONSUME.
 */
const FUNCTION_SLUG = "openclaw-qr";

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
}

/**
 * SHA-256 of the JWT's `session_id` claim.
 *
 * The server re-derives exactly this from the Authorization header and rejects a
 * mismatch with 403 SESSION_BINDING_INVALID before running any RPC, so it has to be
 * this value and no other. An earlier version hashed `organizationId:actorId` -
 * both public, identical on every device, and unchanged by logout - which would
 * have been refused by the server on every call while also binding nothing.
 */
export async function browserSessionHash(accessToken: string) {
  const [, payload] = accessToken.split(".");
  if (!payload) throw new Error("access token is not a JWT");
  const claims = JSON.parse(base64UrlDecode(payload)) as { session_id?: unknown };
  if (typeof claims.session_id !== "string" || claims.session_id.length === 0) {
    throw new Error("access token carries no session_id");
  }
  return sha256Hex(claims.session_id);
}

export interface QrChallengeSnapshot {
  challengeId: string;
  challengeStatus: "PENDING" | "READY" | "EXPIRED" | "CONSUMED" | "REVOKED";
  expiresAt: string;
  issuedAt: string;
}

export interface QrBeginResult {
  challengeId: string;
  issuedAt: string;
  expiresAt: string;
}

async function callQrFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(FUNCTION_SLUG, {
    // `invoke` attaches the caller's Authorization header, which the function
    // forwards to PostgREST - BEGIN and POLL run as the signed-in user, only
    // CONSUME switches to the service role, server-side.
    body,
  });
  if (error) throw error;
  if (data == null) throw new Error("QR endpoint returned no body");
  return data;
}

/**
 * Requests a challenge. `browserNonce` never leaves this machine; only its digest
 * is sent, so a challenge row alone cannot be completed by anyone who did not mint
 * it here.
 */
export async function beginQrLogin(input: {
  clientOperationId: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  browserNonce: string;
  accessToken: string;
  disclosureVersion: number;
}): Promise<QrBeginResult> {
  return callQrFunction<QrBeginResult>({
    operation: "BEGIN",
    clientOperationId: input.clientOperationId,
    organizationId: input.organizationId,
    accountId: input.accountId,
    cellId: input.cellId,
    browserNonceHash: await sha256Hex(input.browserNonce),
    authSessionHash: await browserSessionHash(input.accessToken),
    disclosureVersion: input.disclosureVersion,
  });
}

export async function pollQrLogin(input: {
  clientOperationId: string;
  organizationId: string;
  accountId: string;
  challengeId: string;
  browserNonce: string;
  accessToken: string;
}): Promise<{ challenge: QrChallengeSnapshot | null }> {
  return callQrFunction({
    operation: "POLL",
    clientOperationId: input.clientOperationId,
    organizationId: input.organizationId,
    accountId: input.accountId,
    challengeId: input.challengeId,
    browserNonceHash: await sha256Hex(input.browserNonce),
    authSessionHash: await browserSessionHash(input.accessToken),
  });
}

/**
 * Exchanges a READY challenge for the decrypted PNG. This is the ONLY call that
 * ever yields something scannable, and the image exists solely in the returned
 * string - it is never persisted.
 */
export async function consumeQrChallenge(input: {
  clientOperationId: string;
  organizationId: string;
  accountId: string;
  challengeId: string;
  browserNonce: string;
  accessToken: string;
}): Promise<{ qrPngDataUrl: string; status: string }> {
  return callQrFunction({
    operation: "CONSUME",
    clientOperationId: input.clientOperationId,
    organizationId: input.organizationId,
    accountId: input.accountId,
    challengeId: input.challengeId,
    browserNonceHash: await sha256Hex(input.browserNonce),
    authSessionHash: await browserSessionHash(input.accessToken),
  });
}
