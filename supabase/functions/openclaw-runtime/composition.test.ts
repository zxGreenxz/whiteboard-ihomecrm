import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../_shared/openclaw/crypto.ts";
import {
  exchangeRuntimeCredential,
  verifyRuntimeRequest,
} from "../_shared/openclaw/runtime-auth.ts";
import { handleRuntimeTokenRequest } from "../openclaw-runtime-token/handler.ts";
import { handleRuntimeRequest } from "./handler.ts";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const RUNTIME_NONCE = "dddd7000-0000-4000-8000-000000000001";
const EXCHANGE_NONCE = "dddd7000-0000-4000-8000-000000000002";
const NOW_SECONDS = 1_785_062_400;
const environment = {
  supabaseUrl: "https://project.supabase.co",
  supabaseAnonKey: "anon",
  supabaseServiceRoleKey: "service-role",
  runtimeTokenSigningKey: "runtime-signing-key-that-is-at-least-32-bytes",
  browserOrigins: ["https://ptcrm.vercel.app"],
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("real runtime-token → runtime handler composition", () => {
  it("binds one non-empty body and emits the exact SQL service context", async () => {
    const bodyText = canonicalJson({
      version: 1,
      commandClaimToken: "c".repeat(32),
      commandLeaseSeconds: 60,
      commandStarts: [],
      commandResults: [],
    });
    const body = new TextEncoder().encode(bodyText);
    const authenticate = vi.fn((rpcInput: unknown) => {
      const input = rpcInput as {
        envelope: { nonce: string; requestHash: string };
        request: {
          requestedOperation: string;
          runtimeMethod: string;
          runtimePath: string;
          runtimeTimestamp: number;
          runtimeNonce: string;
          runtimeBodySha256: string;
        };
      };
      expect(input.request.runtimeBodySha256).toBe(sha256(body));
      return {
        version: 1,
        principalKind: "CHANNEL",
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
        credentialGeneration: "4",
        leaseGeneration: "3",
        fencingToken: "7",
        sessionGeneration: "5",
        localSessionGeneration: "5",
        authMode: "NORMAL",
        requestedOperation: input.request.requestedOperation,
        runtimeMethod: input.request.runtimeMethod,
        runtimePath: input.request.runtimePath,
        runtimeTimestamp: input.request.runtimeTimestamp,
        runtimeNonce: input.request.runtimeNonce,
        runtimeBodySha256: input.request.runtimeBodySha256,
        exchangeNonce: input.envelope.nonce,
        exchangeRequestHash: input.envelope.requestHash,
        authenticatedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
        leaseExpiresAt: new Date((NOW_SECONDS + 120) * 1_000).toISOString(),
      };
    });
    const tokenResponse = await handleRuntimeTokenRequest(
      new Request("https://project.supabase.co/functions/v1/openclaw-runtime-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-credential": "channel-root-credential-that-is-long-enough",
        },
        body: JSON.stringify({
          version: 1,
          principalKind: "CHANNEL",
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          cellId: CELL_ID,
          localSessionGeneration: 5,
          runtimeMethod: "POST",
          runtimePath: "/v1/heartbeat",
          runtimeTimestamp: NOW_SECONDS,
          runtimeNonce: RUNTIME_NONCE,
          runtimeBodySha256: sha256(body),
          exchangeNonce: EXCHANGE_NONCE,
        }),
      }),
      {
        environment,
        createServiceClient: () => ({ rpc: async (_name, args) => ({
          data: await authenticate(args.p_request ? {
            principal: args.p_principal,
            envelope: args.p_envelope,
            request: args.p_request,
          } : args),
          error: null,
        }) }),
        exchangeRuntimeCredential,
        requestIdFactory: () => "token-request",
        now: () => new Date(NOW_SECONDS * 1_000),
      },
    );
    expect(tokenResponse.status).toBe(200);
    const tokenEnvelope = await tokenResponse.json() as {
      result: { token: string; expiresInSeconds: number };
    };

    const runtimeRpc = vi.fn((name: string, args: Record<string, unknown>) => {
      expect(name).toBe("openclaw_service_runtime_heartbeat_v1");
      expect(args.p_principal).toEqual({
        version: 1,
        principalKind: "CHANNEL",
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
        maintenancePrincipalId: null,
        credentialGeneration: 4,
        leaseGeneration: 3,
        fencingToken: 7,
        sessionGeneration: 5,
        localSessionGeneration: 5,
        authMode: "NORMAL",
        allowedOperations: ["openclaw_runtime_heartbeat_v1"],
      });
      const expectedRequestHash = sha256(
        `ihome-openclaw-service-request-v1\0openclaw_runtime_heartbeat_v1\0${bodyText}`,
      );
      expect(args.p_envelope).toEqual({
        version: 1,
        operation: "openclaw_runtime_heartbeat_v1",
        nonce: RUNTIME_NONCE,
        iat: new Date(NOW_SECONDS * 1_000).toISOString(),
        exp: new Date((NOW_SECONDS + 120) * 1_000).toISOString(),
        requestHash: expectedRequestHash,
      });
      expect(args.p_request).toEqual(JSON.parse(bodyText));
      return Promise.resolve({
        data: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          cellId: CELL_ID,
          observedAt: new Date(NOW_SECONDS * 1_000).toISOString(),
          accepted: true,
          authMode: "NORMAL",
          currentSessionGeneration: 5,
          currentConnectionGeneration: 1,
          commandResultAcks: [],
          commands: [],
        },
        error: null,
      });
    });
    const runtimeResponse = await handleRuntimeRequest(
      new Request("https://edge.invalid/openclaw-runtime/v1/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokenEnvelope.result.token}`,
          "x-openclaw-timestamp": String(NOW_SECONDS),
          "x-openclaw-nonce": RUNTIME_NONCE,
        },
        body: bodyText,
      }),
      {
        environment,
        // Xem chú thích `nhuBuilder` trong handler.test.ts: handler runtime gắn
        // hạn giờ bằng `.abortSignal()`, thứ chỉ có trên builder của supabase-js
        // chứ không có trên Promise trần. Chỉ handler NÀY dùng nó — client của
        // openclaw-runtime-token ở trên không cần bọc.
        createServiceClient: () => ({
          rpc: (...args: unknown[]) => {
            const ketQua = Promise.resolve(
              (runtimeRpc as (...a: unknown[]) => unknown)(...args),
            ) as Promise<unknown> & { abortSignal: (s: AbortSignal) => unknown };
            ketQua.abortSignal = () => ketQua;
            return ketQua;
          },
        }),
        verifyRuntimeRequest,
        signGatewayPayload: () => Promise.resolve("A".repeat(86)),
        ticketKeyGeneration: 1,
        requestIdFactory: () => "runtime-request",
        now: () => new Date((NOW_SECONDS + 1) * 1_000),
      },
    );
    expect(runtimeResponse.status).toBe(200);
    expect(runtimeRpc).toHaveBeenCalledTimes(1);
  });
});
