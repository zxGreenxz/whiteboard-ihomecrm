import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeBridgeServer,
  createBridgeServer,
  listenBridgeServer,
} from "../src/bridge/server.js";
import {
  assertNoInlineSecretEnvironment,
  createBrokeredMediaEgressFromEnvironment,
  createBridgeRuntimeFromEnvironment,
  readBridgeServerAddress,
} from "../src/bin/bridge.js";
import type { Readiness } from "../src/health/snapshot.js";

const serviceRoot = new URL("../", import.meta.url);
const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => closeBridgeServer(server)));
  for (const socket of openSockets.splice(0)) socket.destroy();
});

async function startServer(readiness: () => Readiness) {
  const server = createBridgeServer({ readiness });
  openServers.push(server);
  const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
  return `http://${address.host}:${address.port}`;
}

describe("bridge health HTTP server", () => {
  it("force-closes incomplete HTTP connections within the shutdown deadline", async () => {
    const server = createBridgeServer({ readiness: () => ({
      inboundReady: true,
      outboundReady: true,
      aiReady: true,
      heartbeatStale: false,
    }) });
    openServers.push(server);
    const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
    const socket = connect(address.port, address.host);
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("POST /v1/zalouser/inbound/commit HTTP/1.1\r\nHost: bridge\r\nContent-Length: 999999\r\n");
    const socketClosed = new Promise<void>((resolve) => socket.once("close", resolve));

    const startedAt = Date.now();
    await Promise.race([
      Promise.all([closeBridgeServer(server, { timeoutMs: 100 }), socketClosed]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("socket did not close")), 900);
      }),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(socket.destroyed).toBe(true);
  });

  it("serves process-only liveness without consulting readiness dependencies", async () => {
    let readinessCalls = 0;
    const baseUrl = await startServer(() => {
      readinessCalls += 1;
      throw new Error("readiness dependency unavailable");
    });

    const response = await fetch(`${baseUrl}/livez`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
    expect(readinessCalls).toBe(0);
  });

  it("exposes split readiness and returns 503 only when inbound is unsafe", async () => {
    let snapshot: Readiness = {
      inboundReady: true,
      outboundReady: false,
      aiReady: false,
      heartbeatStale: false,
    };
    const baseUrl = await startServer(() => snapshot);

    const paused = await fetch(`${baseUrl}/readyz`);
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual(snapshot);

    snapshot = {
      inboundReady: false,
      outboundReady: false,
      aiReady: false,
      heartbeatStale: true,
    };
    const stale = await fetch(`${baseUrl}/readyz`);
    expect(stale.status).toBe(503);
    expect(await stale.json()).toEqual(snapshot);
  });

  it("keeps the health surface GET-only and returns content-free errors", async () => {
    const baseUrl = await startServer(() => ({
      inboundReady: true,
      outboundReady: true,
      aiReady: true,
      heartbeatStale: false,
    }));

    const wrongMethod = await fetch(`${baseUrl}/livez`, { method: "POST", body: "secret" });
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toEqual({ error: "METHOD_NOT_ALLOWED" });

    const missing = await fetch(`${baseUrl}/not-a-route`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "NOT_FOUND" });
  });
});

describe("bridge executable configuration", () => {
  it("uses a container-safe default and accepts an explicit address", () => {
    expect(readBridgeServerAddress({})).toEqual({ host: "0.0.0.0", port: 8080 });
    expect(readBridgeServerAddress({
      OPENCLAW_BRIDGE_HOST: "127.0.0.1",
      OPENCLAW_BRIDGE_PORT: "9080",
    })).toEqual({ host: "127.0.0.1", port: 9080 });
  });

  it("rejects malformed host and port input before binding", () => {
    expect(() => readBridgeServerAddress({ OPENCLAW_BRIDGE_HOST: "  " })).toThrow(/host/i);
    for (const port of ["0", "65536", "1.5", "not-a-port"]) {
      expect(() => readBridgeServerAddress({ OPENCLAW_BRIDGE_PORT: port })).toThrow(/port/i);
    }
  });

  it("rejects inline runtime secrets while allowing secret file references", () => {
    expect(() => assertNoInlineSecretEnvironment({
      OPENCLAW_RUNTIME_CREDENTIAL: "inline-secret",
    })).toThrow(/inline secret/i);
    expect(() => assertNoInlineSecretEnvironment({
      SUPABASE_SERVICE_ROLE_KEY: "inline-secret",
    })).toThrow(/inline secret/i);
    expect(() => assertNoInlineSecretEnvironment({
      OPENCLAW_RUNTIME_CREDENTIAL_FILE: "/run/secrets/openclaw_runtime_credential",
    })).not.toThrow();
  });

  it("constructs brokered media egress from the reviewed Node proxy environment", async () => {
    const request = vi.fn(async () => new Response("ok"));
    const egress = createBrokeredMediaEgressFromEnvironment({
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://openclaw-egress-broker:8080",
    }, request as typeof fetch);

    await expect(egress.fetch(new URL("https://cdn.zalo.me/media"), {
      method: "GET",
    })).resolves.toBeInstanceOf(Response);
    expect(request).toHaveBeenCalledOnce();
    expect(() => createBrokeredMediaEgressFromEnvironment({})).toThrow(/NODE_USE_ENV_PROXY/i);
    expect(() => createBrokeredMediaEgressFromEnvironment({
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "https://openclaw-egress-broker:8080",
    })).toThrow(/HTTPS_PROXY/i);
    for (const bypassName of ["NO_PROXY", "no_proxy"] as const) {
      expect(() => createBrokeredMediaEgressFromEnvironment({
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://openclaw-egress-broker:8080",
        [bypassName]: "cdn.zalo.me,127.0.0.1",
      })).toThrow(/NO_PROXY/i);
    }
  });

  it("reaches secret loading without a test-only media egress injection", async () => {
    await expect(createBridgeRuntimeFromEnvironment({}))
      .rejects.toThrow(/NODE_USE_ENV_PROXY/i);
    await expect(createBridgeRuntimeFromEnvironment({
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://openclaw-egress-broker:8080",
    })).rejects.not.toThrow(/brokered media egress/i);
  });
});

describe("bridge package runtime artifacts", () => {
  it("wires npm start to the compiled executable", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", serviceRoot), "utf8"));
    expect(manifest.scripts.start).toBe("node dist/src/bin/bridge.js");
    expect(manifest.scripts.build).toContain("copy-runtime-assets.mjs");
    expect(manifest.engines.node).toBe(">=24.18.0 <25");
  });

  it("ships a non-root runtime image with a local liveness check", async () => {
    const dockerfile = await readFile(new URL("Dockerfile", serviceRoot), "utf8");
    const pinnedBase = "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
    expect(dockerfile.match(/^FROM .+$/gm)).toEqual([
      `FROM ${pinnedBase} AS build`,
      `FROM ${pinnedBase} AS runtime`,
    ]);
    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npm run build");
    expect(dockerfile).toContain("/var/lib/openclaw-bridge");
    expect(dockerfile).toMatch(/chown[^\n]*node:node/);
    expect(dockerfile).toContain("OPENCLAW_SPOOL_PATH=/var/lib/openclaw-bridge/spool.db");
    expect(dockerfile).toContain(
      "OPENCLAW_QR_ENCRYPTION_KEY_FILE=/run/secrets/openclaw_qr_encryption_key",
    );
    expect(dockerfile).toContain("NODE_USE_ENV_PROXY=1");
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("/livez");
    expect(dockerfile).toContain('CMD ["npm", "start"]');
  });

  it("documents health semantics and protected secret mounting", async () => {
    const readme = await readFile(new URL("README.md", serviceRoot), "utf8");
    for (const required of [
      "npm start",
      "OPENCLAW_BRIDGE_HOST",
      "OPENCLAW_BRIDGE_PORT",
      "OPENCLAW_ZALO_BRIDGE_SECRET_FILE",
      "/livez",
      "/readyz",
      "/run/secrets",
      "10 seconds",
      "Node 24.18",
      "assistant-only internal transcript",
      "inboundReady",
      "outboundReady",
      "aiReady",
      "HTTPS_PROXY",
      "NODE_USE_ENV_PROXY",
      "OPENCLAW_QR_ENCRYPTION_KEY_FILE",
      "/run/secrets/openclaw_qr_encryption_key",
    ]) {
      expect(readme).toContain(required);
    }
  });

  it("excludes dependency, build, state, and local-secret files from Docker context", async () => {
    const dockerignore = await readFile(new URL(".dockerignore", serviceRoot), "utf8");
    for (const required of ["node_modules", "dist", ".data", ".env", "coverage"]) {
      expect(dockerignore).toContain(required);
    }
  });
});
