import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { parseAllowlist } from "../src/allowlist.js";
import {
  authorizeConnect,
  createConnectProxy,
  parseConnectAuthority,
  type DialPinnedTarget,
  type ResolveHost,
} from "../src/connect-proxy.js";
import { parseBrokerEnvironment } from "../src/main.js";

const allowlist = parseAllowlist([
  { host: "api.example.com", port: 443, purpose: "test endpoint" },
]);

describe("CONNECT authority parsing", () => {
  it("accepts only an explicit FQDN and port", () => {
    expect(parseConnectAuthority("API.EXAMPLE.COM:443")).toEqual({
      host: "api.example.com",
      port: 443,
    });
    expect(parseConnectAuthority("api.example.com")).toBeNull();
    expect(parseConnectAuthority("https://api.example.com:443")).toBeNull();
    expect(parseConnectAuthority("user:pass@api.example.com:443")).toBeNull();
    expect(parseConnectAuthority("1.1.1.1:443")).toBeNull();
    expect(parseConnectAuthority("[2606:4700:4700::1111]:443")).toBeNull();
  });
});

describe("CONNECT authorization and pinning", () => {
  it("resolves every connection and returns only a validated pinned IP", async () => {
    const resolveHost: ResolveHost = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);

    const first = await authorizeConnect("api.example.com:443", { allowlist, resolveHost });
    const second = await authorizeConnect("api.example.com:443", { allowlist, resolveHost });

    expect(first).toMatchObject({
      ok: true,
      destination: {
        host: "api.example.com",
        tlsServername: "api.example.com",
        port: 443,
        pinnedAddress: "93.184.216.34",
        family: 4,
      },
    });
    expect(second.ok).toBe(true);
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("fails closed when DNS returns any private answer", async () => {
    const result = await authorizeConnect("api.example.com:443", {
      allowlist,
      resolveHost: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    expect(result).toEqual({ ok: false, statusCode: 403, reason: "LOOPBACK" });
  });

  it("rejects an IP literal before invoking DNS", async () => {
    const resolveHost: ResolveHost = vi.fn(async () => []);
    const result = await authorizeConnect("1.1.1.1:443", { allowlist, resolveHost });
    expect(result).toEqual({ ok: false, statusCode: 400, reason: "MALFORMED_TARGET" });
    expect(resolveHost).not.toHaveBeenCalled();
  });
});

describe("CONNECT proxy server", () => {
  it("dials the pinned address and never the requested hostname", async () => {
    const dialCalls: unknown[] = [];
    const dialPinnedTarget: DialPinnedTarget = async (destination) => {
      dialCalls.push(destination);
      return new PassThrough();
    };
    const logs: unknown[] = [];
    const server = createConnectProxy({
      allowlist,
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      dialPinnedTarget,
      log: (event) => logs.push(event),
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test proxy did not bind TCP");

      const response = await sendRawConnect(address.port, [
        "CONNECT api.example.com:443 HTTP/1.1",
        "Host: api.example.com:443",
        "Proxy-Authorization: Basic cHJveHktdXNlcjpzdXBlci1zZWNyZXQ=",
        "",
        "",
      ].join("\r\n"));

      expect(response).toContain("HTTP/1.1 200 Connection Established");
      expect(dialCalls).toEqual([expect.objectContaining({
        pinnedAddress: "93.184.216.34",
        host: "api.example.com",
        port: 443,
      })]);
      expect(JSON.stringify(logs)).not.toContain("cHJveHktdXNlcjpzdXBlci1zZWNyZXQ=");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("Broker runtime configuration", () => {
  it("parses bounded listener and local topology settings", () => {
    expect(parseBrokerEnvironment({
      OPENCLAW_EGRESS_HOST: "0.0.0.0",
      OPENCLAW_EGRESS_PORT: "3128",
      OPENCLAW_EGRESS_ALLOWLIST_PATH: "/etc/openclaw-egress/allowlist.yaml",
      OPENCLAW_EGRESS_HOST_GATEWAY_ADDRESSES: "172.17.0.1,fe80::1",
      OPENCLAW_EGRESS_CONTAINER_NETWORK_CIDRS: "172.20.0.0/16,fd00:20::/64",
    })).toEqual({
      host: "0.0.0.0",
      port: 3128,
      allowlistPath: "/etc/openclaw-egress/allowlist.yaml",
      topology: {
        hostGatewayAddresses: ["172.17.0.1", "fe80::1"],
        containerNetworkCidrs: ["172.20.0.0/16", "fd00:20::/64"],
      },
    });
  });

  it("fails closed on malformed runtime settings", () => {
    expect(() => parseBrokerEnvironment({ OPENCLAW_EGRESS_PORT: "0" })).toThrow(/port/i);
    expect(() => parseBrokerEnvironment({ OPENCLAW_EGRESS_HOST: "broker.local" })).toThrow(/host/i);
    expect(() => parseBrokerEnvironment({ OPENCLAW_EGRESS_ALLOWLIST_PATH: "relative.yaml" }))
      .toThrow(/absolute/i);
    expect(() => parseBrokerEnvironment({
      OPENCLAW_EGRESS_CONTAINER_NETWORK_CIDRS: "172.20.0.0/99",
    })).toThrow(/CIDR/i);
  });
});

async function sendRawConnect(port: number, request: string): Promise<string> {
  const { createConnection } = await import("node:net");
  return await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy(new Error("proxy response timed out"));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}
