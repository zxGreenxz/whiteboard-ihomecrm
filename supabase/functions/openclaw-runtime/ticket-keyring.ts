import { base64UrlEncode, signEs256 } from "../_shared/openclaw/crypto.ts";
import type { RuntimeDependencies } from "./handler.ts";

type HistoricalTicketSigningKeys = NonNullable<
  RuntimeDependencies["historicalTicketSigningKeys"]
>;

export interface TicketSigningConfiguration {
  ticketKeyGeneration: number;
  signGatewayPayload: (bytes: Uint8Array) => Promise<string>;
  historicalTicketSigningKeys: HistoricalTicketSigningKeys;
}

const HISTORICAL_KEYRING_ENV = "OPENCLAW_TICKET_HISTORICAL_KEYS_JSON";
const HISTORICAL_FIELDS = [
  "generation",
  "privateKeyPkcs8Base64",
  "activatedAt",
  "retiredAt",
  "emergencyRevokedAt",
] as const;

function invalidKeyring(): never {
  throw new Error("OpenClaw historical ticket signing keyring is invalid.");
}

function positiveInteger(raw: string | undefined, name: string): number {
  const value = raw?.trim() ?? "";
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function decodePrivateKey(value: unknown, errorMessage: string): Uint8Array {
  if (
    typeof value !== "string" || value.length < 40 || value.length > 4_096 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) throw new Error(errorMessage);
  try {
    const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (decoded.byteLength < 32 || btoa(String.fromCharCode(...decoded)) !== value) {
      decoded.fill(0);
      throw new Error(errorMessage);
    }
    return decoded;
  } catch {
    throw new Error(errorMessage);
  }
}

async function importSigner(value: unknown, errorMessage: string) {
  const bytes = decodePrivateKey(value, errorMessage);
  try {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      bytes.slice().buffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return async (payload: Uint8Array) => base64UrlEncode(await signEs256(key, payload));
  } catch {
    throw new Error(errorMessage);
  } finally {
    bytes.fill(0);
  }
}

export async function loadTicketSigningConfiguration(
  source: Record<string, string | undefined>,
): Promise<TicketSigningConfiguration> {
  const ticketKeyGeneration = positiveInteger(
    source.OPENCLAW_TICKET_KEY_GENERATION,
    "OPENCLAW_TICKET_KEY_GENERATION",
  );
  const activePrivateKey = source.OPENCLAW_TICKET_PRIVATE_KEY_B64?.trim() ?? "";
  const signGatewayPayload = await importSigner(
    activePrivateKey,
    "OpenClaw active ticket signing key is invalid.",
  );
  const rawKeyring = source[HISTORICAL_KEYRING_ENV]?.trim();
  if (!rawKeyring) {
    return { ticketKeyGeneration, signGatewayPayload, historicalTicketSigningKeys: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeyring);
  } catch {
    invalidKeyring();
  }
  if (!Array.isArray(parsed) || parsed.length > 8) invalidKeyring();

  const entries: Record<number, HistoricalTicketSigningKeys[number]> = {};
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidKeyring();
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== [...HISTORICAL_FIELDS].sort().join(",") ||
      !Number.isSafeInteger(entry.generation) || Number(entry.generation) < 1 ||
      Number(entry.generation) >= ticketKeyGeneration || entries[Number(entry.generation)] ||
      !canonicalTimestamp(entry.activatedAt) || !canonicalTimestamp(entry.retiredAt) ||
      !(entry.emergencyRevokedAt === null || canonicalTimestamp(entry.emergencyRevokedAt))
    ) invalidKeyring();
    const activatedAtEpochSeconds = Math.floor(Date.parse(entry.activatedAt as string) / 1_000);
    const retiredAtEpochSeconds = Math.floor(Date.parse(entry.retiredAt as string) / 1_000);
    const emergencyRevokedAtEpochSeconds = entry.emergencyRevokedAt === null
      ? null
      : Math.floor(Date.parse(entry.emergencyRevokedAt as string) / 1_000);
    if (
      activatedAtEpochSeconds >= retiredAtEpochSeconds ||
      (emergencyRevokedAtEpochSeconds !== null &&
        emergencyRevokedAtEpochSeconds < activatedAtEpochSeconds)
    ) invalidKeyring();
    const historicalSigner = await importSigner(
      entry.privateKeyPkcs8Base64,
      "OpenClaw historical ticket signing keyring is invalid.",
    );
    entries[Number(entry.generation)] = {
      activatedAtEpochSeconds,
      retiredAtEpochSeconds,
      emergencyRevokedAtEpochSeconds,
      signGatewayPayload: historicalSigner,
    };
  }
  return {
    ticketKeyGeneration,
    signGatewayPayload,
    historicalTicketSigningKeys: entries,
  };
}
