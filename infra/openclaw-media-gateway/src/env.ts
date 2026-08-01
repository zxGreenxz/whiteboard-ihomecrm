/**
 * Worker bindings and configuration. Nothing here may expose a bucket name or a
 * public endpoint to a caller; the bucket is reachable only through the binding.
 */
import { activeReceiptSignerConfigurationIsValid } from "./receipts";
import {
  ticketVerificationKey,
  ticketVerificationKeyringConfigurationIsValid,
} from "./ticket-verifier";
import { auditKeyringConfigurationIsValid } from "./audit-keys";

export interface MediaGatewayEnv {
  MEDIA: R2Bucket;
  TICKET_STATE: DurableObjectNamespace;
  /** Base64 SPKI of the Edge ticket-signing public key. */
  OPENCLAW_TICKET_PUBLIC_KEY_B64: string;
  /** Active ES256 media-ticket verification-key generation. */
  OPENCLAW_TICKET_KEY_GENERATION: string;
  OPENCLAW_TICKET_KEY_NOT_BEFORE_EPOCH_SECONDS: string;
  OPENCLAW_TICKET_KEY_NOT_AFTER_EPOCH_SECONDS: string;
  OPENCLAW_TICKET_KEY_EMERGENCY_REVOKED: string;
  OPENCLAW_TICKET_RECOVERY_KEYRING_JSON: string;
  /** Base64 SPKI of the dedicated Ed25519 revocation key. */
  OPENCLAW_REVOCATION_PUBLIC_KEY_B64: string;
  /** Active Ed25519 revocation verification-key generation. */
  OPENCLAW_REVOCATION_KEY_GENERATION: string;
  /** Comma-separated exact HTTPS origins allowed to read media in a browser. */
  OPENCLAW_BROWSER_ORIGINS: string;
  /** Pinned Supabase JWKS URL used to verify browser proof tokens. */
  OPENCLAW_SUPABASE_JWKS_URL: string;
  /** Base64 PKCS#8 of the Ed25519 key used only for gateway receipts. */
  OPENCLAW_RECEIPT_PRIVATE_KEY_B64: string;
  /** SHA-256 of the DER SPKI corresponding to the active receipt private key. */
  OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256: string;
  /** Active Ed25519 gateway receipt-signing generation. */
  OPENCLAW_RECEIPT_KEY_GENERATION: string;
  OPENCLAW_RECEIPT_KEY_NOT_BEFORE_EPOCH_SECONDS: string;
  OPENCLAW_RECEIPT_KEY_NOT_AFTER_EPOCH_SECONDS: string;
  OPENCLAW_RECEIPT_KEY_EMERGENCY_REVOKED: string;
  /** Bounded JSON array of prior receipt signers retained for in-flight recovery. */
  OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON: string;
  /** Base64 SPKI of the independently managed Ed25519 audit verification key. */
  OPENCLAW_AUDIT_PUBLIC_KEY_B64: string;
  /** SHA-256 of the exact registered audit SPKI bytes. */
  OPENCLAW_AUDIT_PUBLIC_KEY_SHA256: string;
  /** Active audit verification-key generation. */
  OPENCLAW_AUDIT_KEY_GENERATION: string;
  OPENCLAW_AUDIT_KEY_NOT_BEFORE_EPOCH_SECONDS: string;
  OPENCLAW_AUDIT_KEY_NOT_AFTER_EPOCH_SECONDS: string;
  OPENCLAW_AUDIT_KEY_EMERGENCY_REVOKED: string;
  /** Bounded public-key history used only by explicit audit recovery tickets. */
  OPENCLAW_AUDIT_RECOVERY_KEYRING_JSON: string;
}

const SHA256 = /^[0-9a-f]{64}$/u;

function canonicalBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 16_384 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) throw new Error("invalid base64 configuration");
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) throw new Error("non-canonical base64");
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function importRoundTrip(
  format: "spki" | "pkcs8",
  bytes: Uint8Array,
  algorithm: string | Record<string, unknown>,
  usages: string[],
): Promise<void> {
  const key = await crypto.subtle.importKey(
    format,
    bytes.slice().buffer,
    algorithm as never,
    true,
    usages as never,
  );
  const exported = new Uint8Array(
    await crypto.subtle.exportKey(format, key) as ArrayBuffer,
  );
  if (!equalBytes(bytes, exported)) throw new Error("non-canonical key material");
}

function positiveGeneration(value: unknown): boolean {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 1 && String(generation) === value;
}

function exactOrigins(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("origins missing");
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length < 1 || entries.some((entry) => entry.length === 0)) {
    throw new Error("origins invalid");
  }
  for (const entry of entries) {
    const url = new URL(entry);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || url.origin !== entry
    ) throw new Error("origin invalid");
  }
  if (new Set(entries).size !== entries.length) throw new Error("duplicate origin");
  return entries;
}

function assertPinnedJwksUrl(value: unknown): void {
  if (typeof value !== "string") throw new Error("JWKS URL missing");
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/.well-known/jwks.json")
  ) throw new Error("JWKS URL invalid");
}

export async function gatewayConfigurationIsValid(env: MediaGatewayEnv): Promise<boolean> {
  try {
    if (
      !env || typeof env.MEDIA?.get !== "function" || typeof env.MEDIA?.head !== "function" ||
      typeof env.MEDIA?.put !== "function" || typeof env.MEDIA?.delete !== "function" ||
      typeof env.TICKET_STATE?.idFromName !== "function" || typeof env.TICKET_STATE?.get !== "function"
    ) return false;
    exactOrigins(env.OPENCLAW_BROWSER_ORIGINS);
    assertPinnedJwksUrl(env.OPENCLAW_SUPABASE_JWKS_URL);
    if (![
      env.OPENCLAW_TICKET_KEY_GENERATION,
      env.OPENCLAW_REVOCATION_KEY_GENERATION,
      env.OPENCLAW_RECEIPT_KEY_GENERATION,
      env.OPENCLAW_AUDIT_KEY_GENERATION,
    ].every(positiveGeneration)) return false;

    const ticketKey = canonicalBase64(env.OPENCLAW_TICKET_PUBLIC_KEY_B64);
    const revocationKey = canonicalBase64(env.OPENCLAW_REVOCATION_PUBLIC_KEY_B64);
    const receiptKey = canonicalBase64(env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64);
    const auditKey = canonicalBase64(env.OPENCLAW_AUDIT_PUBLIC_KEY_B64);
    await Promise.all([
      importRoundTrip("spki", ticketKey, { name: "ECDSA", namedCurve: "P-256" }, ["verify"]),
      importRoundTrip("spki", revocationKey, "Ed25519", ["verify"]),
      importRoundTrip("pkcs8", receiptKey, "Ed25519", ["sign"]),
      importRoundTrip("spki", auditKey, "Ed25519", ["verify"]),
      ticketVerificationKey(env, Number(env.OPENCLAW_TICKET_KEY_GENERATION), false),
    ]);
    const auditHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", auditKey))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return SHA256.test(env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256) &&
      auditHash === env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256 &&
      await ticketVerificationKeyringConfigurationIsValid(env) &&
      await auditKeyringConfigurationIsValid(env) &&
      await activeReceiptSignerConfigurationIsValid(env);
  } catch {
    return false;
  }
}

export async function gatewayBindingsAreReachable(env: MediaGatewayEnv): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const bindingProbe = Promise.all([
      env.MEDIA.head("__openclaw_health_sentinel__"),
      (async () => {
        const id = env.TICKET_STATE.idFromName("__openclaw_health__");
        const stub = env.TICKET_STATE.get(id);
        const response = await stub.fetch(new Request("https://ticket-state.internal/health"));
        return response.status === 200 && await response.text() === '{"status":"ok"}';
      })(),
    ]).then(([, durableReady]) => durableReady);
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 3_000);
    });
    return await Promise.race([bindingProbe, timedOut]);
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function browserOrigins(env: MediaGatewayEnv): string[] {
  try {
    return exactOrigins(env.OPENCLAW_BROWSER_ORIGINS);
  } catch {
    return [];
  }
}
