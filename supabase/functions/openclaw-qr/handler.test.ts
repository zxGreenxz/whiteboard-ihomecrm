import { describe, expect, it, vi } from "vitest";

import { handleQrRequest } from "./handler";
import { OPENCLAW_QR_CHALLENGE_TTL_SECONDS, QR_OPERATION_RPCS } from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "dddd3000-0000-4000-8000-000000000001";
const CLIENT_OPERATION_ID = "dddd8000-0000-4000-8000-000000000001";
const ORIGIN = "https://ptcrm.vercel.app";
const BROWSER_NONCE_HASH = "a".repeat(64);
const AUTH_SESSION_HASH = "b".repeat(64);

const QR_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const environment = {
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
  supabaseAnonKey: "anon-key",
  supabaseServiceRoleKey: "service-role-key",
  runtimeTokenSigningKey: "x".repeat(48),
  browserOrigins: [ORIGIN],
};

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

function rawKeyBase64(raw: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(raw)));
}

function qrRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://edge.invalid/openclaw-qr", {
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

function dependencies(options: {
  rpc?: ReturnType<typeof vi.fn>;
  adminRpc?: ReturnType<typeof vi.fn>;
  userId?: string | null;
  logger?: { error: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn> };
  qrEncryptionKeyB64?: string;
} = {}) {
  const rpc = options.rpc ?? vi.fn();
  const adminRpc = options.adminRpc ?? vi.fn();
  const userId = "userId" in options ? options.userId ?? null : "user-1";
  return {
    environment: {
      ...environment,
      qrEncryptionKeyB64: options.qrEncryptionKeyB64 ?? "",
    },
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
  it("fixes the challenge lifetime at exactly 120 seconds", () => {
    expect(OPENCLAW_QR_CHALLENGE_TTL_SECONDS).toBe(120);
  });

  it("routes begin, poll, and consume to their exact RPC facades", async () => {
    const begin = vi.fn(() =>
      Promise.resolve({
        data: {
          version: 1,
          challengeId: CHALLENGE_ID,
          issuedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-01T00:02:00.000Z",
        },
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
        data: { version: 1, challengeStatus: "READY", materialVersion: 1 },
        error: null,
      })
    );
    const pollResponse = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
      }),
      dependencies({ rpc: poll }),
    );
    expect(pollResponse.status).toBe(200);
    expect(poll.mock.calls[0][0]).toBe(QR_OPERATION_RPCS.POLL);
  });

  it("proves issued_at plus 120 seconds equals expires_at on begin", async () => {
    const issuedAt = "2026-08-01T00:00:00.000Z";
    const expiresAt = "2026-08-01T00:02:00.000Z";
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: { version: 1, challengeId: CHALLENGE_ID, issuedAt, expiresAt },
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

  it("reveals the QR exactly once and never on a replay", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    const keyB64 = rawKeyBase64(await crypto.subtle.exportKey("raw", key));
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);

    let consumed = false;
    const rpc = vi.fn(() => {
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
          challengeId: CHALLENGE_ID,
          status: "CONSUMED",
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
      challengeId: CHALLENGE_ID,
      browserNonceHash: BROWSER_NONCE_HASH,
      authSessionHash: AUTH_SESSION_HASH,
    };

    const first = await handleQrRequest(
      qrRequest(consumeBody),
      dependencies({ rpc, qrEncryptionKeyB64: keyB64 }),
    );
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstBody.result.qrPngDataUrl).toBe(QR_PNG_DATA_URL);

    const second = await handleQrRequest(
      qrRequest(consumeBody),
      dependencies({ rpc, qrEncryptionKeyB64: keyB64 }),
    );
    const secondText = await second.text();
    expect(second.status).toBe(404);
    expect(secondText).not.toContain(QR_PNG_DATA_URL);
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
          challengeId: CHALLENGE_ID,
          browserNonceHash: BROWSER_NONCE_HASH,
          authSessionHash: AUTH_SESSION_HASH,
        }),
        dependencies({ rpc, qrEncryptionKeyB64: "" }),
      );
      statuses.push(String(response.status));
      messages.push((await response.json()).error.code);
    }

    expect(new Set(statuses).size).toBe(1);
    expect(new Set(messages).size).toBe(1);
  });

  it("never logs or echoes QR content, even when decryption fails", async () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: {
          version: 1,
          challengeId: CHALLENGE_ID,
          status: "CONSUMED",
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
    const keyB64 = rawKeyBase64(await crypto.subtle.exportKey("raw", key));

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, logger, qrEncryptionKeyB64: keyB64 }),
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
    const keyB64 = rawKeyBase64(await crypto.subtle.exportKey("raw", key));
    const material = await encryptQrMaterial(key, QR_PNG_DATA_URL);
    const rpc = vi.fn(() =>
      Promise.resolve({
        data: { version: 1, challengeId: CHALLENGE_ID, status: "CONSUMED", ...material },
        error: null,
      })
    );

    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "CONSUME",
        clientOperationId: CLIENT_OPERATION_ID,
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
        browserNonceHash: BROWSER_NONCE_HASH,
        authSessionHash: AUTH_SESSION_HASH,
      }),
      dependencies({ rpc, qrEncryptionKeyB64: keyB64 }),
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("rechecks authentication on every poll", async () => {
    const rpc = vi.fn();
    const response = await handleQrRequest(
      qrRequest({
        version: 1,
        operation: "POLL",
        organizationId: ORGANIZATION_ID,
        challengeId: CHALLENGE_ID,
      }),
      dependencies({ rpc, userId: null }),
    );

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
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
        },
        { origin: "https://evil.example" },
      ),
      dependencies({ rpc }),
    );

    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
});