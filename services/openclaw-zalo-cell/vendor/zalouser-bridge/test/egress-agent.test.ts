import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveEgressProxyUrl,
  resolveZaloEgressAgent,
  shouldBypassEgressProxy,
} from "../src/bridge/egress-agent.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function trackHttp(server: HttpServer): void {
  closers.push(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
}

describe("egress proxy selection", () => {
  it("prefers https_proxy, falls back to http_proxy, and ignores blanks", () => {
    expect(resolveEgressProxyUrl({ HTTPS_PROXY: "http://broker:8080" })?.href).toBe(
      "http://broker:8080/",
    );
    expect(resolveEgressProxyUrl({ HTTP_PROXY: "http://broker:8080" })?.href).toBe(
      "http://broker:8080/",
    );
    expect(
      resolveEgressProxyUrl({ https_proxy: "http://lower:8080", HTTP_PROXY: "http://upper:8080" })
        ?.href,
    ).toBe("http://lower:8080/");
    expect(resolveEgressProxyUrl({ HTTPS_PROXY: "   " })).toBeUndefined();
    expect(resolveEgressProxyUrl({})).toBeUndefined();
  });

  it("honours NO_PROXY so in-cell peers are never tunnelled", () => {
    const env = { NO_PROXY: "localhost,127.0.0.1,cell,bridge,egress-broker" };
    expect(shouldBypassEgressProxy("bridge", env)).toBe(true);
    expect(shouldBypassEgressProxy("localhost", env)).toBe(true);
    expect(shouldBypassEgressProxy("ws4-msg.chat.zalo.me", env)).toBe(false);
  });

  it("returns no agent when no proxy is configured, so behaviour is unchanged off-cell", () => {
    expect(resolveZaloEgressAgent({})).toBeUndefined();
  });
});

describe("egress tunnel", () => {
  it("hands the origin hostname to the proxy instead of resolving it in this process", async () => {
    // This is the regression. The cell's network has no resolver, so the moment
    // a dial resolves locally it dies at getaddrinfo - exactly how the Zalo
    // listener failed: "getaddrinfo EAI_AGAIN ws4-msg.chat.zalo.me". A hostname
    // that provably cannot resolve anywhere proves the dial never tried.
    const seen: string[] = [];
    const proxy = createHttpServer();
    proxy.on("connect", (request, clientSocket) => {
      seen.push(request.url ?? "");
      // Answer 200 then drop: TLS will fail, but the CONNECT line is the claim.
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.destroy();
    });
    trackHttp(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxy.address() as { port: number }).port;

    const agent = resolveZaloEgressAgent({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` });
    expect(agent).toBeDefined();

    const error = await new Promise<Error | null>((resolve) => {
      agent?.createConnection({ host: "ws4-msg.chat.zalo.me", port: 443 }, (err: Error | null) =>
        resolve(err),
      );
    });

    expect(seen).toEqual(["ws4-msg.chat.zalo.me:443"]);
    // Whatever happened after the tunnel opened, it must not be a DNS failure.
    expect(String(error ?? "")).not.toContain("EAI_AGAIN");
    expect(String(error ?? "")).not.toContain("getaddrinfo");
  });

  it("surfaces a refused CONNECT instead of hanging or reporting success", async () => {
    const proxy = createHttpServer();
    proxy.on("connect", (_request, clientSocket) => {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
    });
    trackHttp(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const proxyPort = (proxy.address() as { port: number }).port;

    const agent = resolveZaloEgressAgent({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` });
    const error = await new Promise<Error | null>((resolve) => {
      agent?.createConnection(
        { host: "ws4-msg.chat.zalo.me", port: 443 },
        (err: Error | null) => resolve(err),
      );
    });
    expect(error).toBeInstanceOf(Error);
    expect(String(error?.message)).toContain("403");
  });
});
