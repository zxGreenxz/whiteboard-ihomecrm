import { describe, expect, it, vi } from "vitest";

import { handleObjectTicketRequest, OBJECT_TICKET_TTL_SECONDS } from "./handler";
import { objectTicketRequestSchema } from "./schemas";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const MEDIA_ID = "dddd6000-0000-4000-8000-000000000001";
const ORIGIN = "https://ptcrm.vercel.app";
const OBJECT_KEY =
  `v1/org/${ORGANIZATION_ID}/account/${ACCOUNT_ID}` +
  "/conversation/dddd4000-0000-4000-8000-000000000001" +
  "/message/dddd5000-0000-4000-8000-000000000001" +
  `/media/${MEDIA_ID}/original`;

function jwt(sessionId: string): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${encode({ alg: "HS256" })}.${encode({ sub: "user-1", session_id: sessionId })}.sig`;
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
      authorization: `Bearer ${jwt("session-1")}`,
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
} = {}) {
  const rpc = options.rpc ?? vi.fn(() =>
    Promise.resolve({
      data: {
        version: 1,
        mediaId: MEDIA_ID,
        organizationId: ORGANIZATION_ID,
        accountId: ACCOUNT_ID,
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
  const userId = "userId" in options ? options.userId ?? null : "user-1";
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

  it("rejects an operation outside GET and PUT", () => {
    for (const operation of ["DELETE", "ANCHOR", "LIST", ""]) {
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
    expect(ticket.browserUserId).toBe("user-1");
    expect(ticket.browserSessionIdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket.browserAccessTokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ticket.sessionGeneration).toBe(5);
    expect(ticket.exp - ticket.iat).toBe(OBJECT_TICKET_TTL_SECONDS);
    expect(ticket.exp - ticket.iat).toBeLessThanOrEqual(60);
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
        { authorization: `Bearer ${jwt("session-2")}` },
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

    expect(raw).not.toContain(jwt("session-1"));
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});