import { OpenClawHttpError } from "./errors.ts";
import type { GatewayReceiptKeyMetadata } from "./gateway-receipts.ts";

export interface OpenClawEnvironment {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  runtimeTokenSigningKey: string;
  browserOrigins: string[];
  gatewayReceiptKeyRegistry?: Readonly<Record<string, GatewayReceiptKeyMetadata>>;
}

function required(source: Record<string, string | undefined>, name: string): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new OpenClawHttpError(500, "ENV_MISSING", `Required environment name is missing: ${name}.`, {
      expose: false,
    });
  }
  return value;
}

function strictHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenClaw browser origin is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    value.includes("*")
  ) {
    throw new Error("OpenClaw browser origin must be an exact HTTPS origin.");
  }
  return value;
}

export function parseOpenClawEnvironment(
  source: Record<string, string | undefined>,
): OpenClawEnvironment {
  const supabaseUrl = required(source, "SUPABASE_URL");
  const parsedSupabaseUrl = new URL(supabaseUrl);
  if (parsedSupabaseUrl.protocol !== "https:" || parsedSupabaseUrl.origin !== supabaseUrl) {
    throw new Error("SUPABASE_URL must be an exact HTTPS origin.");
  }
  const runtimeTokenSigningKey = required(
    source,
    "OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY",
  );
  if (new TextEncoder().encode(runtimeTokenSigningKey).byteLength < 32) {
    throw new Error("OPENCLAW_RUNTIME_TOKEN_SIGNING_KEY is too short.");
  }
  const browserOrigins = required(source, "OPENCLAW_BROWSER_ORIGINS")
    .split(",")
    .map((origin) => strictHttpsOrigin(origin.trim()));
  if (
    browserOrigins.length === 0 ||
    browserOrigins.length > 10 ||
    new Set(browserOrigins).size !== browserOrigins.length
  ) {
    throw new Error("OpenClaw browser origin allowlist is invalid.");
  }
  let gatewayReceiptKeyRegistry: Record<string, GatewayReceiptKeyMetadata> = {};
  const receiptKeysJson = source.OPENCLAW_GATEWAY_RECEIPT_PUBLIC_KEYS_JSON?.trim();
  if (receiptKeysJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(receiptKeysJson);
    } catch {
      throw new Error("OpenClaw gateway receipt public-key registry is invalid.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("OpenClaw gateway receipt public-key registry is invalid.");
    }
    const registry = new Map<string, GatewayReceiptKeyMetadata>();
    const timestamp = (value: unknown): value is string =>
      typeof value === "string" && Number.isFinite(new Date(value).valueOf()) &&
      new Date(value).toISOString() === value;
    if (parsed.length > 10) {
      throw new Error("OpenClaw gateway receipt public-key registry is invalid.");
    }
    for (const value of parsed) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("OpenClaw gateway receipt public-key registry is invalid.");
      }
      const entry = value as Record<string, unknown>;
      if (
        Object.keys(entry).sort().join(",") !==
          ["activatesAt", "generation", "publicKeySpkiBase64", "retiresAt", "revokedAt"].sort().join(",") ||
        !Number.isSafeInteger(entry.generation) || Number(entry.generation) < 1 ||
        typeof entry.publicKeySpkiBase64 !== "string" || entry.publicKeySpkiBase64.length < 40 ||
        entry.publicKeySpkiBase64.length > 512 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.publicKeySpkiBase64) ||
        !timestamp(entry.activatesAt) ||
        !(entry.retiresAt === null || timestamp(entry.retiresAt)) ||
        !(entry.revokedAt === null || timestamp(entry.revokedAt))
      ) {
        throw new Error("OpenClaw gateway receipt public-key registry is invalid.");
      }
      const activatesAt = entry.activatesAt as string;
      const retiresAt = entry.retiresAt as string | null;
      const revokedAt = entry.revokedAt as string | null;
      if (
        (retiresAt !== null && retiresAt <= activatesAt) ||
        (revokedAt !== null && revokedAt <= activatesAt) ||
        registry.has(String(entry.generation))
      ) {
        throw new Error("OpenClaw gateway receipt public-key registry is invalid.");
      }
      registry.set(String(entry.generation), {
        generation: Number(entry.generation),
        publicKeySpkiBase64: entry.publicKeySpkiBase64,
        activatesAt,
        retiresAt,
        revokedAt,
      });
    }
    gatewayReceiptKeyRegistry = Object.fromEntries(registry);
  }
  return {
    supabaseUrl,
    supabaseAnonKey: required(source, "SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: required(source, "SUPABASE_SERVICE_ROLE_KEY"),
    runtimeTokenSigningKey,
    browserOrigins,
    gatewayReceiptKeyRegistry,
  };
}
