import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSignedBridgeRequest,
  verifySignedBridgeResponse,
} from "../../openclaw-zalo-cell/vendor/zalouser-bridge/src/bridge/protocol.js";
import {
  closeBridgeServer,
  createBridgeServer,
  listenBridgeServer,
} from "../src/bridge/server.js";

const NOW = 1_785_062_400_000;
const SECRET = Buffer.from("cell-local-bridge-hmac-secret-32-bytes-minimum");
const binding = {
  organizationId: "dddd0000-0000-4000-8000-000000000001",
  accountId: "dddd1000-0000-4000-8000-000000000001",
  cellId: "dddd2000-0000-4000-8000-000000000001",
  sessionGeneration: 5,
  fencingToken: 7,
  controlVersion: 2,
  takeoverVersion: 1,
};
const authorization = {
  version: 1,
  claimToken: "claim-token-value-that-is-at-least-32-bytes",
  authorizationMarker: {
    version: 1,
    outboxId: "dddd8000-0000-4000-8000-000000000001",
    claimGeneration: 3,
    payloadHash: "a".repeat(64),
    fencingToken: 7,
    sessionGeneration: 5,
    controlVersion: 2,
    takeoverVersion: 1,
    markerNonce: "dddd7000-0000-4000-8000-000000000001",
    expiresAt: "2026-08-01T00:00:15.000Z",
  },
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeBridgeServer(server)));
});

async function fixture() {
  const commit = vi.fn(() => ({
    version: 1 as const,
    status: "committed" as const,
    durability: { journalMode: "WAL" as const, synchronous: "FULL" as const },
  }));
  const authorizeSend = vi.fn(async () => undefined);
  const authorizeControl = vi.fn(async () => undefined);
  const materializeMedia = vi.fn(async (request: {
    version: 1;
    objectKey: string;
    sha256: string;
    mime: string;
    bytes: number;
  }) => ({ ...request, contentBase64: Buffer.from("abc").toString("base64") }));
  const server = createBridgeServer({
    readiness: () => ({ inboundReady: true, outboundReady: true, aiReady: true, heartbeatStale: false }),
    localCell: {
      secret: SECRET,
      binding,
      inbound: { ready: () => true, commit },
      authorizeSend,
      authorizeControl,
      materializeMedia,
      now: () => NOW,
    },
  });
  servers.push(server);
  const address = await listenBridgeServer(server, { host: "127.0.0.1", port: 0 });
  return {
    baseUrl: `http://${address.host}:${address.port}`,
    commit,
    authorizeSend,
    authorizeControl,
    materializeMedia,
  };
}

async function signedPost(baseUrl: string, path: string, operation: string, body: unknown) {
  const request = createSignedBridgeRequest({
    operation,
    binding,
    body,
    secret: SECRET,
    now: NOW,
    nonce: crypto.randomUUID(),
    ttlMs: 2_000,
  });
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const envelope = await response.json();
  return {
    status: response.status,
    body: verifySignedBridgeResponse(envelope, {
      operation,
      requestNonce: request.nonce,
      binding,
      secret: SECRET,
      now: NOW,
    }),
  };
}

describe("vendored ZaloUser signed local bridge surface", () => {
  it("serves only the exact readiness and inbound commit endpoints", async () => {
    const { baseUrl, commit } = await fixture();

    await expect(signedPost(baseUrl, "/v1/zalouser/ready", "inbound.ready", { version: 1 }))
      .resolves.toEqual({ status: 200, body: { version: 1, status: "READY" } });
    const inbound = { version: 1, testEnvelope: "exact-body" };
    await expect(signedPost(baseUrl, "/v1/zalouser/inbound/commit", "inbound.commit", inbound))
      .resolves.toEqual({
        status: 200,
        body: {
          version: 1,
          status: "committed",
          durability: { journalMode: "WAL", synchronous: "FULL" },
        },
      });
    expect(commit).toHaveBeenCalledWith(inbound, expect.objectContaining({
      organizationId: binding.organizationId,
      fencingToken: binding.fencingToken,
    }));

    expect((await fetch(`${baseUrl}/v1/inbound`, { method: "POST" })).status).toBe(404);
  });

  it("authorizes only the exact signed authorization marker through Runtime", async () => {
    const { baseUrl, authorizeSend } = await fixture();

    await expect(signedPost(
      baseUrl,
      "/v1/outbox/authorize-send",
      "outbox.authorize-send",
      authorization,
    )).resolves.toEqual({ status: 200, body: { version: 1, status: "AUTHORIZED" } });
    expect(authorizeSend).toHaveBeenCalledWith(authorization);

    const unsigned = await fetch(`${baseUrl}/v1/outbox/authorize-send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(authorization),
    });
    expect(unsigned.status).toBe(401);
    expect(authorizeSend).toHaveBeenCalledTimes(1);
  });

  it("authorizes exact fixed-schema control traffic through the signed endpoint", async () => {
    const { baseUrl, authorizeControl } = await fixture();
    const control = {
      version: 1,
      kind: "typing",
      sink: { accountProfile: "primary", conversationId: "conversation-1", isGroup: false },
    };

    await expect(signedPost(
      baseUrl,
      "/v1/zalouser/control/authorize",
      "control.authorize",
      control,
    )).resolves.toEqual({ status: 200, body: { version: 1, status: "AUTHORIZED" } });
    expect(authorizeControl).toHaveBeenCalledWith(control);
  });

  it("materializes exact outbound media bytes only through the signed endpoint", async () => {
    const { baseUrl, materializeMedia } = await fixture();
    const request = {
      version: 1,
      objectKey: "v1/org/demo/media/object.png",
      sha256: createHash("sha256").update("abc").digest("hex"),
      mime: "image/png",
      bytes: 3,
    };

    await expect(signedPost(
      baseUrl,
      "/v1/zalouser/media/materialize",
      "media.materialize",
      request,
    )).resolves.toEqual({
      status: 200,
      body: { ...request, contentBase64: Buffer.from("abc").toString("base64") },
    });
    expect(materializeMedia).toHaveBeenCalledWith(request);
  });
});
