import { describe, expect, it } from "vitest";

import { ApiClientError, NetworkCenterApiClient } from "../src/apiClient.js";

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

    const error = await client.claimCommands(5, 90).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ retryable: true, status: 503 });
    expect(String((error as Error).message)).not.toContain("router");
    expect(String((error as Error).message)).not.toContain(secret);
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
