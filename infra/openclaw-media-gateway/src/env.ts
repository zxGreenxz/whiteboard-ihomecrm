/**
 * Worker bindings and configuration. Nothing here may expose a bucket name or a
 * public endpoint to a caller; the bucket is reachable only through the binding.
 */

export interface MediaGatewayEnv {
  MEDIA: R2Bucket;
  TICKET_STATE: DurableObjectNamespace;
  /** Base64 SPKI of the Edge ticket-signing public key. */
  OPENCLAW_TICKET_PUBLIC_KEY_B64: string;
  /** Base64 SPKI of the dedicated Ed25519 revocation key. */
  OPENCLAW_REVOCATION_PUBLIC_KEY_B64: string;
  /** Comma-separated exact HTTPS origins allowed to read media in a browser. */
  OPENCLAW_BROWSER_ORIGINS: string;
  /** Pinned Supabase JWKS URL used to verify browser proof tokens. */
  OPENCLAW_SUPABASE_JWKS_URL: string;
}

export function browserOrigins(env: MediaGatewayEnv): string[] {
  return env.OPENCLAW_BROWSER_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin.startsWith("https://") && !origin.includes("*"));
}