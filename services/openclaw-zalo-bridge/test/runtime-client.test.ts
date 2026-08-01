import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createChannelRuntimeClient,
  RuntimeApiError,
} from "../src/runtime-api/client.js";
import { canonicalJson } from "../src/spool/checksum.js";
import { runtimeTokenRequestSchema } from "../../../supabase/functions/openclaw-runtime-token/schemas.ts";

const ORGANIZATION_ID = "dddd0000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "dddd1000-0000-4000-8000-000000000001";
const CELL_ID = "dddd2000-0000-4000-8000-000000000001";
const NONCES = [
  "dddd7000-0000-4000-8000-000000000001",
  "dddd7000-0000-4000-8000-000000000002",
  "dddd7000-0000-4000-8000-000000000003",
  "dddd7000-0000-4000-8000-000000000004",
];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("channel runtime API client", () => {
  it("emits the exact channel exchange accepted by the frozen Edge schema", async () => {
    let exchangeBody: unknown;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/openclaw-runtime-token")) {
        exchangeBody = JSON.parse(String(init?.body));
        return json({ version: 1, result: { version: 1, token: "runtime-token", expiresInSeconds: 30 } });
      }
      return json({ version: 1, result: { version: 1 } });
    });
    const nonces = [...NONCES];
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => nonces.shift()!,
    });

    await client.post("/v1/heartbeat", { version: 1 });

    expect(runtimeTokenRequestSchema.safeParse(exchangeBody)).toMatchObject({ success: true });
    expect(exchangeBody).not.toHaveProperty("fencingToken");
  });

  it("aborts a token exchange that exceeds the configured request deadline", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      timeoutMs: 100,
      nonce: () => crypto.randomUUID(),
    });

    await expect(client.post("/v1/heartbeat", { version: 1 }))
      .rejects.toMatchObject({ stage: "TOKEN_EXCHANGE", status: null });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("uses an adopted local session generation on the next token exchange", async () => {
    const tokenRequests: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/openclaw-runtime-token")) {
        tokenRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ version: 1, result: { version: 1, token: "runtime-token", expiresInSeconds: 30 } });
      }
      return json({ version: 1, result: { version: 1 } });
    });
    const nonces = [...NONCES];
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => nonces.shift()!,
    });

    expect(client.localSessionGeneration()).toBe(5);
    client.adoptSessionGeneration(6);
    expect(client.localSessionGeneration()).toBe(6);
    await client.post("/v1/heartbeat", { version: 1 });

    expect(tokenRequests[0]).toMatchObject({ localSessionGeneration: 6 });
    expect(tokenRequests[0]).not.toHaveProperty("sessionGeneration");
  });

  it("aborts active Runtime requests and rejects new work when closed", async () => {
    let requestCount = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) {
        return json({
          version: 1,
          requestId: "token-request",
          result: { version: 1, token: "short-lived-token", expiresInSeconds: 300 },
        });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      timeoutMs: 30_000,
      nonce: () => crypto.randomUUID(),
    });

    const active = client.post("/v1/heartbeat", { version: 1 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await client.close();

    await expect(active).rejects.toMatchObject({ stage: "RUNTIME_REQUEST", status: null });
    await expect(client.post("/v1/heartbeat", { version: 1 }))
      .rejects.toThrow(/closed/i);
  });

  it("exchanges the root credential for a request-bound token and sends the exact bytes", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/openclaw-runtime-token")) {
        return json({
          version: 1,
          requestId: "token-request",
          result: { version: 1, token: "short-lived-token", expiresInSeconds: 300 },
        });
      }
      return json({
        version: 1,
        requestId: "runtime-request",
        result: { version: 1, items: [] },
      });
    });
    let nonceIndex = 0;
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1/",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => NONCES[nonceIndex++]!,
    });

    const body = { version: 1, claimToken: "claim-1", limit: 1, leaseSeconds: 30 };
    const result = await client.post("/v1/outbox/claim", body);

    expect(result).toEqual({ version: 1, items: [] });
    expect(requests).toHaveLength(2);
    const runtimeBytes = canonicalJson(body);
    const tokenBody = JSON.parse(String(requests[0]!.init.body));
    expect(tokenBody).toEqual({
      version: 1,
      principalKind: "CHANNEL",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      localSessionGeneration: 5,
      runtimeMethod: "POST",
      runtimePath: "/v1/outbox/claim",
      runtimeTimestamp: 1_785_062_400,
      runtimeNonce: NONCES[0],
      runtimeBodySha256: createHash("sha256").update(runtimeBytes).digest("hex"),
      exchangeNonce: NONCES[1],
    });
    expect(new Headers(requests[0]!.init.headers).get("x-openclaw-credential"))
      .toBe("root-credential-value-that-is-long-enough");
    expect(requests[1]!.init.body).toBe(runtimeBytes);
    expect(new Headers(requests[1]!.init.headers)).toMatchObject({});
    expect(new Headers(requests[1]!.init.headers).get("authorization"))
      .toBe("Bearer short-lived-token");
    expect(new Headers(requests[1]!.init.headers).get("x-openclaw-nonce")).toBe(NONCES[0]);
    expect(new Headers(requests[1]!.init.headers).get("x-openclaw-timestamp"))
      .toBe("1785062400");
    expect(requests.map(({ init }) => init.redirect)).toEqual(["error", "error"]);
  });

  it("rejects a streamed Runtime response that exceeds its route byte cap", async () => {
    let requestCount = 0;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return json({
          version: 1,
          requestId: "token-request",
          result: { version: 1, token: "short-lived-token", expiresInSeconds: 300 },
        });
      }
      const oversized = JSON.stringify({ version: 1, result: { value: "x".repeat(600 * 1024) } });
      return new Response(oversized, { headers: { "content-type": "application/json" } });
    });
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      nonce: () => crypto.randomUUID(),
    });

    await expect(client.post("/v1/work/context", { version: 1 }))
      .rejects.toThrow(/byte cap|too large/i);
  });

  it("aborts while consuming a Runtime JSON stream that never completes", async () => {
    let requestCount = 0;
    const fetch = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return json({
          version: 1,
          requestId: "token-request",
          result: { version: 1, token: "short-lived-token", expiresInSeconds: 300 },
        });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"version":1,"result":'));
        },
      }), { headers: { "content-type": "application/json" } });
    });
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      timeoutMs: 100,
      nonce: () => crypto.randomUUID(),
    });

    await expect(client.post("/v1/heartbeat", { version: 1 }))
      .rejects.toMatchObject({ stage: "RUNTIME_REQUEST", status: null });
  }, 2_000);

  it("uses fresh runtime and exchange nonces for every request", async () => {
    const tokenRequests: unknown[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/openclaw-runtime-token")) {
        tokenRequests.push(JSON.parse(String(init?.body)));
        return json({
          version: 1,
          requestId: "token-request",
          result: { version: 1, token: "token", expiresInSeconds: 300 },
        });
      }
      return json({ version: 1, requestId: "runtime-request", result: { version: 1 } });
    });
    let nonceIndex = 0;
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => NONCES[nonceIndex++]!,
    });

    await client.post("/v1/heartbeat", { version: 1 });
    await client.post("/v1/heartbeat", { version: 1 });

    expect(tokenRequests).toMatchObject([
      { runtimeNonce: NONCES[0], exchangeNonce: NONCES[1] },
      { runtimeNonce: NONCES[2], exchangeNonce: NONCES[3] },
    ]);
  });

  it("fails locally if a nonce generator reuses a prior request nonce", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/openclaw-runtime-token")) {
        return json({ version: 1, requestId: "token", result: {
          version: 1,
          token: "short-lived-token",
          expiresInSeconds: 300,
        } });
      }
      return json({ version: 1, requestId: "runtime", result: { version: 1 } });
    });
    const repeated = [NONCES[0]!, NONCES[1]!, NONCES[0]!, NONCES[2]!];
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => repeated.shift()!,
    });

    await client.post("/v1/heartbeat", { version: 1 });
    await expect(client.post("/v1/heartbeat", { version: 1 }))
      .rejects.toThrow(/nonce/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("redacts credentials, tokens, and response bodies from errors", async () => {
    const credential = "root-credential-value-that-is-long-enough";
    const fetch = vi.fn(async () => json({ secret: credential, token: "leaked-token" }, 403));
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential,
      fetch,
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => NONCES.shift() ?? crypto.randomUUID(),
    });

    const error = await client.post("/v1/heartbeat", { version: 1 }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RuntimeApiError);
    expect(String(error)).not.toContain(credential);
    expect(String(error)).not.toContain("leaked-token");
    expect(error).toMatchObject({ stage: "TOKEN_EXCHANGE", status: 403 });
  });

  it("rejects maintenance and unknown routes before exchanging a token", async () => {
    const fetch = vi.fn();
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch,
    });

    await expect(client.post("/v1/maintenance/work/claim", { version: 1 }))
      .rejects.toThrow(/runtime path/i);
    await expect(client.post("/v1/not-a-route", { version: 1 }))
      .rejects.toThrow(/runtime path/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a token exchange result above the five-minute ceiling", async () => {
    const client = createChannelRuntimeClient({
      functionsBaseUrl: "https://project.supabase.co/functions/v1",
      organizationId: ORGANIZATION_ID,
      accountId: ACCOUNT_ID,
      cellId: CELL_ID,
      sessionGeneration: 5,
      fencingToken: 7,
      credential: "root-credential-value-that-is-long-enough",
      fetch: vi.fn(async () => json({
        version: 1,
        requestId: "token-request",
        result: { version: 1, token: "short-lived-token", expiresInSeconds: 301 },
      })),
      nowEpochSeconds: () => 1_785_062_400,
      nonce: () => NONCES.shift() ?? crypto.randomUUID(),
    });

    await expect(client.post("/v1/heartbeat", { version: 1 }))
      .rejects.toMatchObject({ stage: "TOKEN_EXCHANGE" });
  });
});
