import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

import { CellRpcError, type ClosableCellRpcTransport } from "./channel-adapter.js";

const PROTOCOL_VERSION = 4;
const CLIENT_ID = "gateway-client";
const CLIENT_MODE = "backend";
const CLIENT_ROLE = "operator";
const CLIENT_SCOPES = ["operator.admin"] as const;
const AGENT_FINAL_TIMEOUT_MS = 30_000;
const ALLOWED_METHODS = new Set([
  "channels.status",
  "channels.start",
  "channels.stop",
  "channels.logout",
  "web.login.start",
  "web.login.wait",
  "agent",
  "zalouser.bridge.send",
]);
const INTENTIONALLY_UNADVERTISED_METHODS = new Set(["web.login.start", "web.login.wait"]);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface GatewayWebSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface GatewayDeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface GatewayCellRpcTransportOptions {
  url: string;
  deviceToken: string;
  deviceIdentity: GatewayDeviceIdentity;
  webSocketFactory?: (url: string) => GatewayWebSocket;
  now?: () => number;
  timeoutMs?: number;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  expectFinal: boolean;
  acceptedRunId?: string;
};

/**
 * Cell-side service aliases on the stack's `internal: true` network.
 *
 * Docker gives that network no route off the host, so a plaintext hop to one of
 * these names cannot leave the machine, and there is no third party on the path
 * to intercept it. Every other destination still has to be `wss:`.
 */
const INTRA_STACK_GATEWAY_HOSTS: ReadonlySet<string> = new Set(["cell", "localhost", "127.0.0.1"]);

/**
 * The gateway endpoint, TLS-only except for the stack's own internal hop.
 *
 * `wss:` keeps its full shape check (no port, no credentials, no query). The
 * `ws:` exception exists because the reviewed `compose.cell.yaml` runs the cell
 * gateway plaintext at `ws://cell:18789` on an internal-only network, while this
 * client's tests only ever used `wss://gateway.internal/openclaw` - so the bridge
 * refused to start against the infrastructure it ships with. A port is allowed
 * only on that internal path, since 18789 is the gateway's real port.
 */
function gatewayUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Gateway URL must use TLS without embedded credentials");
  }
  if (url.protocol === "ws:" && INTRA_STACK_GATEWAY_HOSTS.has(url.hostname)) return url;
  if (url.protocol !== "wss:" || url.port !== "") {
    throw new TypeError("Gateway URL must use TLS without embedded credentials");
  }
  return url;
}

function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    der.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32 ||
    !der.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)
  ) throw new TypeError("Gateway device public key is invalid");
  return der.subarray(ED25519_SPKI_PREFIX.byteLength);
}

function validatedIdentity(identity: GatewayDeviceIdentity): GatewayDeviceIdentity & { publicKey: string } {
  const publicKeyRaw = rawPublicKey(identity.publicKeyPem);
  const derivedId = createHash("sha256").update(publicKeyRaw).digest("hex");
  if (identity.deviceId !== derivedId) throw new TypeError("Gateway device identity is invalid");
  const probe = Buffer.from("openclaw-zalo-bridge-device-check", "utf8");
  const signature = sign(null, probe, createPrivateKey(identity.privateKeyPem));
  if (!verify(null, probe, createPublicKey(identity.publicKeyPem), signature)) {
    throw new TypeError("Gateway device identity is invalid");
  }
  return { ...identity, publicKey: publicKeyRaw.toString("base64url") };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function deviceAuthPayload(options: {
  deviceId: string;
  signedAt: number;
  deviceToken: string;
  nonce: string;
}): string {
  return [
    "v3",
    options.deviceId,
    CLIENT_ID,
    CLIENT_MODE,
    CLIENT_ROLE,
    CLIENT_SCOPES.join(","),
    String(options.signedAt),
    options.deviceToken,
    options.nonce,
    process.platform.toLowerCase(),
    "",
  ].join("|");
}

export function createGatewayCellRpcTransport(
  options: GatewayCellRpcTransportOptions,
): ClosableCellRpcTransport {
  const url = gatewayUrl(options.url);
  const token = options.deviceToken;
  if (token.length < 16 || token !== token.trim()) {
    throw new TypeError("Gateway device credential is invalid");
  }
  const identity = validatedIdentity(options.deviceIdentity);
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new RangeError("Gateway request timeout is invalid");
  }
  const now = options.now ?? Date.now;
  const socketFactory = options.webSocketFactory ?? ((value: string) => new WebSocket(value));
  const pending = new Map<string, PendingRequest>();
  let socket: GatewayWebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let connected = false;
  let closed = false;
  let advertisedMethods = new Set<string>();

  const rejectAll = (error: unknown): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const activeSocket = socket;
    if (activeSocket === null || activeSocket.readyState !== 1) {
      return Promise.reject(new CellRpcError("CELL_RPC_TRANSPORT_FAILED", { preHandoff: true }));
    }
    const id = crypto.randomUUID();
    const parameterRecord = record(params);
    const methodTimeout = method === "agent"
      ? AGENT_FINAL_TIMEOUT_MS
      : (method === "web.login.start" || method === "web.login.wait") &&
        typeof parameterRecord?.timeoutMs === "number" &&
        Number.isSafeInteger(parameterRecord.timeoutMs) && parameterRecord.timeoutMs >= 0
      ? Math.min(130_000, Math.max(timeoutMs, parameterRecord.timeoutMs + 1_000))
      : timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CellRpcError("CELL_RPC_TIMEOUT"));
      }, methodTimeout);
      pending.set(id, { resolve, reject, timer, expectFinal: method === "agent" });
      try {
        activeSocket.send(JSON.stringify({ type: "req", id, method, params }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        reject(new CellRpcError("CELL_RPC_TRANSPORT_FAILED", { preHandoff: true }));
      }
    });
  };

  const connect = (): Promise<void> => {
    if (connected && socket?.readyState === 1) return Promise.resolve();
    if (connectPromise !== null) return connectPromise;
    let attemptSocket: GatewayWebSocket | null = null;
    const attempt = new Promise<void>((resolve, reject) => {
      let settled = false;
      let challengeHandled = false;
      const connectTimer = setTimeout(() => {
        fail(new CellRpcError("CELL_RPC_TIMEOUT", { preHandoff: true }));
        socket?.close(1000, "Gateway handshake timed out");
      }, timeoutMs);
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(error);
      };
      try {
        attemptSocket = socketFactory(url.href);
        socket = attemptSocket;
      } catch {
        clearTimeout(connectTimer);
        fail(new CellRpcError("CELL_RPC_TRANSPORT_FAILED", { preHandoff: true }));
        return;
      }
      const activeSocket = attemptSocket;
      activeSocket.addEventListener("message", (event) => {
        if (socket !== activeSocket) return;
        let frame: Record<string, unknown> | null = null;
        try {
          frame = record(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          frame = null;
        }
        if (frame === null) {
          fail(new CellRpcError("CELL_RPC_RESPONSE_INVALID", { preHandoff: true }));
          return;
        }
        if (frame.type === "event" && frame.event === "connect.challenge") {
          if (challengeHandled) {
            fail(new CellRpcError("CELL_RPC_RESPONSE_INVALID", { preHandoff: true }));
            return;
          }
          challengeHandled = true;
          const challenge = record(frame.payload);
          const nonce = challenge?.nonce;
          const signedAt = now();
          if (
            typeof nonce !== "string" || nonce.length === 0 || nonce.length > 512 ||
            !Number.isSafeInteger(signedAt) || signedAt < 0
          ) {
            fail(new CellRpcError("CELL_RPC_RESPONSE_INVALID", { preHandoff: true }));
            return;
          }
          const signature = sign(
            null,
            Buffer.from(deviceAuthPayload({
              deviceId: identity.deviceId,
              signedAt,
              deviceToken: token,
              nonce,
            }), "utf8"),
            createPrivateKey(identity.privateKeyPem),
          ).toString("base64url");
          void sendRequest("connect", {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: CLIENT_ID,
              version: "0.1.0",
              platform: process.platform,
              mode: CLIENT_MODE,
              instanceId: "openclaw-zalo-bridge",
            },
            caps: [],
            commands: [],
            role: CLIENT_ROLE,
            scopes: [...CLIENT_SCOPES],
            device: {
              id: identity.deviceId,
              publicKey: identity.publicKey,
              signature,
              signedAt,
              nonce,
            },
            // The Gateway secret is presented as `token`, not `deviceToken`.
            //
            // `deviceToken` selects the "explicit-device-token" candidate, which the
            // Gateway matches against a token it minted for an already-paired device.
            // The value provisioned at `/run/secrets/openclaw_gateway_device_token` is
            // the Gateway's own auth token, so that path answered
            // `device_token_mismatch` on every connect and the cell was unreachable.
            // Measured against the 2026.7.1 Gateway: with `token`, the same secret plus
            // the device signature returns `hello-ok`.
            //
            // This is not weaker. The Gateway still verifies the Ed25519 signature over
            // the device payload and still refuses a device that is not paired and
            // approved - an unpaired device gets `PAIRING_REQUIRED`, not a session.
            auth: { token },
          }).then((helloValue) => {
            const hello = record(helloValue);
            const auth = record(hello?.auth);
            const features = record(hello?.features);
            if (
              hello?.type !== "hello-ok" || hello.protocol !== PROTOCOL_VERSION ||
              auth?.role !== CLIENT_ROLE || !Array.isArray(auth.scopes) ||
              !auth.scopes.includes("operator.admin") || !Array.isArray(features?.methods)
            ) {
              fail(new CellRpcError("CELL_RPC_RESPONSE_INVALID", { preHandoff: true }));
              return;
            }
            advertisedMethods = new Set(features.methods.filter((value): value is string =>
              typeof value === "string"));
            connected = true;
            settled = true;
            clearTimeout(connectTimer);
            resolve();
          }, fail);
          return;
        }
        if (frame.type !== "res" || typeof frame.id !== "string") return;
        const request = pending.get(frame.id);
        if (request === undefined) return;
        if (frame.ok === true && request.expectFinal) {
          const payload = record(frame.payload);
          if (payload?.status === "accepted") {
            const runId = payload.runId;
            if (
              request.acceptedRunId !== undefined || typeof runId !== "string" || runId.length === 0
            ) {
              pending.delete(frame.id);
              clearTimeout(request.timer);
              request.reject(new CellRpcError("CELL_RPC_RESPONSE_INVALID"));
              return;
            }
            request.acceptedRunId = runId;
            return;
          }
          if (request.acceptedRunId !== undefined && payload?.runId !== request.acceptedRunId) {
            pending.delete(frame.id);
            clearTimeout(request.timer);
            request.reject(new CellRpcError("CELL_RPC_RESPONSE_INVALID"));
            return;
          }
        }
        pending.delete(frame.id);
        clearTimeout(request.timer);
        if (frame.ok === true) request.resolve(frame.payload);
        else {
          const error = record(frame.error);
          const payload = record(frame.payload);
          const code = typeof error?.code === "string" && error.code.length <= 128
            ? error.code
            : "CELL_RPC_REJECTED";
          const preHandoff = error?.authorizedHandoffRecorded === false ||
            payload?.authorizedHandoffRecorded === false;
          request.reject(new CellRpcError(code, { preHandoff }));
        }
      });
      activeSocket.addEventListener("close", () => {
        if (socket !== activeSocket) return;
        connected = false;
        socket = null;
        connectPromise = null;
        advertisedMethods = new Set<string>();
        clearTimeout(connectTimer);
        const error = new CellRpcError("CELL_RPC_CLOSED");
        rejectAll(error);
        fail(error);
      });
      activeSocket.addEventListener("error", () => {
        if (socket !== activeSocket) return;
        connected = false;
        const error = new CellRpcError("CELL_RPC_TRANSPORT_FAILED", { preHandoff: true });
        rejectAll(error);
        fail(error);
        activeSocket.close(1000, "Gateway transport failed");
      });
    });
    connectPromise = attempt;
    void attempt.catch(() => {
      if (connectPromise === attempt) connectPromise = null;
      if (socket === attemptSocket) {
        connected = false;
        socket = null;
        advertisedMethods = new Set<string>();
      }
    });
    return attempt;
  };

  return Object.freeze({
    async invoke(method: string, params: unknown): Promise<unknown> {
      if (closed) throw new CellRpcError("CELL_RPC_CLOSED", { preHandoff: true });
      if (!ALLOWED_METHODS.has(method)) {
        throw new CellRpcError("CELL_RPC_METHOD_INVALID", { preHandoff: true });
      }
      await connect();
      if (!connected || (!advertisedMethods.has(method) && !INTENTIONALLY_UNADVERTISED_METHODS.has(method))) {
        throw new CellRpcError("CELL_RPC_METHOD_UNAVAILABLE", { preHandoff: true });
      }
      return await sendRequest(method, params);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      connected = false;
      rejectAll(new CellRpcError("CELL_RPC_CLOSED"));
      socket?.close(1000, "Bridge shutting down");
      socket = null;
    },
  });
}
