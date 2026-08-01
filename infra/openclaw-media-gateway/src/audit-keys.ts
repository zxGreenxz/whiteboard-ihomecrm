import type { MediaGatewayEnv } from "./env";
import { GatewayError } from "./gateway-error";

interface AuditVerificationKeyConfiguration {
  generation: number;
  publicKeyB64: string;
  publicKeySha256: string;
  notBeforeEpochSeconds: number;
  notAfterEpochSeconds: number;
  emergencyRevoked: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/u;

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function canonicalEpoch(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error("audit key epoch invalid");
  }
  return parsed;
}

function base64Decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("audit key base64 invalid");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== value) throw new Error("audit key base64 invalid");
  return bytes;
}

function recoveryAuditKeys(env: MediaGatewayEnv): AuditVerificationKeyConfiguration[] {
  const parsed = JSON.parse(env.OPENCLAW_AUDIT_RECOVERY_KEYRING_JSON) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 4) throw new Error("audit keyring invalid");
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("audit keyring invalid");
    }
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== [
      "emergencyRevoked", "generation", "notAfterEpochSeconds", "notBeforeEpochSeconds",
      "publicKeyB64", "publicKeySha256",
    ].sort().join(",")) throw new Error("audit keyring invalid");
    if (
      !positiveInteger(entry.generation) || typeof entry.publicKeyB64 !== "string" ||
      typeof entry.publicKeySha256 !== "string" || !SHA256.test(entry.publicKeySha256) ||
      typeof entry.emergencyRevoked !== "boolean"
    ) throw new Error("audit keyring invalid");
    return {
      generation: entry.generation,
      publicKeyB64: entry.publicKeyB64,
      publicKeySha256: entry.publicKeySha256,
      notBeforeEpochSeconds: canonicalEpoch(String(entry.notBeforeEpochSeconds)),
      notAfterEpochSeconds: canonicalEpoch(String(entry.notAfterEpochSeconds)),
      emergencyRevoked: entry.emergencyRevoked,
    };
  });
}

function configuredAuditKeys(env: MediaGatewayEnv): AuditVerificationKeyConfiguration[] {
  const active: AuditVerificationKeyConfiguration = {
    generation: Number(env.OPENCLAW_AUDIT_KEY_GENERATION),
    publicKeyB64: env.OPENCLAW_AUDIT_PUBLIC_KEY_B64,
    publicKeySha256: env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256,
    notBeforeEpochSeconds: canonicalEpoch(env.OPENCLAW_AUDIT_KEY_NOT_BEFORE_EPOCH_SECONDS),
    notAfterEpochSeconds: canonicalEpoch(env.OPENCLAW_AUDIT_KEY_NOT_AFTER_EPOCH_SECONDS),
    emergencyRevoked: env.OPENCLAW_AUDIT_KEY_EMERGENCY_REVOKED === "true",
  };
  if (
    !positiveInteger(active.generation) || !SHA256.test(active.publicKeySha256) ||
    !["true", "false"].includes(env.OPENCLAW_AUDIT_KEY_EMERGENCY_REVOKED)
  ) throw new Error("audit key configuration invalid");
  const all = [active, ...recoveryAuditKeys(env)];
  if (new Set(all.map((entry) => entry.generation)).size !== all.length) {
    throw new Error("duplicate audit key generation");
  }
  if (all.some((entry) => entry.notBeforeEpochSeconds >= entry.notAfterEpochSeconds)) {
    throw new Error("audit key lifecycle invalid");
  }
  return all;
}

async function importAuditKey(configuration: AuditVerificationKeyConfiguration): Promise<CryptoKey> {
  const bytes = base64Decode(configuration.publicKeyB64);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== configuration.publicKeySha256) throw new Error("audit key hash mismatch");
  const key = await crypto.subtle.importKey(
    "spki",
    bytes.slice().buffer,
    "Ed25519",
    true,
    ["verify"],
  );
  const exported = new Uint8Array(await crypto.subtle.exportKey("spki", key) as ArrayBuffer);
  if (exported.byteLength !== bytes.byteLength ||
    !exported.every((byte, index) => byte === bytes[index])) {
    throw new Error("audit key encoding invalid");
  }
  return key;
}

export async function auditVerificationKey(
  env: MediaGatewayEnv,
  generation: number,
  publicKeySha256: string,
  allowHistoricalRecovery: boolean,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): Promise<CryptoKey> {
  try {
    const configured = configuredAuditKeys(env);
    const candidates = allowHistoricalRecovery ? configured : configured.slice(0, 1);
    const selected = candidates.find((entry) =>
      entry.generation === generation && entry.publicKeySha256 === publicKeySha256
    );
    if (
      !selected || selected.emergencyRevoked ||
      nowEpochSeconds < selected.notBeforeEpochSeconds ||
      nowEpochSeconds >= selected.notAfterEpochSeconds
    ) throw new Error("audit key unavailable");
    return await importAuditKey(selected);
  } catch {
    throw new GatewayError("AUDIT_ANCHOR_INVALID", 409);
  }
}

export async function auditKeyringConfigurationIsValid(env: MediaGatewayEnv): Promise<boolean> {
  try {
    const configured = configuredAuditKeys(env);
    await Promise.all(configured.map(importAuditKey));
    const active = configured[0] as AuditVerificationKeyConfiguration;
    const nowEpochSeconds = Math.floor(Date.now() / 1_000);
    return !active.emergencyRevoked && nowEpochSeconds >= active.notBeforeEpochSeconds &&
      nowEpochSeconds < active.notAfterEpochSeconds;
  } catch {
    return false;
  }
}
