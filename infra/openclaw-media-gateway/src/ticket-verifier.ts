import type { MediaGatewayEnv } from "./env";
import { isCanonicalObjectKey, objectKeyTenant } from "./object-key";
import { admitTicket } from "./state-client";
import {
  evaluateTicket,
  validateTicketShape,
  type BrowserProof,
  type MediaTicketClaims,
  type TicketOperationExpectation,
} from "./ticket";

type SignedTicket = MediaTicketClaims & { signature: string };

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function base64Decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) throw new Error("non-canonical base64");
  return bytes;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signedTicket(request: Request): SignedTicket {
  const header = request.headers.get("x-openclaw-media-ticket");
  if (!header || header.length > 16_384) throw new Error("ticket missing");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    base64UrlDecode(header),
  )) as Record<string, unknown>;
  if (typeof value.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(value.signature)) {
    throw new Error("ticket signature invalid");
  }
  const { signature, ...claims } = value;
  if (!validateTicketShape(claims)) throw new Error("ticket malformed");
  return { ...claims, signature };
}

interface TicketVerificationKeyConfiguration {
  generation: number;
  publicKeyB64: string;
  notBeforeEpochSeconds: number;
  notAfterEpochSeconds: number;
  emergencyRevoked: boolean;
  active: boolean;
}

function ticketKeyEpoch(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error("ticket key epoch invalid");
  }
  return parsed;
}

function ticketKeyConfigurations(env: MediaGatewayEnv): TicketVerificationKeyConfiguration[] {
  const activeGeneration = Number(env.OPENCLAW_TICKET_KEY_GENERATION);
  if (!Number.isSafeInteger(activeGeneration) || activeGeneration < 1 ||
    !["true", "false"].includes(env.OPENCLAW_TICKET_KEY_EMERGENCY_REVOKED)) {
    throw new Error("ticket key configuration invalid");
  }
  const active: TicketVerificationKeyConfiguration = {
    generation: activeGeneration,
    publicKeyB64: env.OPENCLAW_TICKET_PUBLIC_KEY_B64,
    notBeforeEpochSeconds: ticketKeyEpoch(env.OPENCLAW_TICKET_KEY_NOT_BEFORE_EPOCH_SECONDS),
    notAfterEpochSeconds: ticketKeyEpoch(env.OPENCLAW_TICKET_KEY_NOT_AFTER_EPOCH_SECONDS),
    emergencyRevoked: env.OPENCLAW_TICKET_KEY_EMERGENCY_REVOKED === "true",
    active: true,
  };
  const parsed = JSON.parse(env.OPENCLAW_TICKET_RECOVERY_KEYRING_JSON) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 2) throw new Error("ticket keyring invalid");
  const recovery = parsed.map((value): TicketVerificationKeyConfiguration => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("ticket keyring invalid");
    }
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== [
      "emergencyRevoked", "generation", "notAfterEpochSeconds", "notBeforeEpochSeconds",
      "publicKeyB64",
    ].sort().join(",") || !Number.isSafeInteger(entry.generation) || Number(entry.generation) < 1 ||
      typeof entry.publicKeyB64 !== "string" || typeof entry.emergencyRevoked !== "boolean") {
      throw new Error("ticket keyring invalid");
    }
    return {
      generation: Number(entry.generation),
      publicKeyB64: entry.publicKeyB64,
      notBeforeEpochSeconds: ticketKeyEpoch(String(entry.notBeforeEpochSeconds)),
      notAfterEpochSeconds: ticketKeyEpoch(String(entry.notAfterEpochSeconds)),
      emergencyRevoked: entry.emergencyRevoked,
      active: false,
    };
  });
  const all = [active, ...recovery];
  if (new Set(all.map((entry) => entry.generation)).size !== all.length) {
    throw new Error("duplicate ticket key generation");
  }
  if (all.some((entry) => entry.notBeforeEpochSeconds >= entry.notAfterEpochSeconds)) {
    throw new Error("ticket key lifecycle invalid");
  }
  return all;
}

async function importTicketVerificationKey(
  configuration: TicketVerificationKeyConfiguration,
  extractable: boolean,
): Promise<CryptoKey> {
  const bytes = base64Decode(configuration.publicKeyB64);
  const key = await crypto.subtle.importKey(
    "spki",
    bytes.slice().buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    extractable,
    ["verify"],
  );
  if (extractable) {
    const exported = new Uint8Array(await crypto.subtle.exportKey("spki", key) as ArrayBuffer);
    if (exported.byteLength !== bytes.byteLength ||
      !exported.every((byte, index) => byte === bytes[index])) {
      throw new Error("ticket key encoding invalid");
    }
  }
  return key;
}

export async function ticketVerificationKey(
  env: MediaGatewayEnv,
  generation: number,
  allowHistoricalRecovery: boolean,
): Promise<CryptoKey> {
  const configuration = ticketKeyConfigurations(env).find((entry) => entry.generation === generation);
  const now = Math.floor(Date.now() / 1_000);
  if (!configuration || (!configuration.active && !allowHistoricalRecovery) ||
    configuration.emergencyRevoked ||
    now < configuration.notBeforeEpochSeconds || now >= configuration.notAfterEpochSeconds) {
    throw new Error("ticket key generation invalid");
  }
  return await importTicketVerificationKey(configuration, false);
}

export async function ticketVerificationKeyringConfigurationIsValid(
  env: MediaGatewayEnv,
): Promise<boolean> {
  try {
    const configured = ticketKeyConfigurations(env);
    await Promise.all(configured.map(async (entry) =>
      await importTicketVerificationKey(entry, true)
    ));
    const active = configured[0] as TicketVerificationKeyConfiguration;
    const now = Math.floor(Date.now() / 1_000);
    return !active.emergencyRevoked && now >= active.notBeforeEpochSeconds &&
      now < active.notAfterEpochSeconds;
  } catch {
    return false;
  }
}

async function verifyTicketSignature(
  ticket: SignedTicket,
  env: MediaGatewayEnv,
  allowHistoricalRecovery: boolean,
): Promise<void> {
  const { signature, ...claims } = ticket;
  const key = await ticketVerificationKey(
    env,
    claims.gatewayKeyGeneration,
    allowHistoricalRecovery,
  );
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlDecode(signature),
    new TextEncoder().encode(canonical(claims)),
  )) throw new Error("ticket signature invalid");
}

interface ParsedJwt {
  encodedHeader: string;
  encodedPayload: string;
  signature: Uint8Array;
  header: { alg: "ES256" | "RS256"; kid: string };
  payload: {
    sub: string;
    session_id: string;
    exp: number;
    iat: number;
    nbf?: number;
    iss: string;
    aud: "authenticated";
  };
  token: string;
}

interface JwksKey extends JsonWebKey {
  kid?: string;
}

const JWKS_CACHE_TTL_MS = 10 * 60 * 1_000;
const JWKS_FETCH_TIMEOUT_MS = 3_000;
const JWKS_MAX_BYTES = 64 * 1_024;
const JWKS_MAX_KEYS = 16;

interface CachedJwks {
  expiresAtMs: number;
  keys: JwksKey[];
}

class UnknownJwksKidError extends Error {}

const jwksCache = new Map<string, CachedJwks>();
const jwksRequests = new Map<string, Promise<CachedJwks>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectJwksKey(keys: readonly JwksKey[], header: ParsedJwt["header"]): JwksKey {
  const matchingKid = keys.filter((candidate) => candidate.kid === header.kid);
  if (matchingKid.length === 0) throw new UnknownJwksKidError("JWT key missing");
  if (matchingKid.length !== 1) throw new Error("JWT kid is not unique");
  const key = matchingKid[0] as JwksKey;
  const allowedKeys = header.alg === "ES256"
    ? ["alg", "crv", "ext", "key_ops", "kid", "kty", "use", "x", "y"]
    : ["alg", "e", "ext", "key_ops", "kid", "kty", "n", "use"];
  const actualKeys = Object.keys(key).sort();
  if (
    actualKeys.length !== allowedKeys.length ||
    !actualKeys.every((name, index) => name === allowedKeys[index]) ||
    key.ext !== true
  ) throw new Error("JWT key metadata invalid");
  const exactVerifyOps = Array.isArray(key.key_ops) && key.key_ops.length === 1 &&
    key.key_ops[0] === "verify";
  const canonicalBase64Url = (value: unknown, expectedLength?: number): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value) &&
    (expectedLength === undefined || value.length === expectedLength);
  const exactAlgorithm = header.alg === "ES256"
    ? key.alg === "ES256" && key.kty === "EC" && key.crv === "P-256" &&
      canonicalBase64Url(key.x, 43) && canonicalBase64Url(key.y, 43)
    : key.alg === "RS256" && key.kty === "RSA" && key.crv === undefined &&
      canonicalBase64Url(key.n) && key.n.length >= 342 && canonicalBase64Url(key.e);
  if (key.use !== "sig" || !exactVerifyOps || !exactAlgorithm) {
    throw new Error("JWT key metadata invalid");
  }
  return key;
}

async function requestJwks(jwksUrl: URL): Promise<CachedJwks> {
  const response = await fetch(jwksUrl.href, {
    redirect: "error",
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("JWKS unavailable");
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > JWKS_MAX_BYTES)
  ) throw new Error("JWKS response is too large");
  if (!response.body) throw new Error("JWKS response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let byteLength = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > JWKS_MAX_BYTES) {
        await reader.cancel("JWKS response is too large");
        throw new Error("JWKS response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length > JWKS_MAX_KEYS) {
    throw new Error("JWKS malformed");
  }
  const keys = parsed.keys as unknown[];
  const seenKids = new Set<string>();
  const validated = keys.map((candidate) => {
    if (!isRecord(candidate) || typeof candidate.kid !== "string" ||
      candidate.kid.length < 1 || candidate.kid.length > 256 || seenKids.has(candidate.kid)) {
      throw new Error("JWKS kid invalid");
    }
    seenKids.add(candidate.kid);
    return candidate as unknown as JwksKey;
  });
  const entry = { expiresAtMs: Date.now() + JWKS_CACHE_TTL_MS, keys: validated };
  jwksCache.set(jwksUrl.href, entry);
  return entry;
}

async function loadJwks(jwksUrl: URL, forceRefresh: boolean): Promise<CachedJwks> {
  const cached = jwksCache.get(jwksUrl.href);
  if (!forceRefresh && cached && cached.expiresAtMs > Date.now()) return cached;
  if (!forceRefresh && cached) jwksCache.delete(jwksUrl.href);
  const requestKey = `${jwksUrl.href}:${forceRefresh ? "refresh" : "normal"}`;
  const pending = jwksRequests.get(requestKey);
  if (pending) return await pending;
  const request = requestJwks(jwksUrl).finally(() => jwksRequests.delete(requestKey));
  jwksRequests.set(requestKey, request);
  return await request;
}

async function resolveJwksKey(jwksUrl: URL, header: ParsedJwt["header"]): Promise<JwksKey> {
  const initial = await loadJwks(jwksUrl, false);
  try {
    return selectJwksKey(initial.keys, header);
  } catch (error) {
    if (!(error instanceof UnknownJwksKidError)) throw error;
  }
  // A new signing key can appear before the ten-minute cache expires. Refresh
  // once for an unknown kid, but never retry malformed matching-key metadata.
  const refreshed = await loadJwks(jwksUrl, true);
  return selectJwksKey(refreshed.keys, header);
}

function parseJwt(token: string): ParsedJwt {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("JWT malformed");
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as Record<string, unknown>;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as Record<string, unknown>;
  if (
    (header.alg !== "ES256" && header.alg !== "RS256") || typeof header.kid !== "string" ||
    typeof payload.sub !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(payload.sub) ||
    typeof payload.session_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(payload.session_id) ||
    !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
    (payload.nbf !== undefined && !Number.isSafeInteger(payload.nbf)) ||
    typeof payload.iss !== "string" ||
    payload.aud !== "authenticated"
  ) throw new Error("JWT claims invalid");
  return {
    encodedHeader: parts[0],
    encodedPayload: parts[1],
    signature: base64UrlDecode(parts[2]),
    header: header as ParsedJwt["header"],
    payload: payload as unknown as ParsedJwt["payload"],
    token,
  };
}

function pinnedJwksUrl(env: MediaGatewayEnv): { jwksUrl: URL; issuer: string } {
  const jwksUrl = new URL(env.OPENCLAW_SUPABASE_JWKS_URL);
  const jwksSuffix = "/.well-known/jwks.json";
  if (
    jwksUrl.protocol !== "https:" || jwksUrl.username || jwksUrl.password ||
    jwksUrl.search || jwksUrl.hash || !jwksUrl.pathname.endsWith(jwksSuffix)
  ) {
    throw new Error("JWKS URL invalid");
  }
  const issuerUrl = new URL(jwksUrl.href);
  issuerUrl.pathname = issuerUrl.pathname.slice(0, -jwksSuffix.length);
  return { jwksUrl, issuer: issuerUrl.href.replace(/\/$/u, "") };
}

export async function pinnedBrowserJwksIsUsable(env: MediaGatewayEnv): Promise<boolean> {
  try {
    const { jwksUrl } = pinnedJwksUrl(env);
    const { keys } = await loadJwks(jwksUrl, true);
    for (const key of keys) {
      if ((key.alg !== "ES256" && key.alg !== "RS256") || typeof key.kid !== "string") {
        continue;
      }
      try {
        const selected = selectJwksKey(keys, { alg: key.alg, kid: key.kid });
        const algorithm = selected.alg === "ES256"
          ? { name: "ECDSA", namedCurve: "P-256" }
          : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        await crypto.subtle.importKey("jwk", selected, algorithm, false, ["verify"]);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function browserJwt(
  request: Request,
  env: MediaGatewayEnv,
  nowEpochSeconds: number,
): ParsedJwt {
  const authorization = request.headers.get("authorization");
  if (
    !authorization?.startsWith("Bearer ") || authorization.length <= 7 ||
    authorization.length > 16_384
  ) throw new Error("browser proof missing");
  const parsed = parseJwt(authorization.slice(7));
  const { issuer } = pinnedJwksUrl(env);
  if (
    parsed.payload.iss !== issuer || parsed.payload.exp <= parsed.payload.iat ||
    parsed.payload.exp <= nowEpochSeconds || parsed.payload.iat > nowEpochSeconds + 60 ||
    (parsed.payload.nbf !== undefined &&
      (parsed.payload.nbf >= parsed.payload.exp || parsed.payload.nbf > nowEpochSeconds + 60))
  ) {
    throw new Error("JWT time or issuer invalid");
  }
  return parsed;
}

async function proofFromJwt(parsed: ParsedJwt): Promise<BrowserProof> {
  return {
    userId: parsed.payload.sub,
    sessionIdSha256: await sha256Hex(parsed.payload.session_id),
    accessTokenSha256: await sha256Hex(parsed.token),
  };
}

async function verifyBrowserJwtSignature(
  parsed: ParsedJwt,
  env: MediaGatewayEnv,
): Promise<void> {
  const { jwksUrl } = pinnedJwksUrl(env);
  const jwk = await resolveJwksKey(jwksUrl, parsed.header);
  const algorithm = parsed.header.alg === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    parsed.header.alg === "ES256"
      ? { name: "ECDSA", hash: "SHA-256" }
      : { name: "RSASSA-PKCS1-v1_5" },
    key,
    parsed.signature,
    new TextEncoder().encode(`${parsed.encodedHeader}.${parsed.encodedPayload}`),
  );
  if (!valid) throw new Error("JWT signature invalid");
}

export async function verifyTicketRequest(
  request: Request,
  env: MediaGatewayEnv,
  expectedOperation: TicketOperationExpectation,
  options: {
    deleteAuthorizationPresent?: boolean;
    consumeJti?: boolean;
    allowExpiredForReplay?: boolean;
    skipStateAdmission?: boolean;
  } = {},
): Promise<MediaTicketClaims> {
  const signed = signedTicket(request);
  await verifyTicketSignature(signed, env, options.allowExpiredForReplay === true);
  const { signature: _signature, ...ticket } = signed;
  if (!isCanonicalObjectKey(ticket.objectKey)) throw new Error("object key invalid");
  const tenant = objectKeyTenant(ticket.objectKey);
  if (
    !tenant || tenant.organizationId !== ticket.organizationId ||
    (ticket.accountId !== null && tenant.accountId !== ticket.accountId) ||
    (ticket.accountId === null && ticket.subject !== "MAINTENANCE")
  ) throw new Error("ticket tenant mismatch");
  if (ticket.subject === "MAINTENANCE") {
    const auditOperation = ticket.operation === "ANCHOR" || ticket.operation === "ANCHOR_VERIFY";
    if (
      (ticket.operation === "DELETE" && tenant.accountId === null) ||
      (auditOperation && (
        tenant.accountId !== null ||
        !ticket.objectKey.endsWith(`/${ticket.auditRootId}.json`)
      ))
    ) throw new Error("ticket key kind mismatch");
  }
  const nowEpochSeconds = Math.floor(Date.now() / 1_000);
  const parsedBrowserJwt = ticket.subject === "BROWSER"
    ? browserJwt(request, env, nowEpochSeconds)
    : null;
  const proof = parsedBrowserJwt ? await proofFromJwt(parsedBrowserJwt) : null;
  // Reject locally-decidable operation, TTL, object, and token-binding failures
  // before placing the remote JWKS endpoint on the request path.
  const cheapVerdict = evaluateTicket({
    claims: ticket,
    nowEpochSeconds,
    expectedOperation,
    expectedObjectKey: ticket.objectKey,
    browserProof: proof,
    minimumGeneration: 0,
    deleteAuthorizationPresent: options.deleteAuthorizationPresent,
    ignoreTemporalValidity: options.allowExpiredForReplay,
  });
  if (!cheapVerdict.ok) throw new Error(cheapVerdict.failure ?? "ticket denied");
  if (parsedBrowserJwt) await verifyBrowserJwtSignature(parsedBrowserJwt, env);
  if (!options.skipStateAdmission) {
    await admitTicket(env, ticket, options.consumeJti !== false);
  }
  return ticket;
}

export function encodeTicketHeader(ticket: unknown): string {
  return btoa(canonical(ticket)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
