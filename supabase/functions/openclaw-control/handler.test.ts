import { describe, expect, it, vi } from "vitest";

import { handleControlRequest } from "./handler";
import { CONTROL_OPERATION_RPCS, CONTROL_READ_OPERATION_RPCS } from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "dddd4000-0000-4000-8000-000000000001";
const CLIENT_OPERATION_ID = "dddd8000-0000-4000-8000-000000000001";
const ORIGIN = "https://ptcrm.vercel.app";

const environment = {
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
  supabaseAnonKey: "anon-key",
  supabaseServiceRoleKey: "service-role-key",
  runtimeTokenSigningKey: "x".repeat(48),
  browserOrigins: [ORIGIN],
};

function controlRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://edge.invalid/openclaw-control", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer browser.jwt.token",
      origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function stubClient(rpc: ReturnType<typeof vi.fn>, userId: string | null = "user-1") {
  return {
    auth: {
      getUser: vi.fn(() =>
        Promise.resolve({
          data: { user: userId ? { id: userId } : null },
          error: userId ? null : { message: "no session" },
        })
      ),
    },
    rpc,
  };
}

function dependencies(rpc: ReturnType<typeof vi.fn>, options: {
  userId?: string | null;
  logger?: { error: ReturnType<typeof vi.fn> };
} = {}) {
  const logger = options.logger ?? { error: vi.fn() };
  return {
    environment,
    createBrowserClient: () =>
      stubClient(rpc, "userId" in options ? options.userId ?? null : "user-1"),
    logger,
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
  };
}

describe("OpenClaw browser control handler", () => {
  it("maps every write operation to exactly one public RPC facade", async () => {
    for (const [operation, expectedRpc] of Object.entries(CONTROL_OPERATION_RPCS)) {
      const rpc = vi.fn(() => Promise.resolve({ data: { version: 1, ok: true }, error: null }));
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation,
          clientOperationId: CLIENT_OPERATION_ID,
          payload: { version: 1, organizationId: ORGANIZATION_ID },
        }),
        dependencies(rpc),
      );

      expect(response.status, operation).toBe(200);
      expect(rpc, operation).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][0], operation).toBe(expectedRpc);
      expect(rpc.mock.calls[0][1], operation).toEqual({
        p_request: { version: 1, organizationId: ORGANIZATION_ID },
        p_client_operation_id: CLIENT_OPERATION_ID,
      });
    }
  });

  it("routes read operations without a client operation id", async () => {
    for (const [operation, expectedRpc] of Object.entries(CONTROL_READ_OPERATION_RPCS)) {
      const rpc = vi.fn(() => Promise.resolve({ data: { version: 1, rows: [] }, error: null }));
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation,
          payload: { version: 1, organizationId: ORGANIZATION_ID },
        }),
        dependencies(rpc),
      );

      expect(response.status, operation).toBe(200);
      expect(rpc.mock.calls[0][0], operation).toBe(expectedRpc);
      expect(rpc.mock.calls[0][1], operation).toEqual({
        p_request: { version: 1, organizationId: ORGANIZATION_ID },
      });
    }
  });

  it("never exposes a generic SQL, admin, or unknown operation path", async () => {
    for (const operation of ["EXECUTE_SQL", "openclaw_get_bootstrap_v1", "ADMIN", ""]) {
      const rpc = vi.fn();
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation,
          clientOperationId: CLIENT_OPERATION_ID,
          payload: {},
        }),
        dependencies(rpc),
      );

      expect(response.status, operation).toBe(400);
      expect(rpc, operation).not.toHaveBeenCalled();
    }
  });

  it("requires browser authentication before touching any RPC", async () => {
    const rpc = vi.fn();
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "MARK_CONVERSATION_READ",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID },
      }),
      dependencies(rpc, { userId: null }),
    );

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies a request from an origin outside the allowlist", async () => {
    const rpc = vi.fn();
    const response = await handleControlRequest(
      controlRequest(
        {
          version: 1,
          operation: "MARK_CONVERSATION_READ",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: { version: 1, organizationId: ORGANIZATION_ID },
        },
        { origin: "https://evil.example" },
      ),
      dependencies(rpc),
    );

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers CORS preflight without reaching authentication", async () => {
    const rpc = vi.fn();
    const response = await handleControlRequest(
      new Request("https://edge.invalid/openclaw-control", {
        method: "OPTIONS",
        headers: { origin: ORIGIN },
      }),
      dependencies(rpc),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes through the three UNKNOWN resolution outcomes untouched", async () => {
    for (const outcome of ["LINKED_TO_EXISTING", "NEW_INTENT_CREATED", "DISCARDED"]) {
      const rpc = vi.fn(() =>
        Promise.resolve({
          data: { version: 1, outcome, historicalDeliveryStateChanged: false },
          error: null,
        })
      );
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation: "RESOLVE_UNKNOWN",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: { version: 1, organizationId: ORGANIZATION_ID, outcome },
        }),
        dependencies(rpc),
      );

      const body = await response.json();
      expect(response.status, outcome).toBe(200);
      expect(body.result.outcome, outcome).toBe(outcome);
      expect(body.result.historicalDeliveryStateChanged, outcome).toBe(false);
    }
  });

  it("maps a competing resolution serialization failure to 409", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: { code: "40001", message: "could not serialize access" },
      })
    );
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "RESOLVE_UNKNOWN",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID },
      }),
      dependencies(rpc),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("CONFLICT");
  });

  it("maps a permission or membership denial to 403 without leaking SQL detail", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: {
          code: "42501",
          message:
            "permission denied for openclaw_zalo.manage_operations on organization aaaa0000-0000-4000-8000-000000000001",
        },
      })
    );
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "SET_CONTROL_STATE",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID },
      }),
      dependencies(rpc),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(JSON.stringify(body)).not.toContain("aaaa0000-0000-4000-8000-000000000001");
  });

  it("returns the stored result for an idempotent replay", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: { version: 1, isReplay: true, conversationId: CONVERSATION_ID },
        error: null,
      })
    );
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "CREATE_SEND_INTENT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID },
      }),
      dependencies(rpc),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.isReplay).toBe(true);
  });

  it("maps a same-key different-payload conflict to 409", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: { version: 1, conflict: true }, error: null })
    );
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "CREATE_SEND_INTENT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID },
      }),
      dependencies(rpc),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("redacts raw provider errors before logging or responding", async () => {
    const logger = { error: vi.fn() };
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: {
          code: "P0001",
          message:
            'provider rejected: credential="zalo-root-secret-value" phone 0912345678',
        },
      })
    );
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "CREATE_SEND_INTENT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID },
      }),
      dependencies(rpc, { logger }),
    );
    const raw = JSON.stringify(await response.json());
    const logged = JSON.stringify(logger.error.mock.calls);

    expect(response.status).toBe(400);
    expect(raw).not.toContain("zalo-root-secret-value");
    expect(raw).not.toContain("0912345678");
    expect(logged).not.toContain("zalo-root-secret-value");
    expect(logged).not.toContain("0912345678");
  });

  it("rejects a non-POST method and an oversized body", async () => {
    const rpc = vi.fn();
    const methodResponse = await handleControlRequest(
      new Request("https://edge.invalid/openclaw-control", {
        method: "GET",
        headers: { origin: ORIGIN, authorization: "Bearer browser.jwt.token" },
      }),
      dependencies(rpc),
    );
    expect(methodResponse.status).toBe(405);

    const oversizeResponse = await handleControlRequest(
      controlRequest(
        {
          version: 1,
          operation: "CREATE_SEND_INTENT",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: { version: 1, text: "x".repeat(300_000) },
        },
      ),
      dependencies(rpc),
    );
    expect(oversizeResponse.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("always answers with no-store cache headers", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: { version: 1 }, error: null }));
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "MARK_CONVERSATION_READ",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { version: 1, organizationId: ORGANIZATION_ID, accountId: ACCOUNT_ID },
      }),
      dependencies(rpc),
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });
});