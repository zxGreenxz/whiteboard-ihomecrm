import { afterEach, describe, expect, it, vi } from "vitest";

import gateway from "../src/index";
import { gatewayEnv, ticketKeys } from "./fixtures";

const healthRequest = () => new Request(
  "https://openclaw-media.chillhome.io.vn/health",
  { method: "GET" },
);

async function usableJwks(publicKey: CryptoKey): Promise<Response> {
  return Response.json({
    keys: [{
      ...await crypto.subtle.exportKey("jwk", publicKey) as JsonWebKey,
      alg: "ES256",
      kid: "health-key-1",
      use: "sig",
    }],
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("gateway health configuration", () => {
  it("reports ready only when every required binding and pinned key is valid", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await usableJwks(keys.publicKey)));

    const healthy = await gateway.fetch(healthRequest(), fixture.env);

    expect(healthy.status).toBe(200);
    expect(await healthy.json()).toEqual({ status: "ok" });
  });

  it("fails readiness when the pinned JWKS has no usable signing key", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ keys: [] })));

    const response = await gateway.fetch(healthRequest(), fixture.env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("fails readiness when a well-shaped ES256 JWK has an invalid curve point", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    const invalidCoordinate = Buffer.alloc(32).toString("base64url");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      keys: [{
        alg: "ES256",
        crv: "P-256",
        ext: true,
        key_ops: ["verify"],
        kid: "invalid-point",
        kty: "EC",
        use: "sig",
        x: invalidCoordinate,
        y: invalidCoordinate,
      }],
    })));

    const response = await gateway.fetch(healthRequest(), fixture.env);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it.each([0, 1])(
    "fails readiness when historical ticket key entry %i cannot be imported",
    async (invalidIndex) => {
      const keys = await ticketKeys();
      const fixture = await gatewayEnv(keys);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await usableJwks(keys.publicKey)));
      fixture.env.OPENCLAW_TICKET_RECOVERY_KEYRING_JSON = JSON.stringify([2, 3].map(
        (generation, index) => ({
          generation,
          publicKeyB64: index === invalidIndex
            ? "not-base64"
            : fixture.env.OPENCLAW_TICKET_PUBLIC_KEY_B64,
          notBeforeEpochSeconds: 0,
          notAfterEpochSeconds: 4102444800,
          emergencyRevoked: false,
        }),
      ));

      const response = await gateway.fetch(healthRequest(), fixture.env);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    },
  );

  it.each([0, 1])(
    "fails readiness when historical receipt signer entry %i cannot be imported",
    async (invalidIndex) => {
      const keys = await ticketKeys();
      const fixture = await gatewayEnv(keys);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await usableJwks(keys.publicKey)));
      fixture.env.OPENCLAW_RECEIPT_RECOVERY_KEYRING_JSON = JSON.stringify([2, 3].map(
        (generation, index) => ({
          generation,
          privateKeyB64: index === invalidIndex
            ? "not-base64"
            : fixture.env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64,
          publicKeySha256: fixture.env.OPENCLAW_RECEIPT_PUBLIC_KEY_SHA256,
          notBeforeEpochSeconds: 0,
          notAfterEpochSeconds: 4102444800,
          emergencyRevoked: false,
        }),
      ));

      const response = await gateway.fetch(healthRequest(), fixture.env);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    },
  );

  it.each([
    [10, 10],
    [11, 10],
  ])(
    "fails readiness for an unusable historical audit lifecycle %i..%i",
    async (notBeforeEpochSeconds, notAfterEpochSeconds) => {
      const keys = await ticketKeys();
      const fixture = await gatewayEnv(keys);
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await usableJwks(keys.publicKey)));
      fixture.env.OPENCLAW_AUDIT_RECOVERY_KEYRING_JSON = JSON.stringify([{
        generation: 8,
        publicKeyB64: fixture.env.OPENCLAW_AUDIT_PUBLIC_KEY_B64,
        publicKeySha256: fixture.env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256,
        notBeforeEpochSeconds,
        notAfterEpochSeconds,
        emergencyRevoked: false,
      }]);

      const response = await gateway.fetch(healthRequest(), fixture.env);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    },
  );

  it("probes the actual R2 and Durable Object bindings without mutation", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await usableJwks(keys.publicKey)));
    const head = vi.spyOn(fixture.env.MEDIA, "head");
    const get = vi.spyOn(fixture.env.TICKET_STATE, "get");

    const response = await gateway.fetch(healthRequest(), fixture.env);

    expect(response.status).toBe(200);
    expect(head).toHaveBeenCalledWith("__openclaw_health_sentinel__");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails readiness when a configured binding cannot be reached", async () => {
    const keys = await ticketKeys();
    const fixture = await gatewayEnv(keys);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(await usableJwks(keys.publicKey)));
    fixture.env.MEDIA.head = vi.fn().mockRejectedValue(new Error("R2 unavailable"));

    const response = await gateway.fetch(healthRequest(), fixture.env);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"unavailable"}');
  });

  it("fails closed without leaking the invalid binding, URL, or key material", async () => {
    const cases: Array<(env: Record<string, unknown>) => string> = [
      (env) => String(delete env.MEDIA),
      (env) => String(delete env.TICKET_STATE),
      (env) => String(env.OPENCLAW_BROWSER_ORIGINS = "http://insecure.invalid"),
      (env) => String(env.OPENCLAW_SUPABASE_JWKS_URL = "not-a-url"),
      (env) => String(env.OPENCLAW_TICKET_KEY_GENERATION = "0"),
      (env) => String(env.OPENCLAW_TICKET_PUBLIC_KEY_B64 = "secret-ticket-key"),
      (env) => String(env.OPENCLAW_REVOCATION_PUBLIC_KEY_B64 = "secret-revocation-key"),
      (env) => String(env.OPENCLAW_RECEIPT_PRIVATE_KEY_B64 = "secret-receipt-key"),
      (env) => String(env.OPENCLAW_AUDIT_PUBLIC_KEY_SHA256 = "a".repeat(64)),
    ];

    for (const mutate of cases) {
      const keys = await ticketKeys();
      const fixture = await gatewayEnv(keys);
      const marker = mutate(fixture.env as unknown as Record<string, unknown>);

      const response = await gateway.fetch(healthRequest(), fixture.env);
      const body = await response.text();

      expect(response.status).toBe(503);
      expect(body).toBe('{"status":"unavailable"}');
      expect(body).not.toContain(marker);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
