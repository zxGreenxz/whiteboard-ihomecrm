import { describe, expect, it, vi } from "vitest";

import { handleObjectTicketRequest, OBJECT_TICKET_TTL_SECONDS } from "./handler";
import * as objectTicketHandlerModule from "./handler";
import { objectTicketRequestSchema } from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "dddd4000-0000-4000-8000-000000000001";
const MESSAGE_ID = "dddd5000-0000-4000-8000-000000000001";
const MEDIA_ID = "dddd6000-0000-4000-8000-000000000001";
const USER_ID = "dddd9000-0000-4000-8000-000000000001";
const SESSION_ID = "dddd9000-0000-4000-8000-000000000002";
const ORIGIN = "https://ptcrm.vercel.app";
const OBJECT_KEY =
  `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
  `/conversation/${CONVERSATION_ID}` +
  `/message/${MESSAGE_ID}` +
  `/media/${MEDIA_ID}/original`;

function jwt(sessionId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${encode({ alg: "HS256" })}.${encode({ sub: USER_ID, session_id: sessionId })}.sig`;
}

const environment = {
  supabaseUrl: "https://tryymsxyyckgbrmmvozx.supabase.co",
  supabaseAnonKey: "anon",
  supabaseServiceRoleKey: "service",
  runtimeTokenSigningKey: "x".repeat(48),
  browserOrigins: [ORIGIN],
};

function ticketRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://edge.invalid/openclaw-object-tickets", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt(SESSION_ID)}`,
      origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function dependencies(options: {
  rpc?: ReturnType<typeof vi.fn>;
  userId?: string | null;
  logger?: { error: ReturnType<typeof vi.fn> };
  gatewayKeyGeneration?: number;
} = {}) {
  const rpc = options.rpc ?? vi.fn(() =>
    Promise.resolve({
      data: {
        version: 1,
        mediaId: MEDIA_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        objectKey: OBJECT_KEY,
        mime: "image/png",
        byteLength: 128,
        sha256: "a".repeat(64),
        byteState: "AVAILABLE",
        sessionGeneration: 5,
      },
      error: null,
    })
  );
  const userId = "userId" in options ? options.userId ?? null : USER_ID;
  return {
    environment,
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
    signTicket: vi.fn(() => Promise.resolve("s".repeat(86))),
    gatewayKeyGeneration: options.gatewayKeyGeneration ?? 7,
    logger: options.logger ?? { error: vi.fn() },
    requestIdFactory: () => "dddd9000-0000-4000-8000-000000000001",
    jtiFactory: () => "dddd7000-0000-4000-8000-000000000001",
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    rpc,
  };
}

describe("OpenClaw object ticket request schema", () => {
  it("accepts only a canonical media row reference", () => {
    expect(
      objectTicketRequestSchema.safeParse({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }).success,
    ).toBe(true);
  });

  it("never accepts a bucket name or an arbitrary object key", () => {
    for (const extra of [
      { objectKey: OBJECT_KEY },
      { bucket: "ihome-openclaw-media-private" },
      { path: "../secret" },
      { key: "anything" },
    ]) {
      expect(
        objectTicketRequestSchema.safeParse({
          version: 1,
          operation: "GET",
          organizationId: ORGANIZATION_ID,
          mediaId: MEDIA_ID,
          ...extra,
        }).success,
      ).toBe(false);
    }
  });

  it("rejects every browser operation except GET because the resolver is view-only", () => {
    for (const operation of ["PUT", "DELETE", "ANCHOR", "LIST", ""]) {
      expect(
        objectTicketRequestSchema.safeParse({
          version: 1,
          operation,
          organizationId: ORGANIZATION_ID,
          mediaId: MEDIA_ID,
        }).success,
      ).toBe(false);
    }
  });
});

describe("OpenClaw object ticket issuance", () => {
  it("imports ticket key bytes through a wipe-on-completion process-wiring helper", async () => {
    const importSigningKey = (objectTicketHandlerModule as {
      importObjectTicketSigningKey?: (encodedKey: string) => Promise<CryptoKey>;
    }).importObjectTicketSigningKey;

    expect(importSigningKey).toBeTypeOf("function");
    if (!importSigningKey) return;
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const keyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    let importedBytes: Uint8Array | null = null;
    const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle);
    const importKey = vi.spyOn(crypto.subtle, "importKey").mockImplementation(
      (format, keyData, algorithm, extractable, keyUsages) => {
        if (format === "pkcs8" && keyData instanceof ArrayBuffer) {
          importedBytes = new Uint8Array(keyData);
        }
        return originalImportKey(format, keyData, algorithm, extractable, keyUsages);
      },
    );

    await expect(importSigningKey(Buffer.from(keyBytes).toString("base64"))).resolves.toBeDefined();
    expect(importedBytes).not.toBeNull();
    expect(importedBytes?.every((byte) => byte === 0)).toBe(true);
    importKey.mockRestore();
  });

  it("issues a ticket bound to the exact key, user, session, and token", async () => {
    const dependency = dependencies();
    const response = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependency,
    );
    const body = await response.json();
    const ticket = body.result.ticket;

    expect(response.status).toBe(200);
    expect(ticket.objectKey).toBe(OBJECT_KEY);
    expect(ticket.aud).toBe("openclaw-media-gateway");
    expect(ticket.subject).toBe("BROWSER");
    expect(ticket.browserUserId).toBe(USER_ID);
    expect(ticket.browserSessionIdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket.browserAccessTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket.sessionGeneration).toBe(5);
    expect(ticket.gatewayKeyGeneration).toBe(7);
    expect(ticket.exp - ticket.iat).toBe(OBJECT_TICKET_TTL_SECONDS);
    expect(ticket.exp - ticket.iat).toBeLessThanOrEqual(60);
  });

  it("fails closed instead of signing incomplete or cross-row trusted results", async () => {
    const valid = {
      version: 1,
      mediaId: MEDIA_ID,
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      objectKey: OBJECT_KEY,
      mime: "image/png",
      byteLength: 128,
      sha256: "a".repeat(64),
      byteState: "AVAILABLE",
      sessionGeneration: 5,
    };
    const invalidRows = [
      { ...valid, mediaId: "dddd6000-0000-4000-8000-000000000002" },
      { ...valid, organizationId: "dddd0000-0000-4000-8000-000000000002" },
      { ...valid, conversationId: "dddd4000-0000-4000-8000-000000000002" },
      { ...valid, messageId: "dddd5000-0000-4000-8000-000000000002" },
      {
        ...valid,
        objectKey: OBJECT_KEY.replace(
          MEDIA_ID,
          "dddd6000-0000-4000-8000-000000000002",
        ),
      },
      { ...valid, sessionGeneration: undefined },
      { ...valid, byteLength: 0 },
      { ...valid, mime: "" },
      { ...valid, sha256: "not-a-sha256" },
      { ...valid, byteState: "QUARANTINED" },
      { ...valid, objectKey: OBJECT_KEY.replace(/original$/, "arbitrary") },
      { ...valid, unexpectedTrustedField: true },
    ];

    for (const row of invalidRows) {
      const dependency = dependencies({
        rpc: vi.fn(() => Promise.resolve({ data: row, error: null })),
      });
      const response = await handleObjectTicketRequest(
        ticketRequest({
          version: 1,
          operation: "GET",
          organizationId: ORGANIZATION_ID,
          mediaId: MEDIA_ID,
        }),
        dependency,
      );

      expect(response.status, JSON.stringify(row)).toBe(404);
      expect(dependency.signTicket, JSON.stringify(row)).not.toHaveBeenCalled();
    }
  });

  it("rejects an invalid configured ticket key generation before signing", async () => {
    const dependency = dependencies({ gatewayKeyGeneration: 0 });
    const response = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependency,
    );

    expect(response.status).toBe(500);
    expect(dependency.signTicket).not.toHaveBeenCalled();
  });

  it("rejects browser PUT before calling the view-only resolver", async () => {
    const dependency = dependencies();
    const response = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "PUT",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependency,
    );

    expect(response.status).toBe(400);
    expect(dependency.rpc).not.toHaveBeenCalled();
    expect(dependency.signTicket).not.toHaveBeenCalled();
  });

  it("binds a different token to a different hash", async () => {
    const first = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependencies(),
    );
    const second = await handleObjectTicketRequest(
      ticketRequest(
        { version: 1, operation: "GET", organizationId: ORGANIZATION_ID, mediaId: MEDIA_ID },
        { authorization: `Bearer ${jwt("dddd9000-0000-4000-8000-000000000003")}` },
      ),
      dependencies(),
    );

    const firstTicket = (await first.json()).result.ticket;
    const secondTicket = (await second.json()).result.ticket;
    expect(firstTicket.browserSessionIdSha256).not.toBe(secondTicket.browserSessionIdSha256);
    expect(firstTicket.browserAccessTokenSha256).not.toBe(secondTicket.browserAccessTokenSha256);
  });

  it("refuses to issue once the media row is quarantined or missing", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { code: "P0002", message: "not available" } })
    );
    const response = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependencies({ rpc }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("MEDIA_NOT_AVAILABLE");
  });

  it("gives the same answer for missing, forbidden, and quarantined media", async () => {
    const codes = new Set<string>();
    for (const error of [
      { code: "P0002", message: "not found" },
      { code: "42501", message: "permission denied" },
      { code: "P0001", message: "quarantined" },
    ]) {
      const response = await handleObjectTicketRequest(
        ticketRequest({
          version: 1,
          operation: "GET",
          organizationId: ORGANIZATION_ID,
          mediaId: MEDIA_ID,
        }),
        dependencies({ rpc: vi.fn(() => Promise.resolve({ data: null, error })) }),
      );
      codes.add(`${response.status}:${(await response.json()).error.code}`);
    }

    expect(codes.size).toBe(1);
  });

  it("requires browser authentication and an allowlisted origin", async () => {
    const unauthenticated = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependencies({ userId: null }),
    );
    expect(unauthenticated.status).toBe(401);

    const foreignOrigin = await handleObjectTicketRequest(
      ticketRequest(
        { version: 1, operation: "GET", organizationId: ORGANIZATION_ID, mediaId: MEDIA_ID },
        { origin: "https://evil.example" },
      ),
      dependencies(),
    );
    expect(foreignOrigin.status).toBe(403);
  });

  it("rejects a non-canonical Supabase session_id before signing", async () => {
    const dependency = dependencies();
    const response = await handleObjectTicketRequest(
      ticketRequest(
        { version: 1, operation: "GET", organizationId: ORGANIZATION_ID, mediaId: MEDIA_ID },
        { authorization: `Bearer ${jwt("not-a-session-uuid")}` },
      ),
      dependency,
    );

    expect(response.status).toBe(401);
    expect(dependency.signTicket).not.toHaveBeenCalled();
  });

  it("never echoes the access token into the response body", async () => {
    const response = await handleObjectTicketRequest(
      ticketRequest({
        version: 1,
        operation: "GET",
        organizationId: ORGANIZATION_ID,
        mediaId: MEDIA_ID,
      }),
      dependencies(),
    );
    const raw = await response.text();

    expect(raw).not.toContain(jwt(SESSION_ID));
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
