import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  businessFramesFromPayload,
  providerSinkFromPayload,
  type ZaloUserBridgeSendParamsV1,
} from "./canonical-send.js";
import type {
  PreparedPrivateOutboundExecutionV1,
  PrivateOutboundRuntime,
} from "./outbound-rpc.js";
import type {
  InboundBridgeBinding,
  InboundBridgeCommitter,
  InboundBridgeReady,
  ZaloUserInboundEnvelopeV1,
} from "./inbound-listener.js";
import { installInboundBridgeCommitter } from "./inbound-listener.js";
import { installPrivateOutboundRuntime } from "./outbound-rpc.js";
import { installControlRuntime, type ControlRuntime, type ControlTraffic } from "./control-traffic.js";
import { createSignedBridgeRequest, type BridgeRuntimeBindingV1 } from "./protocol.js";
import {
  createPreparedOutboundBatch,
  type PreparedProviderCallV1,
} from "./send-context.js";

type ProviderSender = (
  call: PreparedProviderCallV1,
  materializedMedia?: Buffer,
  preparedSession?: unknown,
) => Promise<{ providerMessageId?: string }>;

export type ProviderRuntime = Readonly<{
  prepareSession(accountProfile: string): unknown | Promise<unknown>;
  send: ProviderSender;
}>;

export async function loadInstalledZaloUserProviderRuntime(): Promise<ProviderRuntime> {
  const module = await import("../send.js");
  if (
    typeof module.prepareZaloProviderSession !== "function" ||
    typeof module.sendPreparedProviderCallZalouser !== "function"
  ) {
    throw failure("PROVIDER_RUNTIME_INVALID", "installed ZaloUser provider runtime is invalid");
  }
  return Object.freeze({
    prepareSession: module.prepareZaloProviderSession,
    send: module.sendPreparedProviderCallZalouser as ProviderSender,
  });
}

export type ProductionBridgeRuntimeOptions = Readonly<{
  binding: BridgeRuntimeBindingV1;
  bridgeBaseUrl: string;
  bridgeSecret: Uint8Array;
  gatewayClientId: string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  nonce(): string;
  loadProviderSender(): Promise<ProviderRuntime>;
}>;

export type ProductionInboundBridgeOptions = Readonly<{
  binding: BridgeRuntimeBindingV1;
  bridgeBaseUrl: string;
  bridgeSecret: Uint8Array;
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): number;
  nonce(): string;
}>;

export type ProductionInboundBridgeInstallation = Readonly<{
  binding: InboundBridgeBinding;
  committer: InboundBridgeCommitter;
  ready: InboundBridgeReady;
  commitTimeoutMs: 6_000;
  readinessTimeoutMs: 2_000;
}>;

export type ProductionControlRuntimeOptions = ProductionInboundBridgeOptions;

const MATERIALIZE_TIMEOUT_MS = 30_000;
const AUTHORIZE_TIMEOUT_MS = 2_000;
const PROVIDER_TIMEOUT_MS = 30_000;
const BRIDGE_SECRET_FILE = "/run/secrets/openclaw_zalo_bridge_hmac";
let installedFromEnvironment = false;

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(code, "invalid response");
  const prototype = Object.getPrototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw failure(code, "response has an invalid shape");
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw failure(code, "response must contain data properties");
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function checkedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new TypeError("bridgeBaseUrl must be a credential-free HTTP(S) origin");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure(code, `${code.toLowerCase()} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function bindingMatches(request: ZaloUserBridgeSendParamsV1, binding: BridgeRuntimeBindingV1): void {
  if (
    request.payload.organizationId !== binding.organizationId ||
    request.payload.accountId !== binding.accountId ||
    request.authorization.authorizationMarker.sessionGeneration !== binding.sessionGeneration ||
    request.authorization.authorizationMarker.fencingToken !== binding.fencingToken ||
    request.authorization.authorizationMarker.controlVersion !== binding.controlVersion ||
    request.authorization.authorizationMarker.takeoverVersion !== binding.takeoverVersion
  ) {
    throw failure("BRIDGE_BINDING_MISMATCH", "send request does not match the installed cell binding");
  }
}

function envelopeBindingMatches(
  envelope: ZaloUserInboundEnvelopeV1,
  binding: BridgeRuntimeBindingV1,
): void {
  if (
    envelope.organizationId !== binding.organizationId ||
    envelope.accountId !== binding.accountId ||
    envelope.cellId !== binding.cellId ||
    envelope.sessionGeneration !== binding.sessionGeneration
  ) {
    throw failure("BRIDGE_BINDING_MISMATCH", "inbound envelope does not match the installed cell binding");
  }
}

async function responseJson(response: Response, code: string): Promise<unknown> {
  if (!response.ok) throw failure(code, `bridge returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw failure(code, "bridge response is not JSON");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 96 * 1024 * 1024) {
    throw failure(code, "bridge response exceeded the byte cap");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw failure(code, "bridge response contains invalid JSON");
  }
}

export function createProductionInboundBridge(
  options: ProductionInboundBridgeOptions,
): ProductionInboundBridgeInstallation {
  const bridgeBaseUrl = checkedBaseUrl(options.bridgeBaseUrl);
  const bridgeSecret = Buffer.from(options.bridgeSecret);
  if (bridgeSecret.byteLength < 32) throw new TypeError("bridgeSecret must contain at least 32 bytes");
  if (typeof options.fetch !== "function" || typeof options.now !== "function" ||
      typeof options.nonce !== "function") {
    throw new TypeError("fetch, now, and nonce must be functions");
  }
  const post = async (path: string, operation: string, body: unknown, timeoutMs: number) => {
    const envelope = createSignedBridgeRequest({
      operation,
      binding: options.binding,
      body,
      secret: bridgeSecret,
      now: options.now(),
      nonce: options.nonce(),
      ttlMs: Math.min(timeoutMs, 5_000),
    });
    return await withTimeout(
      options.fetch(new URL(path, `${bridgeBaseUrl.href}/`).href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        redirect: "error",
      }),
      timeoutMs,
      `${operation.toUpperCase().replaceAll(/[.-]/gu, "_")}_TIMEOUT`,
    );
  };
  const installationBinding = Object.freeze({
    organizationId: options.binding.organizationId,
    cellId: options.binding.cellId,
    sessionGeneration: options.binding.sessionGeneration,
  });
  return Object.freeze({
    binding: installationBinding,
    commitTimeoutMs: 6_000,
    readinessTimeoutMs: 2_000,
    ready: async (accountId, binding) => {
      if (
        accountId !== options.binding.accountId ||
        binding.organizationId !== installationBinding.organizationId ||
        binding.cellId !== installationBinding.cellId ||
        binding.sessionGeneration !== installationBinding.sessionGeneration
      ) {
        throw failure("BRIDGE_BINDING_MISMATCH", "readiness request does not match the cell binding");
      }
      const response = await post(
        "/v1/zalouser/ready",
        "inbound.ready",
        Object.freeze({ version: 1 }),
        2_000,
      );
      const record = exactRecord(
        await responseJson(response, "INBOUND_BRIDGE_UNAVAILABLE"),
        ["version", "status"],
        "INBOUND_BRIDGE_UNAVAILABLE",
      );
      if (record.version !== 1 || record.status !== "READY") {
        throw failure("INBOUND_BRIDGE_UNAVAILABLE", "bridge is not ready for inbound durability");
      }
    },
    committer: async (envelope) => {
      envelopeBindingMatches(envelope, options.binding);
      const response = await post(
        "/v1/zalouser/inbound/commit",
        "inbound.commit",
        envelope,
        6_000,
      );
      return await responseJson(response, "INBOUND_BRIDGE_COMMIT_FAILED");
    },
  });
}

export function createProductionControlRuntime(
  options: ProductionControlRuntimeOptions,
): ControlRuntime {
  const bridgeBaseUrl = checkedBaseUrl(options.bridgeBaseUrl);
  const bridgeSecret = Buffer.from(options.bridgeSecret);
  if (bridgeSecret.byteLength < 32) throw new TypeError("bridgeSecret must contain at least 32 bytes");
  if (typeof options.fetch !== "function" || typeof options.now !== "function" ||
      typeof options.nonce !== "function") {
    throw new TypeError("fetch, now, and nonce must be functions");
  }
  return Object.freeze({
    providerTimeoutMs: 5_000,
    authorize: async (frame: ControlTraffic) => {
      const envelope = createSignedBridgeRequest({
        operation: "control.authorize",
        binding: options.binding,
        body: frame,
        secret: bridgeSecret,
        now: options.now(),
        nonce: options.nonce(),
        ttlMs: 1_000,
      });
      const response = await withTimeout(
        options.fetch(new URL("/v1/zalouser/control/authorize", `${bridgeBaseUrl.href}/`).href, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
          redirect: "error",
        }),
        1_000,
        "CONTROL_AUTHORIZATION_TIMEOUT",
      );
      const record = exactRecord(
        await responseJson(response, "CONTROL_AUTHORIZATION_FAILED"),
        ["version", "status"],
        "CONTROL_AUTHORIZATION_FAILED",
      );
      if (record.version !== 1 || record.status !== "AUTHORIZED") {
        throw failure("CONTROL_AUTHORIZATION_DENIED", "bridge denied control traffic");
      }
    },
  });
}

export function createProductionBridgeRuntime(
  options: ProductionBridgeRuntimeOptions,
): PrivateOutboundRuntime {
  const bridgeBaseUrl = checkedBaseUrl(options.bridgeBaseUrl);
  const bridgeSecret = Buffer.from(options.bridgeSecret);
  if (bridgeSecret.byteLength < 32) throw new TypeError("bridgeSecret must contain at least 32 bytes");
  const gatewayClientId = options.gatewayClientId.trim();
  if (!gatewayClientId) throw new TypeError("gatewayClientId is required");
  if (typeof options.fetch !== "function" || typeof options.now !== "function" ||
      typeof options.nonce !== "function" || typeof options.loadProviderSender !== "function") {
    throw new TypeError("fetch, now, nonce, and loadProviderSender must be functions");
  }

  const post = async (path: string, operation: string, body: unknown, timeoutMs: number) => {
    const envelope = createSignedBridgeRequest({
      operation,
      binding: options.binding,
      body,
      secret: bridgeSecret,
      now: options.now(),
      nonce: options.nonce(),
      ttlMs: Math.min(timeoutMs, 5_000),
    });
    return await withTimeout(
      options.fetch(new URL(path, `${bridgeBaseUrl.href}/`).href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        redirect: "error",
      }),
      timeoutMs,
      `${operation.toUpperCase().replaceAll(/[.-]/gu, "_")}_TIMEOUT`,
    );
  };

  const prepare = async (
    request: ZaloUserBridgeSendParamsV1,
  ): Promise<PreparedPrivateOutboundExecutionV1> => {
    bindingMatches(request, options.binding);
    const sink = providerSinkFromPayload(request.payload);
    const batch = createPreparedOutboundBatch(
      sink,
      businessFramesFromPayload(request.payload),
    );
    const providerRuntime = await options.loadProviderSender();
    if (
      !providerRuntime || typeof providerRuntime !== "object" ||
      typeof providerRuntime.prepareSession !== "function" || typeof providerRuntime.send !== "function"
    ) {
      throw failure("PROVIDER_RUNTIME_INVALID", "provider runtime is invalid");
    }
    const materialized = new Map<number, string>();
    for (const call of batch.calls) {
      if (call.frame.kind !== "media" || !("objectKey" in call.frame)) continue;
      const response = await post(
        "/v1/zalouser/media/materialize",
        "media.materialize",
        Object.freeze({
          version: 1,
          objectKey: call.frame.objectKey,
          sha256: call.frame.sha256,
          mime: call.frame.contentType,
          bytes: call.frame.byteLength,
        }),
        MATERIALIZE_TIMEOUT_MS,
      );
      const record = exactRecord(await responseJson(response, "MEDIA_MATERIALIZE_FAILED"), [
        "version",
        "objectKey",
        "sha256",
        "mime",
        "bytes",
        "contentBase64",
      ], "MEDIA_MATERIALIZE_FAILED");
      if (
        record.version !== 1 || record.objectKey !== call.frame.objectKey ||
        record.sha256 !== call.frame.sha256 || record.mime !== call.frame.contentType ||
        record.bytes !== call.frame.byteLength || typeof record.contentBase64 !== "string"
      ) {
        throw failure("MEDIA_MATERIALIZE_MISMATCH", "materialized media metadata does not match the payload");
      }
      const bytes = Buffer.from(record.contentBase64, "base64");
      if (
        bytes.byteLength !== call.frame.byteLength ||
        bytes.toString("base64") !== record.contentBase64
      ) {
        throw failure("MEDIA_MATERIALIZE_MISMATCH", "materialized media bytes are malformed");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== call.frame.sha256) {
        throw failure("MEDIA_MATERIALIZE_MISMATCH", "materialized media SHA-256 does not match");
      }
      materialized.set(call.frameIndex, record.contentBase64);
    }
    const preparedSession = await withTimeout(
      Promise.resolve(providerRuntime.prepareSession(sink.accountProfile)),
      PROVIDER_TIMEOUT_MS,
      "PROVIDER_SESSION_TIMEOUT",
    );
    if (!preparedSession || typeof preparedSession !== "object") {
      throw failure("PROVIDER_SESSION_INVALID", "provider session preparation returned an invalid capability");
    }
    return Object.freeze({
      batch,
      sendPrepared: async (call) => {
        const encoded = materialized.get(call.frameIndex);
        const media = encoded === undefined ? undefined : Buffer.from(encoded, "base64");
        return await withTimeout(
          providerRuntime.send(call, media, preparedSession),
          PROVIDER_TIMEOUT_MS,
          "PROVIDER_TIMEOUT",
        );
      },
    });
  };

  return Object.freeze({
    assertClient: async (client: unknown) => {
      if (!client || typeof client !== "object" || (client as { id?: unknown }).id !== gatewayClientId) {
        throw failure("PRIVATE_BRIDGE_CLIENT_DENIED", "gateway client is not the dedicated bridge client");
      }
    },
    prepare,
    authorize: async (request) => {
      bindingMatches(request, options.binding);
      const response = await post(
        "/v1/outbox/authorize-send",
        "outbox.authorize-send",
        request.authorization,
        AUTHORIZE_TIMEOUT_MS,
      );
      const record = exactRecord(
        await responseJson(response, "AUTHORIZATION_ERROR"),
        ["version", "status"],
        "AUTHORIZATION_ERROR",
      );
      if (record.version !== 1 || record.status !== "AUTHORIZED") {
        throw failure("AUTHORIZATION_DENIED", "bridge denied the send authorization");
      }
    },
  });
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw failure("BRIDGE_CONFIGURATION_INVALID", `${name} is required`);
  return value;
}

function bridgeSecretFromFixedFile(environment: NodeJS.ProcessEnv): Buffer {
  const configuredPath = environment.OPENCLAW_ZALO_BRIDGE_SECRET_FILE?.trim();
  if (configuredPath && configuredPath !== BRIDGE_SECRET_FILE) {
    throw failure(
      "BRIDGE_CONFIGURATION_INVALID",
      `OPENCLAW_ZALO_BRIDGE_SECRET_FILE must be ${BRIDGE_SECRET_FILE}`,
    );
  }
  const encoded = readFileSync(BRIDGE_SECRET_FILE, "utf8").trim();
  if (!/^[0-9a-f]{64,128}$/u.test(encoded) || encoded.length % 2 !== 0) {
    throw failure("BRIDGE_CONFIGURATION_INVALID", "bridge HMAC secret file is invalid");
  }
  return Buffer.from(encoded, "hex");
}

export function installProductionBridgeRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (installedFromEnvironment) return true;
  const requiredNames = [
    "OPENCLAW_ZALO_BRIDGE_URL",
    "OPENCLAW_ZALO_ORGANIZATION_ID",
    "OPENCLAW_ZALO_ACCOUNT_ID",
    "OPENCLAW_ZALO_CELL_ID",
    "OPENCLAW_ZALO_SESSION_GENERATION",
    "OPENCLAW_ZALO_FENCING_TOKEN",
    "OPENCLAW_ZALO_CONTROL_VERSION",
    "OPENCLAW_ZALO_TAKEOVER_VERSION",
    "OPENCLAW_ZALO_GATEWAY_CLIENT_ID",
  ] as const;
  const configuredCount = requiredNames.reduce(
    (count, name) => count + (environment[name]?.trim() ? 1 : 0),
    environment.OPENCLAW_ZALO_BRIDGE_SECRET_FILE?.trim() ? 1 : 0,
  );
  if (configuredCount === 0) return false;
  if (configuredCount !== requiredNames.length + 1) {
    throw failure("BRIDGE_CONFIGURATION_INVALID", "production bridge configuration is incomplete");
  }
  const sessionGenerationText = requiredEnvironment(
    environment,
    "OPENCLAW_ZALO_SESSION_GENERATION",
  );
  if (!/^[1-9]\d*$/u.test(sessionGenerationText)) {
    throw failure("BRIDGE_CONFIGURATION_INVALID", "OPENCLAW_ZALO_SESSION_GENERATION is invalid");
  }
  const sessionGeneration = Number(sessionGenerationText);
  if (!Number.isSafeInteger(sessionGeneration)) {
    throw failure("BRIDGE_CONFIGURATION_INVALID", "OPENCLAW_ZALO_SESSION_GENERATION is unsafe");
  }
  const versionFromEnvironment = (name: string, minimum: number): number => {
    const text = requiredEnvironment(environment, name);
    if (!/^\d+$/u.test(text)) {
      throw failure("BRIDGE_CONFIGURATION_INVALID", `${name} is invalid`);
    }
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw failure("BRIDGE_CONFIGURATION_INVALID", `${name} is unsafe`);
    }
    return value;
  };
  const binding = Object.freeze({
    organizationId: requiredEnvironment(environment, "OPENCLAW_ZALO_ORGANIZATION_ID"),
    accountId: requiredEnvironment(environment, "OPENCLAW_ZALO_ACCOUNT_ID"),
    cellId: requiredEnvironment(environment, "OPENCLAW_ZALO_CELL_ID"),
    sessionGeneration,
    fencingToken: versionFromEnvironment("OPENCLAW_ZALO_FENCING_TOKEN", 1),
    controlVersion: versionFromEnvironment("OPENCLAW_ZALO_CONTROL_VERSION", 0),
    takeoverVersion: versionFromEnvironment("OPENCLAW_ZALO_TAKEOVER_VERSION", 0),
  });
  const shared = {
    binding,
    bridgeBaseUrl: requiredEnvironment(environment, "OPENCLAW_ZALO_BRIDGE_URL"),
    bridgeSecret: bridgeSecretFromFixedFile(environment),
    fetch: async (url: string, init: RequestInit) => await fetch(url, init),
    now: () => Date.now(),
    nonce: () => randomUUID(),
  } as const;
  const uninstallInbound = installInboundBridgeCommitter(createProductionInboundBridge(shared));
  const uninstallControl = installControlRuntime(createProductionControlRuntime(shared));
  try {
    installPrivateOutboundRuntime(createProductionBridgeRuntime({
      ...shared,
      gatewayClientId: requiredEnvironment(environment, "OPENCLAW_ZALO_GATEWAY_CLIENT_ID"),
      loadProviderSender: loadInstalledZaloUserProviderRuntime,
    }));
  } catch (error) {
    uninstallControl();
    uninstallInbound();
    throw error;
  }
  installedFromEnvironment = true;
  return true;
}
