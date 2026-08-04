import { describe, expect, it } from "vitest";

import { ApiClientError, NetworkCenterApiClient } from "../src/apiClient.js";

const baseClaim = {
  commandId: "50000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  buildingId: "30000000-0000-4000-8000-000000000001",
  deviceId: "40000000-0000-4000-8000-000000000001",
  interfaceId: null,
  actionType: "FLUSH_DNS_CACHE",
  reason: "Kiểm tra DNS",
  parameters: {},
  attemptNo: 1,
  leaseToken: "60000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-07-30T00:02:00.000Z",
  reconciliation: false,
  intentType: "FLUSH_DNS_CACHE",
  managedTarget: { deviceId: "40000000-0000-4000-8000-000000000001" },
  preObservation: null,
  expectedPostcondition: { kind: "DNS_COMMAND_ACK" },
  observationDeadline: "2026-07-30T00:05:00.000Z",
  transitionVersion: 7,
  fencingGeneration: 11,
};

describe("worker Edge API client", () => {
  it("authenticates through the dedicated header and unwraps safe data", async () => {
    const requests: Request[] = [];
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/functions/v1/network-center-worker"),
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true, data: { items: [] } });
      },
    });

    await expect(client.listConnections(100)).resolves.toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://example.test/functions/v1/network-center-worker/connections",
    );
    expect(requests[0]!.headers.get("x-network-worker-secret")).toBe("s".repeat(48));
    const body = await requests[0]!.json();
    expect(body).toEqual({ limit: 100 });
    expect(body).not.toHaveProperty("workerId");
  });

  it("classifies transient responses without leaking response bodies or secrets", async () => {
    const secret = "secret-that-must-not-leak".repeat(2);
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret,
      timeoutMs: 1_000,
      fetch: async () => new Response(`password=router ${secret}`, { status: 503 }),
    });

    const error = await client.claimCommands(3, 90).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ retryable: true, status: 503 });
    expect(String((error as Error).message)).not.toContain("router");
    expect(String((error as Error).message)).not.toContain(secret);
    // A body that is not the Edge's own error envelope yields no reason at all,
    // rather than a truncated slice of whatever the server happened to send.
    expect((error as ApiClientError).serverReason).toBeNull();
  });

  it("keeps the SQLSTATE the server named instead of discarding it", async () => {
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      // Exactly what the Edge answers for a CHECK violation now that 23514 is
      // mapped: the failure names itself, and the worker must not throw that
      // away - recovering it cost a three-system log correlation last time.
      fetch: async () => Response.json(
        { error: "worker_backend_error", code: "23514" },
        { status: 400 },
      ),
    });

    const error = await client.ingest({ observedAt: "2026-08-03T00:00:00.000Z" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "HTTP_400",
      status: 400,
      // A malformed payload cannot become valid by being sent again.
      retryable: false,
      serverReason: "23514",
    });
  });

  it("keeps the rejected field path the Edge reported", async () => {
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async () => Response.json({
        error: "invalid_request",
        reason: "payload.clients[0].sessionType is outside its value domain",
      }, { status: 400 }),
    });

    const error = await client.ingest({ observedAt: "2026-08-03T00:00:00.000Z" })
      .catch((cause: unknown) => cause);

    expect((error as ApiClientError).serverReason)
      .toBe("payload.clients[0].sessionType is outside its value domain");
  });

  it("refuses to read an oversized error body at all", async () => {
    const secret = "secret-that-must-not-leak".repeat(2);
    let cancelled = false;
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret,
      timeoutMs: 1_000,
      fetch: async () => {
        const response = Response.json(
          { error: "worker_backend_error", code: "x".repeat(64) },
          { status: 500 },
        );
        response.headers.set("content-length", String(64 * 1024));
        Object.defineProperty(response, "body", {
          value: { cancel: async () => { cancelled = true; } },
        });
        return response;
      },
    });

    const error = await client.heartbeat({
      status: "ONLINE",
      workerVersion: "test",
      capabilities: [],
      queueAgeSeconds: 0,
      safeMetadata: {},
      startedAt: "2026-08-03T00:00:00.000Z",
    }).catch((cause: unknown) => cause);

    expect((error as ApiClientError).serverReason).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("accepts typed claim metadata and sends fenced observations without worker-authored success", async () => {
    const requests: Request[] = [];
    const claim = baseClaim;
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          ok: true,
          data: request.url.endsWith("/claim")
            ? { items: [claim] }
            : request.url.endsWith("/observe")
              ? { accepted: true, transitionVersion: 8 }
              : { accepted: true },
        });
      },
    });

    await expect(client.claimCommands()).resolves.toEqual([claim]);
    await expect(client.observe({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      fencingGeneration: claim.fencingGeneration,
      transitionVersion: claim.transitionVersion,
      observationId: "70000000-0000-4000-8000-000000000001",
      observationKind: "POST_ACTION",
      observedAt: "2026-07-30T00:00:01.000Z",
      evidence: { dns: { commandAck: true } },
    })).resolves.toEqual({ accepted: true, transitionVersion: 8 });
    await client.complete({
      commandId: claim.commandId,
      leaseToken: claim.leaseToken,
      fencingGeneration: claim.fencingGeneration,
      transitionVersion: 8,
      outcome: "EVALUATE_POSTCONDITION",
      result: { actionType: "FLUSH_DNS_CACHE" },
    });

    const observeBody = await requests[1]!.json() as Record<string, unknown>;
    expect(observeBody).toMatchObject({
      fencingGeneration: 11,
      transitionVersion: 7,
      observationKind: "POST_ACTION",
    });
    const completeBody = await requests[2]!.json() as Record<string, unknown>;
    expect(completeBody).toMatchObject({
      fencingGeneration: 11,
      transitionVersion: 8,
      outcome: "EVALUATE_POSTCONDITION",
    });
    expect(completeBody).not.toHaveProperty("observations");
    expect(JSON.stringify(completeBody)).not.toContain("reconciliationDecision");
    expect(completeBody.outcome).not.toBe("SUCCEEDED");
  });

  it("defaults claim requests to three and accepts exactly the requested limit", async () => {
    const requests: Request[] = [];
    const claims = Array.from({ length: 3 }, (_, index) => ({
      ...baseClaim,
      commandId: `50000000-0000-4000-8000-00000000000${index + 1}`,
      leaseToken: `60000000-0000-4000-8000-00000000000${index + 1}`,
    }));
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true, data: { items: claims } });
      },
    });

    await expect(client.claimCommands()).resolves.toEqual(claims);
    await expect(requests[0]!.json()).resolves.toEqual({ limit: 3, leaseSeconds: 90 });
  });

  it("rejects a claim response that exceeds the requested limit", async () => {
    const claims = Array.from({ length: 3 }, (_, index) => ({
      ...baseClaim,
      commandId: `50000000-0000-4000-8000-00000000000${index + 1}`,
      leaseToken: `60000000-0000-4000-8000-00000000000${index + 1}`,
    }));
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async () => Response.json({ ok: true, data: { items: claims } }),
    });

    await expect(client.claimCommands(2, 90)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("validates inventory degradation metadata returned by the database boundary", async () => {
    const baseUrl = new URL("https://example.test/worker");
    const validClient = new NetworkCenterApiClient({
      baseUrl,
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async () => Response.json({
        ok: true,
        data: {
          routerDeviceId: "40000000-0000-4000-8000-000000000001",
          interfaces: [{
            managedResourceId: "60000000-0000-4000-8000-000000000001",
            interfaceKey: "ether4",
            id: "50000000-0000-4000-8000-000000000001",
            currentName: "room-401",
            immutableKey: "ether4",
            enrolledRole: "ACCESS",
            protected: false,
            enrollmentState: "ENROLLED",
          }],
          aruba: [],
          inventoryStatus: "DEGRADED",
          quarantinedCount: 3,
        },
      }),
    });
    await expect(validClient.inventory({})).resolves.toMatchObject({
      inventoryStatus: "DEGRADED",
      quarantinedCount: 3,
      interfaces: [{
        managedResourceId: "60000000-0000-4000-8000-000000000001",
        currentName: "room-401",
        immutableKey: "ether4",
        enrolledRole: "ACCESS",
        protected: false,
        enrollmentState: "ENROLLED",
      }],
    });

    const missingAuthorityClient = new NetworkCenterApiClient({
      baseUrl,
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async () => Response.json({
        ok: true,
        data: {
          routerDeviceId: "40000000-0000-4000-8000-000000000001",
          interfaces: [{
            interfaceKey: "ether4",
            id: "50000000-0000-4000-8000-000000000001",
          }],
          aruba: [],
        },
      }),
    });
    await expect(missingAuthorityClient.inventory({}))
      .rejects.toBeInstanceOf(ApiClientError);

    const invalidClient = new NetworkCenterApiClient({
      baseUrl,
      secret: "s".repeat(48),
      timeoutMs: 1_000,
      fetch: async () => Response.json({
        ok: true,
        data: {
          routerDeviceId: "40000000-0000-4000-8000-000000000001",
          interfaces: [],
          aruba: [],
          inventoryStatus: "TRUST_CALLER",
          quarantinedCount: -1,
        },
      }),
    });
    await expect(invalidClient.inventory({})).rejects.toBeInstanceOf(ApiClientError);
  });

  it("keeps the timeout active while reading a slow response body", async () => {
    const client = new NetworkCenterApiClient({
      baseUrl: new URL("https://example.test/worker"),
      secret: "s".repeat(48),
      timeoutMs: 5,
      fetch: async (_input, init) => {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('{"ok":true,"data":{"items":[]}}'));
              controller.close();
            }, 50);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        });
        return new Response(body, { headers: { "content-type": "application/json" } });
      },
    });

    const error = await client.listConnections().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ retryable: true });
  });
});
