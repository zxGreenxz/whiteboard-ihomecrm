import { OpenClawHttpError } from "./errors.ts";

export interface OpenClawEnvironment {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  runtimeTokenSigningKey: string;
  browserOrigins: string[];
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
  return {
    supabaseUrl,
    supabaseAnonKey: required(source, "SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: required(source, "SUPABASE_SERVICE_ROLE_KEY"),
    runtimeTokenSigningKey,
    browserOrigins,
  };
}
