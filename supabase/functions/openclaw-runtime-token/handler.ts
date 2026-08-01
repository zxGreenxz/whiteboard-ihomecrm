import { OPENCLAW_DEFAULT_JSON_LIMIT_BYTES } from "../_shared/openclaw/constants.ts";
import { requireNoBrowserOrigin } from "../_shared/openclaw/cors.ts";
import type { OpenClawEnvironment } from "../_shared/openclaw/env.ts";
import { OpenClawHttpError } from "../_shared/openclaw/errors.ts";
import { errorResponse, jsonResponse, readStrictJson } from "../_shared/openclaw/http.ts";
import { redactLogValue, redactText } from "../_shared/openclaw/redaction.ts";
import {
  OPENCLAW_RUNTIME_TOKEN_MAX_TTL_SECONDS,
  principalSelectorFor,
  runtimeTokenRequestSchema,
  type RuntimeTokenExchangeRequest,
} from "./schemas.ts";

export interface RuntimeTokenServiceClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface RuntimeTokenDependencies {
  environment: OpenClawEnvironment;
  createServiceClient: (environment: OpenClawEnvironment) => RuntimeTokenServiceClient;
  exchangeRuntimeCredential: (input: {
    credential: string;
    method: string;
    path: string;
    body?: Uint8Array;
    runtimeBodySha256?: string;
    routeBody: unknown;
    timestamp: number;
    nonce: string;
    exchangeNonce: string;
    localSessionGeneration?: number;
    principalSelector: Record<string, string>;
    signingKey: Uint8Array;
    nowEpochSeconds: number;
    origin: string | null;
    authenticateCredential: (input: unknown) => Promise<unknown>;
  }) => Promise<string>;
  logger?: { error: (message: string, context: unknown) => void };
  requestIdFactory?: () => string;
  now?: () => Date;
}

/**
 * The root credential only ever travels in a header. Accepting it in the JSON
 * body would put it into request logs, audit rows, and error payloads.
 */
function credentialHeader(request: Request): string {
  const credential = request.headers.get("x-openclaw-credential");
  if (!credential || credential.length < 24 || credential.length > 512) {
    throw new OpenClawHttpError(401, "CREDENTIAL_REQUIRED", "Runtime credential is required.");
  }
  return credential;
}

export async function handleRuntimeTokenRequest(
  request: Request,
  dependencies: RuntimeTokenDependencies,
): Promise<Response> {
  let requestId = dependencies.requestIdFactory?.() ?? crypto.randomUUID();
  let credential: string | null = null;
  try {
    requireNoBrowserOrigin(request.headers.get("origin"));

    // Read the credential before the body so a body-carried credential can never
    // become the authenticated one.
    credential = credentialHeader(request);

    const parsed = await readStrictJson(request, {
      method: "POST",
      maxBytes: OPENCLAW_DEFAULT_JSON_LIMIT_BYTES,
      schema: runtimeTokenRequestSchema,
      requestIdFactory: dependencies.requestIdFactory,
    });
    requestId = parsed.requestId;
    const exchangeRequest: RuntimeTokenExchangeRequest = parsed.data;

    const nowEpochSeconds = Math.floor(
      (dependencies.now?.() ?? new Date()).getTime() / 1000,
    );
    const client = dependencies.createServiceClient(dependencies.environment);

    const token = await dependencies.exchangeRuntimeCredential({
      credential,
      method: exchangeRequest.runtimeMethod,
      path: exchangeRequest.runtimePath,
      runtimeBodySha256: exchangeRequest.runtimeBodySha256,
      routeBody: {},
      timestamp: exchangeRequest.runtimeTimestamp,
      nonce: exchangeRequest.runtimeNonce,
      exchangeNonce: exchangeRequest.exchangeNonce,
      localSessionGeneration: exchangeRequest.principalKind === "CHANNEL"
        ? exchangeRequest.localSessionGeneration
        : undefined,
      principalSelector: principalSelectorFor(exchangeRequest),
      signingKey: new TextEncoder().encode(
        dependencies.environment.runtimeTokenSigningKey,
      ),
      nowEpochSeconds,
      origin: null,
      authenticateCredential: async (rpcInput) => {
        const input = rpcInput as {
          principal: unknown;
          envelope: unknown;
          request: unknown;
        };
        const facade = exchangeRequest.principalKind === "CHANNEL"
          ? "openclaw_service_exchange_runtime_credential_v1"
          : "openclaw_service_exchange_maintenance_credential_v1";
        const { data, error } = await client.rpc(facade, {
          p_principal: input.principal,
          p_envelope: input.envelope,
          p_request: input.request,
        });
        if (error) {
          throw new OpenClawHttpError(
            403,
            "CREDENTIAL_EXCHANGE_DENIED",
            "Credential exchange denied.",
          );
        }
        return data;
      },
    });

    return jsonResponse(
      {
        version: 1,
        requestId,
        result: {
          version: 1,
          token,
          expiresInSeconds: OPENCLAW_RUNTIME_TOKEN_MAX_TTL_SECONDS,
        },
      },
      200,
      requestId,
    );
  } catch (error) {
    // Every authentication failure collapses into one shape so the endpoint is
    // not an oracle for which part of the credential binding was wrong.
    const known = error instanceof OpenClawHttpError ? error : null;
    const secrets = credential ? [credential] : [];
    dependencies.logger?.error(
      "openclaw-runtime-token exchange failed",
      redactLogValue(
        {
          requestId,
          code: known?.code ?? "CREDENTIAL_EXCHANGE_DENIED",
          message: redactText(
            known?.message ?? (error instanceof Error ? error.message : ""),
            secrets,
          ),
        },
        secrets,
      ),
    );
    if (known && known.status !== 500) return errorResponse(known, requestId);
    return errorResponse(
      new OpenClawHttpError(403, "CREDENTIAL_EXCHANGE_DENIED", "Credential exchange denied."),
      requestId,
    );
  }
}
