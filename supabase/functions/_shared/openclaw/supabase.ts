import { createClient, type SupabaseClient } from "./deps.ts";
import { OpenClawHttpError } from "./errors.ts";
import type { OpenClawEnvironment } from "./env.ts";

const AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
};

export function createBrowserSupabaseClient(
  request: Request,
  environment: OpenClawEnvironment,
): SupabaseClient {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new OpenClawHttpError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Browser authentication is required.",
    );
  }
  return createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
    auth: AUTH_OPTIONS,
    global: { headers: { Authorization: authorization } },
  });
}

export function createAdminSupabaseClient(
  environment: OpenClawEnvironment,
): SupabaseClient {
  return createClient(
    environment.supabaseUrl,
    environment.supabaseServiceRoleKey,
    { auth: AUTH_OPTIONS },
  );
}
