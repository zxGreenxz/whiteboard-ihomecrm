import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { handleQrRequest } from "./handler";
import * as qrHandlerModule from "./handler";
import { OPENCLAW_QR_CHALLENGE_TTL_SECONDS, QR_OPERATION_RPCS } from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "dddd3000-0000-4000-8000-000000000001";
const RUNTIME_COMMAND_ID = "dddd5000-0000-4000-8000-000000000001";
const CLIENT_OPERATION_ID = "dddd8000-0000-4000-8000-000000000001";
const ORIGIN = "https://ptcrm.vercel.app";
const BROWSER_NONCE_HASH = "a".repeat(64);
const SESSION_ID = "browser-session-1";
const AUTH_SESSION_HASH = createHash("sha256").update(SESSION_ID).digest("hex");
const BEGIN_RESULT = {
  version: 1,
  organizationId: ORGANIZATION_ID,
  accountId: ACCOUNT_ID,
  cellId: CELL_ID,
  challengeId: CHALLENGE_ID,
  runtimeCommandId: RUNTIME_COMMAND_ID,
  issuedAt: "2026-08-01T00:00:00+00:00",
  expiresAt: "2026-08-01T00:02:00+00:00",
  status: "PENDING",
};
const POLL_RESULT = {
  version: 1,
  challenge: {
    challengeId: CHALLENGE_ID,
    accountId: ACCOUNT_ID,
    cellId: CELL_ID,
    challengeVersion: 1,
    challengeStatus: "READY",
    materialVersion: 1,
    issuedAt: "2026-08-01T00:00:00+00:00",
    expiresAt: "2026-08-01T00:02:00+00:00",
    consumedAt: null,
    revokedAt: null,
  },
};

function browserJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ sub: "user-1", session_id: SESSION_ID })}.sig`;
}

const QR_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const environment = {
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
  supabaseAnonKey: "anon-key",
  supabaseServiceRoleKey: "service-role-key",
  runtimeTokenSigningKey: "x".repeat(48),
  browserOrigins: [ORIGIN],
};
const DEFAULT_QR_DECRYPTION_KEY = await crypto.subtle.importKey(
  "raw",
  new Uint8Array(32).buffer,
  { name: "AES-GCM" },
  false,
  ["decrypt"],
);

async function encryptQrMaterial(key: CryptoKey, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  // WebCrypto appends the 16-byte tag; the SQL row stores it separately.
  const ciphertext = sealed.slice(0, sealed.length - 16);
  const authTag = sealed.slice(sealed.length - 16);
  return {
    ciphertextB64: btoa(String.fromCharCode(...ciphertext)),
    cipherIvB64: btoa(String.fromCharCode(...iv)),
    authTagB64: btoa(String.fromCharCode(...authTag)),
  };
}

function qrRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://edge.invalid/openclaw-qr", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${browserJwt()}`,
      origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(options: {
  rpc?: ReturnType<typeof vi.fn>;
  adminRpc?: ReturnType<typeof vi.fn>;
  userId?: string | null;
  logger?: { error: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn> };
  qrDecryptionKey?: CryptoKey;
} = {}) {
  const rpc = options.rpc ?? vi.fn();
  const adminRpc = options.adminRpc ?? options.rpc ?? vi.fn();
  const userId = "userId" in options ? options.userId ?? null : "user-1";
  return {
    environment,
    qrDecryptionKey: options.qrDecryptionKey ?? DEFAULT_QR_DECRYPTION_KEY,
    createBrowserClient: () => ({
      auth: {
        getUser: vi.fn(() =>
          Promise.resolve({
            data: { user: userId ? { id: userId } : null },
            error: userId ? null : { message: "no session" },
          })
        ),
      },
      rpc,
    }),
    createAdminClient: () => ({ rpc: adminRpc }),
    logger: options.logger ?? { error: vi.fn(), info: vi.fn() },
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
  };
}

describe("OpenClaw one-time QR reveal handler", () => {
  it("rejects an invalid process key before a consume handler can be constructed", async () => {
    const createHandler = (qrHandlerModule as {
      createQrRequestHandler?: (
        dependencies: Record<string, unknown>,
        encodedKey: string,
      ) => Promise<(request: Request) => Promise<Response>>;
    }).createQrRequestHandler;
    const adminRpc = vi.fn();

    expect(createHandler).toBeTypeOf("function");
    if (!createHandler) return;
    await expect(createHandler({
      environment,
      createBrowserClient: () => ({ auth: { getUser: vi.fn() }, rpc: vi.fn() }),
      createAdminClient: () => ({ rpc: adminRpc }),
    }, "not-base64")).rejects.toThrow(/QR encryption key/i);
    expect(adminRpc).not.toHaveBeenCalled();
  });

  it("fixes the challenge lifetime at exactly 120 seconds", () => {
    expect(OPENCLAW_QR_CHALLENGE_TTL_SECONDS).toBe(120);
  });

  it("routes begin, poll, and consume to their exact RPC facades", async () => {
    const begin = vi.fn(() =>
      Promise.resolve({
        data: BEGIN_RESULT,
        error: null,
      })
    );
    const beginResponse = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "BEGIN",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
        disclosureVersion: 3,
      }),
      dependencies({ rpc: begin }),
    );
    expect(beginResponse.status).toBe(200);
    expect(begin.mock.calls[0][0]).toBe(QR_OPERATION_RPCS.BEGIN);

    const poll = vi.fn(() =>
      Promise.resolve({
        data: POLL_RESULT,
        error: null,
      })
    );
    const pollResponse = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc: poll }),
    );
    expect(pollResponse.status).toBe(200);
    expect(poll.mock.calls[0][0]).toBe(QR_OPERATION_RPCS.POLL);
  });

  it("proves issued_at plus 120 seconds equals expires_at on begin", async () => {
    const issuedAt = "2026-08-01T00:00:00+00:00";
    const expiresAt = "2026-08-01T00:02:00+00:00";
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: { ...BEGIN_RESULT, issuedAt, expiresAt },
        error: null,
      })
    );
    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "BEGIN",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        cellId: CELL_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
        disclosureVersion: 3,
      }),
      dependencies({ rpc }),
    );
    const body = await response.json();

    expect(
      (Date.parse(body.result.expiresAt) - Date.parse(body.result.issuedAt)) / 1000,
    ).toBe(OPENCLAW_QR_CHALLENGE_TTL_SECONDS);
  });

  it("rejects a non-canonical or mismatched begin result", async () => {
    for (const data of [
      { ...BEGIN_RESULT, issuedAt: undefined },
      { ...BEGIN_RESULT, internalState: "hidden" },
      { ...BEGIN_RESULT, organizationId: "dddd0000-0000-4000-8000-000000000099" },
      { ...BEGIN_RESULT, expiresAt: "2026-08-01T00:02:01+00:00" },
    ]) {
      const rpc = vi.fn(() => Promise.resolve({ data, error: null }));
      const response = await handleQrRequest(
        qrRequest({
          version: 1,
          operation: "BEGIN",
          clientOperationId: CLIENT_OPERATION_ID,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          cellId: CELL_ID,
          browserNonceHash: BROWSER_NONCE_HASH,
          authSessionHash: AUTH_SESSION_HASH,
          disclosureVersion: 3,
        }),
        dependencies({ rpc }),
      );
      expect(response.status).toBe(500);
    }
  });

  it("rejects zero and unsafe disclosure versions locally before BEGIN SQL", async () => {
    const rpc = vi.fn(() => Promise.resolve({ data: BEGIN_RESULT, error: null }));
    for (const disclosureVersion of [0, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await handleQrRequest(
        qrRequest({
          version: 1,
          operation: "BEGIN",
          clientOperationId: CLIENT_OPERATION_ID,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          cellId: CELL_ID,
          browserNonceHash: BROWSER_NONCE_HASH,
          authSessionHash: AUTH_SESSION_HASH,
          disclosureVersion,
        }),
        dependencies({ rpc }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("decrypts the exact SQL consume result while projecting only safe fields", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        status: "CONSUMED",
        materialVersion: 1,
        ...material,
      },
      error: null,
    }));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, qrDecryptionKey: key }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual({
      version: 1,
      challengeId: CHALLENGE_ID,
      status: "CONSUMED",
      qrPngDataUrl: QR_PNG_DATA_URL,
    });
  });

  it("rejects SQL consume material bound to another account before decrypting", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: "dddd1000-0000-4000-8000-000000000099",
        challengeId: CHALLENGE_ID,
        status: "CONSUMED",
        materialVersion: 1,
        ...material,
      },
      error: null,
    }));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, qrDecryptionKey: key }),
    );
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain(QR_PNG_DATA_URL);
    expect(raw).not.toContain(material.ciphertextB64);
  });

  it("reveals the QR exactly once and never on a replay", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);

    let consumed = false;
    const browserRpc = vi.fn();
    const adminRpc = vi.fn(() => {
      if (consumed) {
        return Promise.resolve({
          data: null,
          error: { code: "P0002", message: "no active challenge" },
        });
      }
      consumed = true;
      return Promise.resolve({
        data: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          challengeId: CHALLENGE_ID,
          status: "CONSUMED",
          materialVersion: 1,
          ...material,
        },
        error: null,
      });
    });

    const consumeBody = {
      version: 1,
      operation: "CONSUME",
      clientOperationId: CLIENT_OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      challengeId: CHALLENGE_ID,
      browserNonceHash: BROWSER_NONCE_HASH,
      authSessionHash: AUTH_SESSION_HASH,
    };

    const first = await handleQrRequest(
      qrRequest(consumeBody),
      dependencies({ rpc: browserRpc, adminRpc, qrDecryptionKey: key }),
    );
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.result.qrPngDataUrl).toBe(QR_PNG_DATA_URL);

    const second = await handleQrRequest(
      qrRequest(consumeBody),
      dependencies({ rpc: browserRpc, adminRpc, qrDecryptionKey: key }),
    );
    const secondText = await second.text();
    expect(second.status).toBe(404);
    expect(secondText).not.toContain(QR_PNG_DATA_URL);
    expect(browserRpc).not.toHaveBeenCalled();
    expect(adminRpc).toHaveBeenNthCalledWith(1, QR_OPERATION_RPCS.CONSUME, {
      p_request: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      },
      p_client_operation_id: CLIENT_OPERATION_ID,
      p_actor_id: "user-1",
    });
  });

  it("returns a stable error for expired, refreshed, or replayed challenges", async () => {
    const statuses: string[] = [];
    const messages: string[] = [];
    for (const code of ["P0002", "P0002", "P0002"]) {
      const rpc = vi.fn(() =>
        Promise.resolve({
          data: null,
          error: { code, message: `challenge ${CHALLENGE_ID} is not consumable` },
        })
      );
      const response = await handleQrRequest(
        qrRequest({
          version: 1,
          operation: "CONSUME",
          clientOperationId: CLIENT_OPERATION_ID,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          challengeId: CHALLENGE_ID,
          browserNonceHash: BROWSER_NONCE_HASH,
          authSessionHash: AUTH_SESSION_HASH,
        }),
        dependencies({ rpc }),
      );
      statuses.push(String(response.status));
      messages.push((await response.json()).error.code);
    }

    expect(new Set(statuses).size).toBe(1);
    expect(new Set(messages).size).toBe(1);
  });

  it("maps poll rate limits to a stable 429 without leaking SQL or QR evidence", async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const sqlMessage = `poll ${CHALLENGE_ID} exceeded limit with ${QR_PNG_DATA_URL}`;
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: null,
        error: { code: "P0003", message: sqlMessage },
      })
    );

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, logger }),
    );
    const body = await response.json();
    const logged = JSON.stringify(logger.error.mock.calls);

    expect(response.status).toBe(429);
    expect(body).toEqual({
      error: {
        code: "QR_RATE_LIMITED",
        message: "Too many QR requests; retry later.",
      },
      requestId: "dddd9000-0000-4000-8000-000000000001",
    });
    expect(logger.error).toHaveBeenCalledWith("openclaw-qr rpc failed", {
      requestId: "dddd9000-0000-4000-8000-000000000001",
      operation: "POLL",
      code: "P0003",
    });
    expect(JSON.stringify(body)).not.toContain(sqlMessage);
    expect(logged).not.toContain(CHALLENGE_ID);
    expect(logged).not.toContain(QR_PNG_DATA_URL);
    expect(logged).not.toContain(sqlMessage);
  });

  it("rejects and never echoes privileged fields in a poll result", async () => {
    const privilegedMarker = "service-role-poll-secret";
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        challenge: {
          challengeId: CHALLENGE_ID,
          accountId: ACCOUNT_ID,
          cellId: CELL_ID,
          challengeVersion: 1,
          challengeStatus: "READY",
          materialVersion: 1,
          issuedAt: "2026-08-01T00:00:00+00:00",
          expiresAt: "2026-08-01T00:02:00+00:00",
          consumedAt: null,
          revokedAt: null,
        },
        privilegedMarker,
      },
      error: null,
    }));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc }),
    );
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain(privilegedMarker);
  });

  it("rejects a poll result bound to another challenge", async () => {
    const foreignChallengeId = "dddd3000-0000-4000-8000-000000000099";
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        challenge: {
          challengeId: foreignChallengeId,
          accountId: ACCOUNT_ID,
          cellId: CELL_ID,
          challengeVersion: 1,
          challengeStatus: "READY",
          materialVersion: 1,
          issuedAt: "2026-08-01T00:00:00+00:00",
          expiresAt: "2026-08-01T00:02:00+00:00",
          consumedAt: null,
          revokedAt: null,
        },
      },
      error: null,
    }));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(foreignChallengeId);
  });

  it("never logs or echoes QR content, even when decryption fails", async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          challengeId: CHALLENGE_ID,
          status: "CONSUMED",
          materialVersion: 1,
          ciphertextB64: btoa("not-really-encrypted-qr-bytes"),
          cipherIvB64: btoa("123456789012"),
          authTagB64: btoa("1234567890123456"),
        },
        error: null,
      })
    );
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, logger, qrDecryptionKey: key }),
    );
    const raw = await response.text();
    const logged = JSON.stringify(logger.error.mock.calls) + JSON.stringify(logger.info.mock.calls);

    expect(response.status).toBe(500);
    expect(raw).not.toContain("not-really-encrypted-qr-bytes");
    expect(raw).not.toContain("ciphertext");
    expect(logged).not.toContain("not-really-encrypted-qr-bytes");
    expect(logged).not.toContain(QR_PNG_DATA_URL);
  });

  it("answers with Cache-Control: no-store on every QR response", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: {
          version: 1,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          challengeId: CHALLENGE_ID,
          status: "CONSUMED",
          materialVersion: 1,
          ...material,
        },
        error: null,
      })
    );

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, qrDecryptionKey: key }),
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("rejects consumed material returned for another organization or challenge", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        organizationId: "dddd0000-0000-4000-8000-000000000099",
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        status: "CONSUMED",
        materialVersion: 1,
        ...material,
      },
      error: null,
    }));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, qrDecryptionKey: key }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(QR_PNG_DATA_URL);
  });

  it("rejects decrypted data that claims PNG MIME without PNG magic bytes", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const fakePng = "data:image/png;base64," + btoa("not-a-png");
    const material = await encryptQrMaterial(key, fakePng);
    const rpc = vi.fn(() => Promise.resolve({
      data: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        status: "CONSUMED",
        materialVersion: 1,
        ...material,
      },
      error: null,
    }));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, qrDecryptionKey: key }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(fakePng);
  });

  it("rechecks authentication on every poll", async () => {
    const rpc = vi.fn();
    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, userId: null }),
    );

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps an exact null challenge poll result to QR_NOT_AVAILABLE", async () => {
    const rpc = vi.fn(() => Promise.resolve({
      data: { version: 1, challenge: null },
      error: null,
    }));
    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error).toEqual({
      code: "QR_NOT_AVAILABLE",
      message: "QR challenge is not available.",
    });
  });

  it("binds every poll to the verified auth session and browser nonce", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: POLL_RESULT,
        error: null,
      })
    );
    const poll = {
      version: 1,
      operation: "POLL",
      organizationId: ORGANIZATION_ID,
      challengeId: CHALLENGE_ID,
      browserNonceHash: BROWSER_NONCE_HASH,
      authSessionHash: AUTH_SESSION_HASH,
    };

    const accepted = await handleQrRequest(qrRequest(poll), dependencies({ rpc }));

    expect(accepted.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(QR_OPERATION_RPCS.POLL, {
      p_request: {
        version: 1,
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      },
    });

    const wrongSession = await handleQrRequest(
      qrRequest({ ...poll, authSessionHash: "c".repeat(64) }),
      dependencies({ rpc }),
    );
    expect(wrongSession.status).toBe(403);
    expect((await wrongSession.json()).error.code).toBe("SESSION_BINDING_INVALID");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rejects a request whose browser nonce or auth session binding is malformed", async () => {
    const rpc = vi.fn();
    for (const mutation of [
      { browserNonceHash: "short" },
      { authSessionHash: "" },
      { challengeId: "not-a-uuid" },
    ]) {
      const response = await handleQrRequest(
        qrRequest({
          version: 1,
          operation: "CONSUME",
          clientOperationId: CLIENT_OPERATION_ID,
          organizationId: ORGANIZATION_ID,
          accountId: ACCOUNT_ID,
          challengeId: CHALLENGE_ID,
          browserNonceHash: BROWSER_NONCE_HASH,
          authSessionHash: AUTH_SESSION_HASH,
          ...mutation,
        }),
        dependencies({ rpc }),
      );
      expect(response.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies an origin outside the allowlist before authentication", async () => {
    const rpc = vi.fn();
    const response = await handleQrRequest(
      qrRequest(
        {
          version: 1,
          operation: "POLL",
          organizationId: ORGANIZATION_ID,
          challengeId: CHALLENGE_ID,
          browserNonceHash: BROWSER_NONCE_HASH,
          authSessionHash: AUTH_SESSION_HASH,
        },
        { origin: "https://evil.example" },
      ),
      dependencies({ rpc }),
    );

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows the headers supabase-js actually sends on every browser call", async () => {
    // supabase-js adds `apikey` (fetchWithAuth) and `x-client-info` (DEFAULT_HEADERS)
    // to every request. A cross-origin POST with a JSON body always preflights, and
    // the browser compares the FULL Access-Control-Request-Headers list against the
    // response - so a missing entry blocks the call before it reaches this function,
    // leaving nothing in the server log. That is exactly what happened to the QR
    // dialog the first time it was wired to this endpoint.
    const response = await handleQrRequest(
      new Request("https://edge.example/openclaw-qr", {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "apikey,authorization,content-type,x-client-info",
        },
      }),
      dependencies({ rpc: vi.fn() }),
    );

    expect(response.status).toBe(204);
    const allowed = (response.headers.get("access-control-allow-headers") ?? "")
      .split(",").map((entry) => entry.trim().toLowerCase());
    for (const header of ["apikey", "authorization", "content-type", "x-client-info"]) {
      expect(allowed, header).toContain(header);
    }
  });
});
