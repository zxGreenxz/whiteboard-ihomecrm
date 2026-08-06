import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGatewayCellRpcTransport,
  type GatewayWebSocket,
} from "../src/adapters/gateway-client.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

class ProtocolFaithfulFakeGateway extends EventTarget implements GatewayWebSocket {
  readyState = 0;
  readonly receivedMethods: string[] = [];

  constructor(
    private readonly expected: {
      deviceId: string;
      deviceToken: string;
      publicKeyRaw: Buffer;
    },
    private readonly businessError?: {
      code: string;
      authorizedHandoffRecorded?: false;
    },
    private readonly agentFinalDelayMs = 0,
  ) {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
      this.emit({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "gateway-nonce-1" },
      });
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    expect(frame.type).toBe("req");
    const id = frame.id as string;
    const method = frame.method as string;
    const params = frame.params as Record<string, unknown>;

    if (method === "connect") {
      expect(params.minProtocol).toBe(4);
      expect(params.maxProtocol).toBe(4);
      expect(params.client).toEqual({
        id: "gateway-client",
        version: "0.1.0",
        platform: process.platform,
        mode: "backend",
        instanceId: "openclaw-zalo-bridge",
      });
      expect(params.caps).toEqual([]);
      expect(params.commands).toEqual([]);
      expect(params.role).toBe("operator");
      expect(params.scopes).toEqual(["operator.admin"]);
      // `token`, not `deviceToken`. This fake was written to match the client rather
      // than the Gateway, so it certified the one shape the real 2026.7.1 Gateway
      // rejects: `deviceToken` is matched against a token the Gateway itself minted
      // for a paired device, and the provisioned secret is the Gateway auth token.
      // Against the real cell, `deviceToken` answered `device_token_mismatch` on every
      // connect; `token` answers `hello-ok`.
      expect(params.auth).toEqual({ token: this.expected.deviceToken });

      const device = params.device as Record<string, unknown>;
      expect(device.id).toBe(this.expected.deviceId);
      expect(decodeBase64Url(device.publicKey as string)).toEqual(this.expected.publicKeyRaw);
      expect(device.nonce).toBe("gateway-nonce-1");
      const signedAt = device.signedAt as number;
      const payload = [
        "v3",
        this.expected.deviceId,
        "gateway-client",
        "backend",
        "operator",
        "operator.admin",
        String(signedAt),
        this.expected.deviceToken,
        "gateway-nonce-1",
        process.platform.toLowerCase(),
        "",
      ].join("|");
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, this.expected.publicKeyRaw]),
        type: "spki",
        format: "der",
      });
      expect(verify(
        null,
        Buffer.from(payload, "utf8"),
        publicKey,
        decodeBase64Url(device.signature as string),
      )).toBe(true);

      this.emit({
        type: "res",
        id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test-gateway", connId: "conn-1" },
          features: {
            methods: [
              "channels.status", "channels.start", "channels.stop", "channels.logout",
              "agent", "agent.wait", "zalouser.bridge.send",
            ],
            events: ["tick"],
          },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 1,
          },
          auth: { role: "operator", scopes: ["operator.admin"] },
          policy: { maxPayload: 1_048_576, maxBufferedBytes: 1_048_576, tickIntervalMs: 30_000 },
        },
      });
      return;
    }

    this.receivedMethods.push(method);
    if (method === "zalouser.bridge.send" && this.businessError !== undefined) {
      this.emit({ type: "res", id, ok: false, error: this.businessError });
      return;
    }
    if (method === "agent") {
      this.emit({
        type: "res",
        id,
        ok: true,
        payload: { runId: "run-1", status: "accepted" },
      });
      const emitFinal = () => {
        this.emit({
          type: "res",
          id,
          ok: true,
          payload: { runId: "run-1", status: "ok", result: { method, params } },
        });
      };
      if (this.agentFinalDelayMs === 0) queueMicrotask(emitFinal);
      else setTimeout(emitFinal, this.agentFinalDelayMs);
      return;
    }
    this.emit({ type: "res", id, ok: true, payload: { method, params } });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  private emit(frame: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

describe("authenticated OpenClaw Gateway transport", () => {
  afterEach(() => vi.useRealTimers());

  it("authenticates the bridge device before invoking the required Gateway methods", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = rawPublicKey(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    const deviceToken = "paired-device-token";
    let socket: ProtocolFaithfulFakeGateway | undefined;

    const transport = createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken,
      deviceIdentity: { deviceId, publicKeyPem, privateKeyPem },
      webSocketFactory: () => {
        socket = new ProtocolFaithfulFakeGateway({ deviceId, deviceToken, publicKeyRaw });
        return socket;
      },
    });

    await expect(transport.invoke("channels.status", { version: 1 })).resolves.toMatchObject({
      method: "channels.status",
    });
    const internalAgentParams = {
      message: "draft",
      agentId: "zalo-customer-drafting",
      modelRun: true,
      disableMessageTool: true,
      deliver: false,
      suppressPromptPersistence: true,
      sessionEffects: "internal",
      idempotencyKey: "dddd5000-0000-4000-8000-000000000001",
    };
    await expect(transport.invoke("agent", internalAgentParams)).resolves.toMatchObject({
      runId: "run-1",
      status: "ok",
      result: { method: "agent", params: internalAgentParams },
    });
    expect(internalAgentParams).not.toHaveProperty("sessionId");
    expect(internalAgentParams).not.toHaveProperty("sessionKey");
    await expect(transport.invoke("agent.wait", { runId: "run-1" })).rejects.toMatchObject({
      code: "CELL_RPC_METHOD_INVALID",
    });
    for (const method of [
      "channels.start", "channels.stop", "channels.logout", "web.login.start", "web.login.wait",
    ]) {
      await expect(transport.invoke(method, { channel: "zalouser" })).resolves.toMatchObject({ method });
    }
    await expect(transport.invoke("zalouser.bridge.send", { version: 1 })).resolves.toMatchObject({
      method: "zalouser.bridge.send",
    });
    expect(socket?.receivedMethods).toEqual([
      "channels.status",
      "agent",
      "channels.start",
      "channels.stop",
      "channels.logout",
      "web.login.start",
      "web.login.wait",
      "zalouser.bridge.send",
    ]);
    await transport.close();
  });

  it("redials once after a closed connection for concurrent callers", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = rawPublicKey(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    const deviceToken = "paired-device-token";
    const sockets: ProtocolFaithfulFakeGateway[] = [];
    const transport = createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken,
      deviceIdentity: { deviceId, publicKeyPem, privateKeyPem },
      webSocketFactory: () => {
        const socket = new ProtocolFaithfulFakeGateway({ deviceId, deviceToken, publicKeyRaw });
        sockets.push(socket);
        return socket;
      },
    });

    await expect(transport.invoke("channels.status", { attempt: 1 })).resolves.toMatchObject({
      method: "channels.status",
    });
    sockets[0]?.close();

    await expect(Promise.all([
      transport.invoke("channels.status", { attempt: 2 }),
      transport.invoke("channels.status", { attempt: 3 }),
    ])).resolves.toEqual([
      { method: "channels.status", params: { attempt: 2 } },
      { method: "channels.status", params: { attempt: 3 } },
    ]);
    expect(sockets).toHaveLength(2);
    await transport.close();
  });

  it("rejects missing credentials and non-TLS Gateway URLs before opening a socket", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = rawPublicKey(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    const deviceIdentity = { deviceId, publicKeyPem, privateKeyPem };

    expect(() => createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken: "",
      deviceIdentity,
    })).toThrow(/credential/i);
    expect(() => createGatewayCellRpcTransport({
      url: "ws://gateway.internal/openclaw",
      deviceToken: "paired-device-token",
      deviceIdentity,
    })).toThrow(/TLS/i);
  });

  // The reviewed compose.cell.yaml runs the cell gateway plaintext at
  // ws://cell:18789 on an internal:true network with no route off the host. Every
  // url in this suite was wss://gateway.internal/openclaw, so nothing caught that
  // the bridge refused its own infrastructure and could not start.
  it("accepts the plaintext intra-stack gateway, and only that", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const deviceId = createHash("sha256").update(rawPublicKey(publicKeyPem)).digest("hex");
    const deviceIdentity = { deviceId, publicKeyPem, privateKeyPem };
    const deviceToken = "paired-device-token";

    expect(() => createGatewayCellRpcTransport({
      url: "ws://cell:18789",
      deviceToken,
      deviceIdentity,
    })).not.toThrow();
    // A real host over plaintext is still refused, port or no port.
    for (const url of ["ws://cell.example.com:18789", "ws://openclaw.chillhome.io.vn/openclaw"]) {
      expect(() => createGatewayCellRpcTransport({ url, deviceToken, deviceIdentity }))
        .toThrow(/TLS/i);
    }
    // Credentials in the URL stay refused even on the internal hop.
    expect(() => createGatewayCellRpcTransport({
      url: "ws://user:pass@cell:18789",
      deviceToken,
      deviceIdentity,
    })).toThrow(/credentials/i);
  });

  it("preserves an explicit zero-frame handoff flag from the Gateway", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = rawPublicKey(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    const deviceToken = "paired-device-token";
    const transport = createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken,
      deviceIdentity: { deviceId, publicKeyPem, privateKeyPem },
      webSocketFactory: () => new ProtocolFaithfulFakeGateway(
        { deviceId, deviceToken, publicKeyRaw },
        { code: "AUTHORIZATION_EXPIRED", authorizedHandoffRecorded: false },
      ),
    });

    await expect(transport.invoke("zalouser.bridge.send", { version: 1 })).rejects.toMatchObject({
      code: "AUTHORIZATION_EXPIRED",
      authorizedHandoffRecorded: false,
    });
    await transport.close();
  });

  it("keeps an unspecified Gateway handoff state unknown", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = rawPublicKey(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    const deviceToken = "paired-device-token";
    const transport = createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken,
      deviceIdentity: { deviceId, publicKeyPem, privateKeyPem },
      webSocketFactory: () => new ProtocolFaithfulFakeGateway(
        { deviceId, deviceToken, publicKeyRaw },
        { code: "AUTHORIZATION_EXPIRED" },
      ),
    });

    const error = await transport.invoke("zalouser.bridge.send", { version: 1 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    expect(error).toHaveProperty("authorizedHandoffRecorded", undefined);
    await transport.close();
  });

  it("allows an accepted agent run to finish after the control timeout but caps it at 30 seconds", async () => {
    vi.useFakeTimers();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyRaw = rawPublicKey(publicKeyPem);
    const deviceId = createHash("sha256").update(publicKeyRaw).digest("hex");
    const deviceToken = "paired-device-token";
    const delays = [6_000, 30_001];
    const transport = createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken,
      deviceIdentity: { deviceId, publicKeyPem, privateKeyPem },
      timeoutMs: 5_000,
      webSocketFactory: () => new ProtocolFaithfulFakeGateway(
        { deviceId, deviceToken, publicKeyRaw },
        undefined,
        delays.shift() ?? 0,
      ),
    });

    const withinBound = transport.invoke("agent", { timeout: 30 });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(withinBound).resolves.toMatchObject({ status: "ok" });

    // Force a reconnect so the second request uses the over-bound delayed fixture.
    await transport.close();
    const overBoundTransport = createGatewayCellRpcTransport({
      url: "wss://gateway.internal/openclaw",
      deviceToken,
      deviceIdentity: { deviceId, publicKeyPem, privateKeyPem },
      timeoutMs: 5_000,
      webSocketFactory: () => new ProtocolFaithfulFakeGateway(
        { deviceId, deviceToken, publicKeyRaw },
        undefined,
        30_001,
      ),
    });
    const overBound = overBoundTransport.invoke("agent", { timeout: 30 });
    const overBoundAssertion = expect(overBound).rejects.toMatchObject({ code: "CELL_RPC_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30_000);
    await overBoundAssertion;
    await overBoundTransport.close();
  });
});
