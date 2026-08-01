import { afterEach, describe, expect, it, vi } from "vitest";

import gateway from "../src/index";
import {
  ACCOUNT_ID,
  base64Url,
  canonical,
  gatewayEnv,
  OBJECT_KEY,
  ORGANIZATION_ID,
  png,
  runtimeTicket,
  sha256Hex,
  signedTicketHeader,
  ticketKeys,
} from "./fixtures";

const USER_ID = "dddd9000-0000-4000-8000-000000000001";
const SESSION_ID = "dddd9000-0000-4000-8000-000000000002";
const ISSUER = "https://project.supabase.co/auth/v1";

async function jwtKeys(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
}

async function signedJwt(
  privateKey: CryptoKey,
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({
    alg: "ES256",
    typ: "JWT",
    kid: "browser-key-1",
    ...headerOverrides,
  })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: USER_ID,
    session_id: SESSION_ID,
    aud: "authenticated",
    iss: ISSUER,
    iat: now - 1,
    nbf: now - 1,
    exp: now + 300,
    ...overrides,
  })));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(signature)}`;
}

type TestJwk = JsonWebKey & { kid: string; alg: string; use: string };

async function jwk(
  publicKey: CryptoKey,
  overrides: Record<string, unknown> = {},
): Promise<TestJwk> {
  return {
    ...await crypto.subtle.exportKey("jwk", publicKey) as JsonWebKey,
    kid: "browser-key-1",
    alg: "ES256",
    use: "sig",
    ...overrides,
  } as TestJwk;
}

async function browserReadFixture() {
  const mediaKeys = await ticketKeys();
  const browserKeys = await jwtKeys();
  const { env, r2 } = await gatewayEnv(mediaKeys);
  const bytes = png();
  await r2.bucket.put(OBJECT_KEY, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { sha256: await sha256Hex(bytes) },
  });
  return { mediaKeys, browserKeys, env, r2, bytes };
}

async function browserTicketHeader(
  mediaPrivateKey: CryptoKey,
  bytes: Uint8Array,
  token: string,
  overrides: Partial<import("../src/ticket").MediaTicketClaims> = {},
) {
  const base = await runtimeTicket(mediaPrivateKey, bytes, {
    subject: "BROWSER",
    operation: "GET",
    browserUserId: USER_ID,
    browserSessionIdSha256: await sha256Hex(SESSION_ID),
    browserAccessTokenSha256: await sha256Hex(token),
    ...overrides,
  });
  return await signedTicketHeader(base.claims, mediaPrivateKey);
}

function readRequest(ticket: string, token: string): Request {
  return new Request("https://openclaw-media.chillhome.io.vn/v1/object/read", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: "https://ptcrm.vercel.app",
      "x-openclaw-media-ticket": ticket,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("browser ticket JWT/JWKS proof", () => {
  it("returns security headers on the exact browser-read preflight", async () => {
    const fixture = await browserReadFixture();
    const response = await gateway.fetch(new Request(
      "https://openclaw-media.chillhome.io.vn/v1/object/read",
      { method: "OPTIONS", headers: { origin: "https://ptcrm.vercel.app" } },
    ), fixture.env);

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("verifies a pinned Supabase ES256 JWKS key and returns exact-origin CORS", async () => {
    const fixture = await browserReadFixture();
    const token = await signedJwt(fixture.browserKeys.privateKey);
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      keys: [await jwk(fixture.browserKeys.publicKey)],
    })));

    const response = await gateway.fetch(readRequest(ticket, token), fixture.env);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin"))
      .toBe("https://ptcrm.vercel.app");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("rejects an expired JWT and a refreshed access token before consuming the ticket", async () => {
    const fixture = await browserReadFixture();
    const expired = await signedJwt(fixture.browserKeys.privateKey, {
      exp: Math.floor(Date.now() / 1_000) - 1,
    });
    const live = await signedJwt(fixture.browserKeys.privateKey);
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      expired,
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      keys: [await jwk(fixture.browserKeys.publicKey)],
    })));

    expect((await gateway.fetch(readRequest(ticket, expired), fixture.env)).status).toBe(403);
    expect((await gateway.fetch(readRequest(ticket, live), fixture.env)).status).toBe(403);
  });

  it("enforces exact iat/nbf/exp/aud policy before requesting JWKS", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const invalidClaims = [
      { iat: undefined },
      { iat: now + 61 },
      { nbf: now + 61 },
      { iat: now, exp: now },
      { aud: ["authenticated"] },
    ];
    for (const claims of invalidClaims) {
      const fixture = await browserReadFixture();
      const token = await signedJwt(fixture.browserKeys.privateKey, claims);
      const ticket = await browserTicketHeader(
        fixture.mediaKeys.privateKey,
        fixture.bytes,
        token,
      );
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const response = await gateway.fetch(readRequest(ticket, token), fixture.env);

      expect(response.status, JSON.stringify(claims)).toBe(403);
      expect(fetch, JSON.stringify(claims)).not.toHaveBeenCalled();
    }
  });

  it("fails fast on missing or invalid pinned JWKS configuration without fetch or R2 access", async () => {
    for (const configuredUrl of [
      "",
      "not-a-url",
      "http://project.supabase.co/auth/v1/.well-known/jwks.json",
      "https://project.supabase.co/auth/v1/.well-known/jwks.json?redirect=1",
    ]) {
      const fixture = await browserReadFixture();
      fixture.env.OPENCLAW_SUPABASE_JWKS_URL = configuredUrl;
      const token = await signedJwt(fixture.browserKeys.privateKey);
      const ticket = await browserTicketHeader(
        fixture.mediaKeys.privateKey,
        fixture.bytes,
        token,
      );
      const fetch = vi.fn();
      const get = vi.spyOn(fixture.env.MEDIA, "get");
      vi.stubGlobal("fetch", fetch);

      expect((await gateway.fetch(readRequest(ticket, token), fixture.env)).status).toBe(403);
      expect(fetch).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("rejects HS256 browser JWTs without a symmetric-key downgrade or JWKS request", async () => {
    const fixture = await browserReadFixture();
    const token = await signedJwt(fixture.browserKeys.privateKey, {}, { alg: "HS256" });
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect((await gateway.fetch(readRequest(ticket, token), fixture.env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical Supabase session_id before requesting JWKS", async () => {
    const fixture = await browserReadFixture();
    const token = await signedJwt(fixture.browserKeys.privateKey, {
      session_id: "not-a-session-uuid",
    });
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
      { browserSessionIdSha256: await sha256Hex("not-a-session-uuid") },
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect((await gateway.fetch(readRequest(ticket, token), fixture.env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cheap ticket operation, TTL, and token-hash failures before requesting JWKS", async () => {
    const fixture = await browserReadFixture();
    const token = await signedJwt(fixture.browserKeys.privateKey);
    const otherToken = await signedJwt(fixture.browserKeys.privateKey, { jti: "different-token" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const wrongOperation = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
      { operation: "PUT" },
    );
    const overlong = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
      {
        iat: Math.floor(Date.now() / 1_000),
        exp: Math.floor(Date.now() / 1_000) + 61,
      },
    );
    const wrongTokenHash = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      otherToken,
    );

    for (const ticket of [wrongOperation, overlong, wrongTokenHash]) {
      expect((await gateway.fetch(readRequest(ticket, token), fixture.env)).status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a forged signature, wrong issuer, and a non-signing JWKS key", async () => {
    const cases = ["forged", "issuer", "key-use"] as const;
    for (const scenario of cases) {
      const fixture = await browserReadFixture();
      const attacker = await jwtKeys();
      const token = scenario === "issuer"
        ? await signedJwt(fixture.browserKeys.privateKey, { iss: "https://attacker.invalid/auth/v1" })
        : await signedJwt(
          scenario === "forged" ? attacker.privateKey : fixture.browserKeys.privateKey,
        );
      if (scenario === "key-use") {
        fixture.env.OPENCLAW_SUPABASE_JWKS_URL =
          "https://key-use.supabase.co/auth/v1/.well-known/jwks.json";
      }
      const effectiveToken = scenario === "key-use"
        ? await signedJwt(fixture.browserKeys.privateKey, { iss: "https://key-use.supabase.co/auth/v1" })
        : token;
      const ticket = await browserTicketHeader(
        fixture.mediaKeys.privateKey,
        fixture.bytes,
        effectiveToken,
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
        keys: [await jwk(fixture.browserKeys.publicKey, scenario === "key-use" ? { use: "enc" } : {})],
      })));

      const response = await gateway.fetch(readRequest(ticket, effectiveToken), fixture.env);
      expect(response.status, scenario).toBe(403);
    }
  });

  it("caches a pinned JWKS and refreshes once when a previously unknown kid appears", async () => {
    const fixture = await browserReadFixture();
    const rotated = await jwtKeys();
    const issuer = "https://cache-refresh.supabase.co/auth/v1";
    fixture.env.OPENCLAW_SUPABASE_JWKS_URL = `${issuer}/.well-known/jwks.json`;
    const firstToken = await signedJwt(fixture.browserKeys.privateKey, { iss: issuer });
    const rotatedToken = await signedJwt(
      rotated.privateKey,
      { iss: issuer },
      { kid: "browser-key-2" },
    );
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ keys: [await jwk(fixture.browserKeys.publicKey)] }))
      .mockResolvedValueOnce(Response.json({
        keys: [await jwk(rotated.publicKey, { kid: "browser-key-2" })],
      }));
    vi.stubGlobal("fetch", fetch);

    const firstTicket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      firstToken,
    );
    const cachedTicket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      firstToken,
    );
    const rotatedTicket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      rotatedToken,
    );

    expect((await gateway.fetch(readRequest(firstTicket, firstToken), fixture.env)).status).toBe(200);
    expect((await gateway.fetch(readRequest(cachedTicket, firstToken), fixture.env)).status).toBe(200);
    expect((await gateway.fetch(readRequest(rotatedTicket, rotatedToken), fixture.env)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires one unique kid with exact signing metadata", async () => {
    const cases = [
      { name: "duplicate kid", mutate: (key: TestJwk) => [key, { ...key }] },
      { name: "missing alg", mutate: (key: TestJwk) => [{ ...key, alg: undefined }] },
      { name: "missing use", mutate: (key: TestJwk) => [{ ...key, use: undefined }] },
      { name: "non-exact key_ops", mutate: (key: TestJwk) => [{ ...key, key_ops: ["verify", "sign"] }] },
      { name: "wrong kty", mutate: (key: TestJwk) => [{ ...key, kty: "RSA" }] },
      { name: "wrong crv", mutate: (key: TestJwk) => [{ ...key, crv: "P-384" }] },
      {
        name: "unexpected certificate metadata",
        mutate: (key: TestJwk) => [{ ...key, x5u: "https://attacker.invalid/key.pem" }],
      },
    ];
    for (const [index, scenario] of cases.entries()) {
      const fixture = await browserReadFixture();
      const issuer = `https://strict-${index}.supabase.co/auth/v1`;
      fixture.env.OPENCLAW_SUPABASE_JWKS_URL = `${issuer}/.well-known/jwks.json`;
      const token = await signedJwt(fixture.browserKeys.privateKey, { iss: issuer });
      const ticket = await browserTicketHeader(
        fixture.mediaKeys.privateKey,
        fixture.bytes,
        token,
      );
      const key = await jwk(fixture.browserKeys.publicKey);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ keys: scenario.mutate(key) })));

      expect(
        (await gateway.fetch(readRequest(ticket, token), fixture.env)).status,
        scenario.name,
      ).toBe(403);
    }
  });

  it("bounds JWKS responses and always installs a fetch timeout signal", async () => {
    const fixture = await browserReadFixture();
    const issuer = "https://bounded.supabase.co/auth/v1";
    fixture.env.OPENCLAW_SUPABASE_JWKS_URL = `${issuer}/.well-known/jwks.json`;
    const token = await signedJwt(fixture.browserKeys.privateKey, { iss: issuer });
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
    );
    const json = vi.fn().mockResolvedValue({ keys: [await jwk(fixture.browserKeys.publicKey)] });
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "70000" }),
      json,
    });
    vi.stubGlobal("fetch", fetch);

    expect((await gateway.fetch(readRequest(ticket, token), fixture.env)).status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      `${issuer}/.well-known/jwks.json`,
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("cancels a chunked JWKS body as soon as it crosses the byte limit", async () => {
    const fixture = await browserReadFixture();
    const issuer = "https://chunk-bounded.supabase.co/auth/v1";
    fixture.env.OPENCLAW_SUPABASE_JWKS_URL = `${issuer}/.well-known/jwks.json`;
    const token = await signedJwt(fixture.browserKeys.privateKey, { iss: issuer });
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
    );
    const cancel = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        if (chunk <= 3) controller.enqueue(new Uint8Array(32_768));
        else controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

    expect((await gateway.fetch(readRequest(ticket, token), fixture.env)).status).toBe(403);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign origin without requesting JWKS", async () => {
    const fixture = await browserReadFixture();
    const token = await signedJwt(fixture.browserKeys.privateKey);
    const ticket = await browserTicketHeader(
      fixture.mediaKeys.privateKey,
      fixture.bytes,
      token,
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const request = readRequest(ticket, token);
    request.headers.set("origin", "https://attacker.invalid");

    const response = await gateway.fetch(request, fixture.env);

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});
