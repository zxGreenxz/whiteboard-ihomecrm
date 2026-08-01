import { describe, expect, it, vi } from "vitest";

import { handleControlRequest } from "./handler";
import { CONTROL_OPERATION_RPCS, CONTROL_READ_OPERATION_RPCS } from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "dddd4000-0000-4000-8000-000000000001";
const CLIENT_OPERATION_ID = "dddd8000-0000-4000-8000-000000000001";
const ORIGIN = "https://ptcrm.vercel.app";
const DISCLOSURE_PAYLOAD = {
  version: 1,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  disclosureVersion: 3,
};
const REVOCATION = {
  version: 1 as const,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  cellId: "dddd2000-0000-4000-8000-000000000001",
  runtimeCommandId: "dddd5000-0000-4000-8000-000000000001",
  revocationId: "dddd6000-0000-4000-8000-000000000001",
  revocationKind: "SESSION" as const,
  revokedGeneration: 4,
  minimumValidGeneration: 5,
  connectionState: "DISCONNECTING" as const,
  effectiveMode: "DRAFT_ONLY",
};
const ACKNOWLEDGEMENT = {
  version: 1 as const,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  revocationId: REVOCATION.revocationId,
  minimumValidGeneration: REVOCATION.minimumValidGeneration,
  acknowledged: true as const,
  connectionState: "DISCONNECTING" as const,
};

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
  adminRpc?: ReturnType<typeof vi.fn>;
  propagate?: ReturnType<typeof vi.fn>;
} = {}) {
  const logger = options.logger ?? { error: vi.fn() };
  return {
    environment,
    createBrowserClient: () =>
      stubClient(rpc, "userId" in options ? options.userId ?? null : "user-1"),
    createAdminClient: () => ({
      rpc: options.adminRpc ?? vi.fn(() => Promise.resolve({
        data: ACKNOWLEDGEMENT,
        error: null,
      })),
    }),
    propagateGenerationRevocation: options.propagate ?? vi.fn(() => Promise.resolve({
      acknowledgementHash: "f".repeat(64),
    })),
    logger,
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
  };
}

describe("OpenClaw browser control handler", () => {
  it("maps every write operation to exactly one public RPC facade", async () => {
    for (const [operation, expectedRpc] of Object.entries(CONTROL_OPERATION_RPCS)) {
      const payload = operation === "ACKNOWLEDGE_DISCLOSURE"
        ? DISCLOSURE_PAYLOAD
        : operation === "DISCONNECT_ACCOUNT"
        ? {
            version: 1,
            organizationId: ORGANIZATION_ID,
            accountId: ACCOUNT_ID,
            expectedConnectionGeneration: 2,
            reasonCode: "USER_REQUESTED",
          }
        : { version: 1, organizationId: ORGANIZATION_ID };
      const rpc = vi.fn(() => Promise.resolve({
        data: operation === "DISCONNECT_ACCOUNT"
          ? REVOCATION
          : operation === "ACKNOWLEDGE_DISCLOSURE"
          ? {
              version: 1,
              organizationId: ORGANIZATION_ID,
              accountId: ACCOUNT_ID,
              disclosureAcknowledgedVersion: 3,
              disclosureAcknowledgedAt: "2026-08-01T00:00:00+00:00",
              idempotentReplay: false,
            }
          : { version: 1, ok: true },
        error: null,
      }));
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation,
          clientOperationId: CLIENT_OPERATION_ID,
          payload,
        }),
        dependencies(rpc),
      );

      expect(response.status, operation).toBe(200);
      expect(rpc, operation).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0][0], operation).toBe(expectedRpc);
      expect(rpc.mock.calls[0][1], operation).toEqual({
        p_request: payload,
        p_client_operation_id: CLIENT_OPERATION_ID,
      });
    }
  });

  it("supports only the exact disclosure acknowledgement contract", async () => {
    const result = {
      version: 1,
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      disclosureAcknowledgedVersion: 3,
      disclosureAcknowledgedAt: "2026-08-01T00:00:00+00:00",
      idempotentReplay: false,
    };
    const rpc = vi.fn(() => Promise.resolve({ data: result, error: null }));
    const accepted = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "ACKNOWLEDGE_DISCLOSURE",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: DISCLOSURE_PAYLOAD,
      }),
      dependencies(rpc),
    );

    expect(accepted.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("openclaw_acknowledge_disclosure_v1", {
      p_request: DISCLOSURE_PAYLOAD,
      p_client_operation_id: CLIENT_OPERATION_ID,
    });
    expect((await accepted.json()).result).toEqual(result);

    for (const payload of [
      { ...DISCLOSURE_PAYLOAD, evidenceHash: "a".repeat(64) },
      { ...DISCLOSURE_PAYLOAD, disclosureVersion: 0 },
      { ...DISCLOSURE_PAYLOAD, accountId: "not-a-uuid" },
    ]) {
      const rejected = await handleControlRequest(
        controlRequest({
          version: 1,
          operation: "ACKNOWLEDGE_DISCLOSURE",
          clientOperationId: CLIENT_OPERATION_ID,
          payload,
        }),
        dependencies(rpc),
      );
      expect(rejected.status).toBe(400);
    }
    expect(rpc).toHaveBeenCalledTimes(1);

    const invalidResultRpc = vi.fn(() => Promise.resolve({
      data: { ...result, disclosureAcknowledgedVersion: 2 },
      error: null,
    }));
    const invalidResult = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "ACKNOWLEDGE_DISCLOSURE",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: DISCLOSURE_PAYLOAD,
      }),
      dependencies(invalidResultRpc),
    );
    expect(invalidResult.status).toBe(500);
  });

  it("rejects disclosureVersion zero locally without calling SQL", async () => {
    const rpc = vi.fn();
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "ACKNOWLEDGE_DISCLOSURE",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: { ...DISCLOSURE_PAYLOAD, disclosureVersion: 0 },
      }),
      dependencies(rpc),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts the live DISCONNECTING projection before and after gateway acknowledgement", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: REVOCATION, error: null }));
    const adminRpc = vi.fn(() => Promise.resolve({
      data: ACKNOWLEDGEMENT,
      error: null,
    }));
    const propagate = vi.fn(() => Promise.resolve({ acknowledgementHash: "e".repeat(64) }));

    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );

    expect(response.status).toBe(200);
    expect(propagate).toHaveBeenCalledWith(REVOCATION);
    expect(adminRpc).toHaveBeenCalledWith("openclaw_service_ack_disconnect_revocation_v1", {
      p_actor_id: "user-1",
      p_request: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        revocationId: REVOCATION.revocationId,
        minimumValidGeneration: REVOCATION.minimumValidGeneration,
        acknowledgementHash: "e".repeat(64),
      },
    });
    expect((await response.json()).result).toEqual({
      version: 1,
      acknowledged: true,
      connectionState: "DISCONNECTING",
    });
  });

  it("accepts a DISCONNECTED acknowledgement when provider evidence wins the race", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: REVOCATION, error: null }));
    const adminRpc = vi.fn(() => Promise.resolve({
      data: { ...ACKNOWLEDGEMENT, connectionState: "DISCONNECTED" as const },
      error: null,
    }));
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual({
      version: 1,
      acknowledged: true,
      connectionState: "DISCONNECTED",
    });
  });

  it("keeps disconnect on one idempotent DB → gateway → acknowledgement path", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: REVOCATION, error: null }));
    const adminRpc = vi.fn(() => Promise.resolve({
      data: ACKNOWLEDGEMENT,
      error: null,
    }));
    const propagate = vi.fn(() => Promise.resolve({ acknowledgementHash: "e".repeat(64) }));
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );

    expect(response.status).toBe(200);
    expect(propagate).toHaveBeenCalledWith(REVOCATION);
    expect(adminRpc).toHaveBeenCalledWith("openclaw_service_ack_disconnect_revocation_v1", {
      p_actor_id: "user-1",
      p_request: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        revocationId: REVOCATION.revocationId,
        minimumValidGeneration: 5,
        acknowledgementHash: "e".repeat(64),
      },
    });
    expect((await response.json()).result).toEqual({
      version: 1,
      acknowledged: true,
      connectionState: "DISCONNECTING",
    });
  });

  it("rejects non-canonical privileged acknowledgement results before returning 200", async () => {
    const privilegedMarker = "service-role-only-field";
    for (const data of [
      null,
      { version: 1, acknowledged: true, connectionState: "DISCONNECTING" },
      { ...ACKNOWLEDGEMENT, connectionState: "RECONNECT_REQUIRED" },
      { ...ACKNOWLEDGEMENT, privilegedMarker },
    ]) {
      const rpc = vi.fn(() => Promise.resolve({ data: REVOCATION, error: null }));
      const adminRpc = vi.fn(() => Promise.resolve({ data, error: null }));
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation: "DISCONNECT_ACCOUNT",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: {
            version: 1,
            organizationId: ORGANIZATION_ID,
            accountId: ACCOUNT_ID,
            expectedConnectionGeneration: 2,
            reasonCode: "USER_REQUESTED",
          },
        }),
        dependencies(rpc, { adminRpc }),
      );
      const raw = await response.text();

      expect(response.status).toBe(502);
      expect(raw).not.toContain(privilegedMarker);
      expect(raw).not.toContain(REVOCATION.revocationId);
    }
  });

  it("rejects a foreign disconnect revocation before propagation or acknowledgement", async () => {
    for (const data of [
      { ...REVOCATION, organizationId: "dddd0000-0000-4000-8000-000000000099" },
      { ...REVOCATION, accountId: "dddd1000-0000-4000-8000-000000000099" },
    ]) {
      const rpc = vi.fn(() => Promise.resolve({ data, error: null }));
      const adminRpc = vi.fn();
      const propagate = vi.fn();
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation: "DISCONNECT_ACCOUNT",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: {
            version: 1,
            organizationId: ORGANIZATION_ID,
            accountId: ACCOUNT_ID,
            expectedConnectionGeneration: 2,
            reasonCode: "USER_REQUESTED",
          },
        }),
        dependencies(rpc, { adminRpc, propagate }),
      );

      expect(response.status).toBe(500);
      expect(propagate).not.toHaveBeenCalled();
      expect(adminRpc).not.toHaveBeenCalled();
    }
  });

  it("leaves the account fail-closed in DISCONNECTING when gateway propagation fails", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: REVOCATION, error: null }));
    const adminRpc = vi.fn();
    const propagate = vi.fn(() => Promise.reject(new Error("gateway unavailable")));
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );
    expect(response.status).toBe(503);
    expect(adminRpc).not.toHaveBeenCalled();
    expect(propagate).toHaveBeenCalledWith(REVOCATION);
  });

  it("finishes a pending disconnect after membership revocation without restoring access", async () => {
    const payload = {
      version: 1,
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      expectedConnectionGeneration: 2,
      reasonCode: "USER_REQUESTED",
    };
    const rpc = vi.fn(() => Promise.resolve({
      data: null,
      error: { code: "42501", message: "membership revoked" },
    }));
    const adminRpc = vi.fn((name: string) => {
      if (name === "openclaw_service_resume_disconnect_revocation_v1") {
        return Promise.resolve({ data: REVOCATION, error: null });
      }
      return Promise.resolve({
        data: ACKNOWLEDGEMENT,
        error: null,
      });
    });
    const propagate = vi.fn(() => Promise.resolve({ acknowledgementHash: "e".repeat(64) }));

    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload,
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("PERMISSION_DENIED");
    expect(adminRpc).toHaveBeenNthCalledWith(1, "openclaw_service_resume_disconnect_revocation_v1", {
      p_actor_id: "user-1",
      p_organization_id: ORGANIZATION_ID,
      p_client_operation_id: CLIENT_OPERATION_ID,
    });
    expect(propagate).toHaveBeenCalledWith(REVOCATION);
    expect(adminRpc).toHaveBeenNthCalledWith(2, "openclaw_service_ack_disconnect_revocation_v1", {
      p_actor_id: "user-1",
      p_request: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        revocationId: REVOCATION.revocationId,
        minimumValidGeneration: REVOCATION.minimumValidGeneration,
        acknowledgementHash: "e".repeat(64),
      },
    });
  });

  it("returns retryable pending when membership-loss recovery cannot reach the gateway", async () => {
    const gatewayMessage = `gateway failed for ${REVOCATION.revocationId}`;
    const rpc = vi.fn(() => Promise.resolve({
      data: null,
      error: { code: "42501", message: "membership revoked" },
    }));
    const adminRpc = vi.fn(() => Promise.resolve({ data: REVOCATION, error: null }));
    const propagate = vi.fn(() => Promise.reject(new Error(gatewayMessage)));

    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(raw).error).toEqual({
      code: "REVOCATION_PENDING",
      message: "Disconnect is pending generation revocation; retry safely.",
    });
    expect(propagate).toHaveBeenCalledWith(REVOCATION);
    expect(raw).not.toContain(gatewayMessage);
    expect(raw).not.toContain(REVOCATION.revocationId);
  });

  it("returns retryable pending semantics when revoked-actor DB acknowledgement fails after gateway revocation", async () => {
    const sqlMessage = `ack failed for ${REVOCATION.revocationId}`;
    const rpc = vi.fn(() => Promise.resolve({
      data: null,
      error: { code: "42501", message: "membership revoked" },
    }));
    const adminRpc = vi.fn((name: string) => {
      if (name === "openclaw_service_resume_disconnect_revocation_v1") {
        return Promise.resolve({ data: REVOCATION, error: null });
      }
      return Promise.resolve({ data: null, error: { code: "XX000", message: sqlMessage } });
    });
    const propagate = vi.fn(() => Promise.resolve({ acknowledgementHash: "e".repeat(64) }));

    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(raw).error).toEqual({
      code: "REVOCATION_PENDING",
      message: "Disconnect is pending generation revocation; retry safely.",
    });
    expect(propagate).toHaveBeenCalledWith(REVOCATION);
    expect(raw).not.toContain(sqlMessage);
    expect(raw).not.toContain(REVOCATION.revocationId);
  });

  it("returns retryable pending for transient resume lookup failures", async () => {
    const failureMessage = `resume failed for ${REVOCATION.revocationId}`;
    const resumeFailures = [
      vi.fn(() => Promise.resolve({
        data: null,
        error: { code: "XX000", message: failureMessage },
      })),
      vi.fn(() => Promise.reject(new Error(failureMessage))),
    ];

    for (const adminRpc of resumeFailures) {
      const rpc = vi.fn(() => Promise.resolve({
        data: null,
        error: { code: "42501", message: "membership revoked" },
      }));
      const propagate = vi.fn();
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation: "DISCONNECT_ACCOUNT",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: {
            version: 1,
            organizationId: ORGANIZATION_ID,
            accountId: ACCOUNT_ID,
            expectedConnectionGeneration: 2,
            reasonCode: "USER_REQUESTED",
          },
        }),
        dependencies(rpc, { adminRpc, propagate }),
      );
      const raw = await response.text();

      expect(response.status).toBe(503);
      expect(JSON.parse(raw).error.code).toBe("REVOCATION_PENDING");
      expect(propagate).not.toHaveBeenCalled();
      expect(raw).not.toContain(failureMessage);
      expect(raw).not.toContain(REVOCATION.revocationId);
    }
  });

  it("returns retryable pending for a malformed recovered disconnect", async () => {
    const privilegedMarker = "malformed-recovery-private-field";
    const rpc = vi.fn(() => Promise.resolve({
      data: null,
      error: { code: "42501", message: "membership revoked" },
    }));
    const adminRpc = vi.fn(() => Promise.resolve({
      data: { ...REVOCATION, privilegedMarker },
      error: null,
    }));
    const propagate = vi.fn();
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );
    const raw = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(raw).error.code).toBe("REVOCATION_PENDING");
    expect(propagate).not.toHaveBeenCalled();
    expect(raw).not.toContain(privilegedMarker);
    expect(raw).not.toContain(REVOCATION.revocationId);
  });

  it("does not propagate when revoked-actor recovery finds no owned pending disconnect", async () => {
    const rpc = vi.fn(() => Promise.resolve({
      data: null,
      error: { code: "42501", message: "membership revoked" },
    }));
    const adminRpc = vi.fn(() => Promise.resolve({
      data: null,
      error: { code: "P0002", message: "not found" },
    }));
    const propagate = vi.fn();
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { adminRpc, propagate }),
    );

    expect(response.status).toBe(403);
    expect(adminRpc).toHaveBeenCalledOnce();
    expect(propagate).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical disconnect result before gateway propagation", async () => {
    const rpc = vi.fn(() => Promise.resolve({
      data: { ...REVOCATION, unexpectedTrustedField: true },
      error: null,
    }));
    const propagate = vi.fn();
    const response = await handleControlRequest(
      controlRequest({
        version: 1,
        operation: "DISCONNECT_ACCOUNT",
        clientOperationId: CLIENT_OPERATION_ID,
        payload: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          expectedConnectionGeneration: 2,
          reasonCode: "USER_REQUESTED",
        },
      }),
      dependencies(rpc, { propagate }),
    );

    expect(response.status).toBe(500);
    expect(propagate).not.toHaveBeenCalled();
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
    const cases = [
      ["CONFIRMED_SENT", "OPERATOR_CONFIRMED_SENT"],
      ["CONFIRMED_FAILED", "OPERATOR_CONFIRMED_FAILED"],
      ["NEW_INTENT_CREATED", "OPERATOR_CREATED_NEW_INTENT"],
    ] as const;
    for (const [outcome, reasonCode] of cases) {
      const rpc = vi.fn(() =>
        Promise.resolve({
          data: {
            version: 1,
            outcome,
            reasonCode,
            newOutboxId: outcome === "NEW_INTENT_CREATED"
              ? "dddd7000-0000-4000-8000-000000000001"
              : null,
            historicalDeliveryStateChanged: false,
          },
          error: null,
        })
      );
      const resolution = {
        version: 1,
        organizationId: ORGANIZATION_ID,
        outboxId: "dddd6000-0000-4000-8000-000000000001",
        expectedResolutionVersion: 0,
        expectedEvidenceDomain: "ihome-openclaw-unknown-authority-v1\0",
        expectedEvidenceHash: "a".repeat(64),
        outcome,
        reasonCode,
        operatorEvidenceHash: "b".repeat(64),
        ...(outcome === "NEW_INTENT_CREATED"
          ? {
              newIntent: {
                clientOperationId: "dddd8100-0000-4000-8000-000000000001",
                targetId: "dddd5000-0000-4000-8000-000000000001",
                sourceDraftId: "dddd5100-0000-4000-8000-000000000001",
                expectedDraftVersion: 3,
                replyToMessageId: null,
              },
            }
          : {}),
      };
      const response = await handleControlRequest(
        controlRequest({
          version: 1,
          operation: "RESOLVE_UNKNOWN",
          clientOperationId: CLIENT_OPERATION_ID,
          payload: resolution,
        }),
        dependencies(rpc),
      );

      const body = await response.json();
      expect(response.status, outcome).toBe(200);
      expect(body.result.outcome, outcome).toBe(outcome);
      expect(body.result.historicalDeliveryStateChanged, outcome).toBe(false);
      expect(rpc.mock.calls[0][1].p_request).toEqual(resolution);
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
    const unstructuredProviderContent = "tenant-private-provider-content-sentinel";
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: {
          code: "P0001",
          message:
            `provider rejected: ${unstructuredProviderContent} credential="zalo-root-secret-value" phone 0912345678`,
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
    expect(logged).not.toContain(unstructuredProviderContent);
    expect(logger.error.mock.calls[0]?.[1]).not.toHaveProperty("message");
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
