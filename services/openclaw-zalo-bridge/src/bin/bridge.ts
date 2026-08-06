#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Server } from "node:http";

import {
  closeBridgeServer,
  createBridgeServer,
  listenBridgeServer,
  type BridgeListenAddress,
  type LocalControlTrafficV1,
  type LocalMediaMaterializeRequestV1,
  type LocalMediaMaterializeResponseV1,
} from "../bridge/server.js";
import { createInboundController } from "../bridge/inbound-controller.js";
import type { LocalCellBindingV1 } from "../bridge/local-cell-protocol.js";
import type { ClosableCellRpcTransport } from "../adapters/channel-adapter.js";
import { createGatewayCellRpcTransport } from "../adapters/gateway-client.js";
import {
  evaluateReadiness,
  type Readiness,
} from "../health/snapshot.js";
import { HeartbeatLoop } from "../health/heartbeat.js";
import { runOutboxBatch } from "../outbox/worker.js";
import { PeriodicWorker, runSendWorkBatch } from "../jobs/worker.js";
import { createProductionWorkHandlers } from "../jobs/production-handlers.js";
import { createSpoolDrainWorker, type InboundMediaMappingV1 } from "../spool/drain-worker.js";
import { SqliteSpool, type SpooledEvent } from "../spool/sqlite-spool.js";
import type { CellWorkloadBinding } from "../runtime-api/workload-auth.js";
import {
  createChannelRuntimeClient,
  type ChannelRuntimeClient,
} from "../runtime-api/client.js";
import { createRuntimeCommandHeartbeat } from "../runtime-api/commands.js";
import type { OpenClawSendWorkClaimV1 } from "../runtime-api/schemas.js";
import {
  hashCanonicalSendPayload,
  snapshotCanonicalSendPayload,
  type OutboxAuthorizeSendRequestV1,
} from "../runtime-api/schemas.js";
import { readProtectedSecretFile } from "../security/secret-files.js";
import { prepareBridgeStoragePaths } from "../security/storage-paths.js";
import { cleanupStaleInboundTempFiles } from "../media/temp-cleanup.js";
import {
  createRuntimeInboundMediaProcessor,
  type BrokeredMediaEgress,
} from "../media/runtime-upload.js";
import { redactLogValue } from "../security/redact.js";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8080;
const INLINE_SECRET_NAME = /(?:credential|secret|password|token|api_?key|private_?key|service_?role)/iu;

/**
 * Names that match INLINE_SECRET_NAME but carry no secret.
 *
 * `OPENCLAW_FENCING_TOKEN` is the lease fencing counter - a small monotonic
 * integer, read through `environmentInteger`, and already public in
 * `openclaw_runtime_leases.fencing_token`. It is a "token" only in the
 * distributed-systems sense. Without this exemption the bridge rejected the
 * value the reviewed `compose.cell.yaml` is required to pass it, so the process
 * refused to start at all: the guard and the binding contradicted each other and
 * no test covered the pair.
 *
 * Keep this list to values that are genuinely non-secret AND required inline. A
 * real credential belongs in a `*_FILE` mount.
 */
const NON_SECRET_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "OPENCLAW_FENCING_TOKEN",
]);

export interface BridgeProcessOptions {
  env?: Readonly<Record<string, string | undefined>>;
  readiness?: () => Readiness;
  runtimeOptions?: Omit<BridgeRuntimeOptions, "address">;
  workHandlers?: BridgeWorkHandlers;
  mediaEgress?: BrokeredMediaEgress;
  log?: (line: string) => void;
}

export interface BridgeWorkHandlers {
  runInbound(claim: OpenClawSendWorkClaimV1): Promise<unknown>;
  runSchedule(claim: OpenClawSendWorkClaimV1): Promise<unknown>;
  runCrm(claim: OpenClawSendWorkClaimV1): Promise<unknown>;
  aiAutomaticSendAllowed?(): boolean;
}

interface IntervalScheduler {
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface BridgeRuntimeOptions extends IntervalScheduler {
  address: BridgeListenAddress;
  binding: CellWorkloadBinding;
  localCell?: {
    binding: LocalCellBindingV1;
    secret: Uint8Array;
    authorizeControl?(request: LocalControlTrafficV1): Promise<void>;
    materializeMedia?(request: LocalMediaMaterializeRequestV1): Promise<LocalMediaMaterializeResponseV1>;
  };
  spool: SqliteSpool;
  runtime: ChannelRuntimeClient;
  cellRpc: ClosableCellRpcTransport;
  channelAccountId?: string;
  qrEncryptionKey?: Uint8Array;
  now?: () => number;
  claimToken?: () => string;
  modelProviderHealthy?: () => boolean;
  allowedGeneratedUrlHosts?: readonly string[];
  knownSecretValues?: readonly string[];
  processInboundMedia?: (
    event: SpooledEvent,
    media: readonly InboundMediaMappingV1[],
    signal?: AbortSignal,
  ) => Promise<void>;
  inboundMedia?: {
    gatewayUrl: string;
    allowlistedHosts: readonly string[];
    tempDirectory: string;
    egress: BrokeredMediaEgress;
  };
  workHandlers?: BridgeWorkHandlers;
  channelStatusIntervalMs?: number;
  inboundDrainIntervalMs?: number;
  outboxIntervalMs?: number;
  workIntervalMs?: number;
  workerDrainTimeoutMs?: number;
}

export interface BridgeRuntime {
  readonly server: Server;
  start(): Promise<BridgeListenAddress>;
  stop(): Promise<void>;
  readiness(): Readiness;
}

/** Secrets are file-mounted; accepting an inline value would leak via process inspection. */
export function assertNoInlineSecretEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined && value.length > 0 &&
      INLINE_SECRET_NAME.test(name) && !name.toUpperCase().endsWith("_FILE") &&
      !NON_SECRET_ENVIRONMENT_NAMES.has(name.toUpperCase())
    ) {
      throw new Error(`inline secret environment variable is forbidden: ${name}`);
    }
  }
}

export function readBridgeServerAddress(
  env: Readonly<Record<string, string | undefined>>,
): BridgeListenAddress {
  const configuredHost = env.OPENCLAW_BRIDGE_HOST;
  const host = configuredHost === undefined ? DEFAULT_HOST : configuredHost.trim();
  const hasControlCharacter = [...host].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (host.length === 0 || host.length > 253 || hasControlCharacter) {
    throw new Error("OPENCLAW_BRIDGE_HOST is invalid");
  }

  const configuredPort = env.OPENCLAW_BRIDGE_PORT ?? String(DEFAULT_PORT);
  if (!/^[1-9]\d{0,4}$/.test(configuredPort)) {
    throw new Error("OPENCLAW_BRIDGE_PORT is invalid");
  }
  const port = Number(configuredPort);
  if (port > 65_535) throw new Error("OPENCLAW_BRIDGE_PORT is invalid");

  return { host, port };
}

function failClosedReadiness(): Readiness {
  return {
    inboundReady: false,
    outboundReady: false,
    aiReady: false,
    heartbeatStale: true,
  };
}

function runtimeItems(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("work claim response is invalid");
  }
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || !Array.isArray(response.items)) {
    throw new TypeError("work claim response is invalid");
  }
  return response.items;
}

function zaloUserChannelStatus(value: unknown, accountId: string): { running: boolean; connected: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Gateway channel status is invalid");
  }
  const channelAccounts = (value as Record<string, unknown>).channelAccounts;
  if (!channelAccounts || typeof channelAccounts !== "object" || Array.isArray(channelAccounts)) {
    throw new TypeError("Gateway channel accounts are invalid");
  }
  const accounts = (channelAccounts as Record<string, unknown>).zalouser;
  if (!Array.isArray(accounts)) throw new TypeError("Gateway ZaloUser accounts are invalid");
  const selected = accounts.find((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).accountId === accountId
  ) as Record<string, unknown> | undefined;
  if (selected === undefined) throw new TypeError("Gateway ZaloUser account is missing");
  return { running: selected.running === true, connected: selected.connected === true };
}

export function createBridgeRuntime(options: BridgeRuntimeOptions): BridgeRuntime {
  const now = options.now ?? Date.now;
  const claimToken = options.claimToken ?? (() => crypto.randomUUID());
  const channelAccountId = options.channelAccountId ?? "default";
  if (
    channelAccountId.length === 0 || channelAccountId.length > 128 ||
    channelAccountId !== channelAccountId.trim()
  ) throw new TypeError("OpenClaw channel account ID is invalid");
  const inboundController = createInboundController({ spool: options.spool, binding: options.binding });
  const processInboundMedia = options.processInboundMedia ??
    (options.inboundMedia === undefined ? undefined : createRuntimeInboundMediaProcessor({
      runtime: options.runtime,
      gatewayUrl: options.inboundMedia.gatewayUrl,
      allowlistedHosts: options.inboundMedia.allowlistedHosts,
      tempDirectory: options.inboundMedia.tempDirectory,
      egress: options.inboundMedia.egress,
      checkpoints: options.spool,
      mediaPrefetchAllowed: () => options.spool.pressure().mediaPrefetchAllowed,
    }));
  const drainWorker = createSpoolDrainWorker({
    spool: options.spool,
    runtime: options.runtime,
    now,
    ...(processInboundMedia === undefined ? {} : { processMedia: processInboundMedia }),
  });
  const workHandlers = options.workHandlers ?? createProductionWorkHandlers({
    runtime: options.runtime,
    cellRpc: options.cellRpc,
    now,
    ...(options.allowedGeneratedUrlHosts === undefined
      ? {}
      : { allowedGeneratedUrlHosts: options.allowedGeneratedUrlHosts }),
    ...(options.knownSecretValues === undefined
      ? {}
      : { knownSecretValues: options.knownSecretValues }),
  });

  let channelPaused = true;
  let cellModelProviderHealthy = false;
  let stopping = false;
  let started = false;
  let boundAddress: BridgeListenAddress | null = null;
  let startPromise: Promise<BridgeListenAddress> | null = null;
  let stopPromise: Promise<void> | null = null;
  const modelProviderHealthy = () => cellModelProviderHealthy &&
    (options.modelProviderHealthy?.() ?? true) &&
    (workHandlers.aiAutomaticSendAllowed?.() ?? true);
  const commandHeartbeat = createRuntimeCommandHeartbeat({
    runtime: options.runtime,
    cellRpc: options.cellRpc,
    binding: options.binding,
    spool: options.spool,
    channelAccountId,
    commandClaimToken: claimToken(),
    now,
    healthSignal: () => {
      const pressure = options.spool.pressure();
      const gap = options.spool.gapEvidence();
      if (pressure.ready && gap === null) return null;
      return {
        severity: "CRITICAL",
        healthKind: "INBOUND_INTAKE_STOPPED",
        status: "OPEN",
        fingerprint: "inbound-intake-stopped",
        contentFreeMetrics: {
          gapActive: gap !== null,
          pressureLevel: pressure.level,
        },
      };
    },
    ...(options.qrEncryptionKey === undefined ? {} : { qrEncryptionKey: options.qrEncryptionKey }),
  });

  const heartbeat = new HeartbeatLoop({
    send: async () => {
      await commandHeartbeat.pulse();
    },
    now,
    setInterval: options.setInterval,
    clearInterval: options.clearInterval,
  });

  const readiness = (): Readiness => {
    if (stopping) return failClosedReadiness();
    const snapshot = heartbeat.snapshot();
    let spoolReady = false;
    let spoolOutboundAllowed = false;
    try {
      const pressure = options.spool.pressure();
      spoolReady = inboundController.ready();
      spoolOutboundAllowed = pressure.outboundAllowed;
    } catch {
      spoolReady = false;
      spoolOutboundAllowed = false;
    }
    return evaluateReadiness({
      spoolReady,
      channelPaused: channelPaused || !spoolOutboundAllowed,
      runtimeTokenValid: snapshot.lastSuccessAtMs !== null,
      modelProviderHealthy: modelProviderHealthy(),
      lastHeartbeatAtMs: snapshot.lastSuccessAtMs,
      nowMs: now(),
    });
  };

  const authorizeSend = async (authorization: OutboxAuthorizeSendRequestV1): Promise<void> => {
    const value = await options.runtime.post("/v1/outbox/authorize-send", authorization);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Runtime send authorization is invalid");
    }
    const result = value as Record<string, unknown>;
    const marker = authorization.authorizationMarker;
    const expectedKeys = [
      "version", "outboxId", "authorizationId", "state", "authorizedHandoffAt",
      "canonicalPayload", "payloadHash",
    ].sort();
    const keys = Object.keys(result).sort();
    const canonicalPayload = snapshotCanonicalSendPayload(result.canonicalPayload);
    if (
      keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]) ||
      result.version !== 1 || result.outboxId !== marker.outboxId || result.state !== "DISPATCHING" ||
      result.payloadHash !== marker.payloadHash ||
      hashCanonicalSendPayload(canonicalPayload) !== marker.payloadHash ||
      typeof result.authorizationId !== "string" ||
      typeof result.authorizedHandoffAt !== "string" ||
      !Number.isFinite(Date.parse(result.authorizedHandoffAt))
    ) throw new TypeError("Runtime send authorization is invalid");
  };
  const server = createBridgeServer({
    readiness,
    ...(options.localCell === undefined ? {} : {
      localCell: {
        secret: options.localCell.secret,
        binding: options.localCell.binding,
        inbound: inboundController,
        authorizeSend,
        authorizeControl: options.localCell.authorizeControl ?? (async () => undefined),
        ...(options.localCell.materializeMedia === undefined
          ? {}
          : { materializeMedia: options.localCell.materializeMedia }),
        now,
      },
    }),
  });

  const scheduler = {
    ...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
    ...(options.clearInterval === undefined ? {} : { clearInterval: options.clearInterval }),
  };
  const workerDrain = options.workerDrainTimeoutMs === undefined
    ? {}
    : { drainTimeoutMs: options.workerDrainTimeoutMs };
  const statusWorker = new PeriodicWorker({
    ...scheduler,
    ...workerDrain,
    intervalMs: options.channelStatusIntervalMs ?? 10_000,
    run: async () => {
      try {
        const value = await options.cellRpc.invoke("channels.status", {
          probe: true,
          timeoutMs: 5_000,
          channel: "zalouser",
        });
        const status = zaloUserChannelStatus(value, channelAccountId);
        if (!inboundController.ready()) {
          channelPaused = true;
          if (status.running) {
            await options.cellRpc.invoke("channels.stop", {
              channel: "zalouser",
              accountId: channelAccountId,
            });
          }
          return;
        }
        channelPaused = !status.running || !status.connected;
        cellModelProviderHealthy = !channelPaused;
      } catch {
        channelPaused = true;
        cellModelProviderHealthy = false;
      }
    },
  });
  const inboundWorker = new PeriodicWorker({
    ...scheduler,
    ...workerDrain,
    intervalMs: options.inboundDrainIntervalMs ?? 1_000,
    run: async (signal) => {
      await drainWorker.drainOnce(signal);
    },
  });
  const outboxWorker = new PeriodicWorker({
    ...scheduler,
    ...workerDrain,
    intervalMs: options.outboxIntervalMs ?? 1_000,
    run: async () => {
      if (!readiness().outboundReady) return;
      await runOutboxBatch({
        runtime: options.runtime,
        cellRpc: options.cellRpc,
        claimToken,
        now: () => new Date(now()),
        retryNotBefore: () => new Date(now() + 5_000).toISOString(),
        limit: 10,
      });
    },
  });
  const workWorker = new PeriodicWorker({
        ...scheduler,
    ...workerDrain,
    intervalMs: options.workIntervalMs ?? 1_000,
    run: async () => {
          const ready = readiness();
          if (!ready.outboundReady) return;
          await runSendWorkBatch({
            claimWork: async (request) => runtimeItems(
              await options.runtime.post("/v1/work/claim", request),
            ),
            claimToken,
            runInbound: workHandlers.runInbound,
            runSchedule: workHandlers.runSchedule,
            runCrm: workHandlers.runCrm,
            requestedKinds: ready.aiReady
              ? ["INBOUND_AUTOMATION", "SCHEDULE_OCCURRENCE", "CRM_EVENT"]
              : ["SCHEDULE_OCCURRENCE", "CRM_EVENT"],
            // The approved low-tier production profile permits one send-work
            // execution at a time. The queue absorbs bursts; the bridge must
            // not silently raise AI/media/outbox pressure by fanning out here.
            concurrency: 1,
          });
        },
      });
  const periodic = [statusWorker, inboundWorker, outboxWorker, workWorker];

  return Object.freeze({
    server,
    readiness,
    async start(): Promise<BridgeListenAddress> {
      if (startPromise !== null) return await startPromise;
      startPromise = (async () => {
        if (started && boundAddress !== null) return boundAddress;
        if (stopping) throw new Error("bridge runtime is stopping");
        boundAddress = await listenBridgeServer(server, options.address);
        started = true;
        // Establish token/channel state before any outbound claim. Inbound
        // draining remains independent so a control-plane outage keeps local
        // durability rather than enabling a send path.
        await Promise.allSettled([heartbeat.pulse(), statusWorker.pulse()]);
        await Promise.allSettled([
          inboundWorker.pulse(),
          outboxWorker.pulse(),
          workWorker.pulse(),
        ]);
        heartbeat.start();
        for (const worker of periodic) worker.start();
        return boundAddress;
      })();
      return await startPromise;
    },
    async stop(): Promise<void> {
      if (stopPromise !== null) return await stopPromise;
      stopping = true;
      stopPromise = (async () => {
        heartbeat.stop();
        commandHeartbeat.stop();
        const serverClosing = closeBridgeServer(server);
        await Promise.all(periodic.map((worker) => worker.stop()));
        await serverClosing;
        await heartbeat.settle();
        await commandHeartbeat.settle();
        const finalizeDependencies = async (): Promise<void> => {
          await Promise.allSettled([
            options.runtime.close?.(),
            options.cellRpc.close?.(),
          ]);
          options.spool.close();
        };
        if (periodic.every((worker) => worker.isSettled())) {
          await finalizeDependencies();
        } else {
          void Promise.all(periodic.map((worker) => worker.settle()))
            .then(finalizeDependencies)
            .catch(() => undefined);
        }
      })();
      return await stopPromise;
    },
  });
}

function requiredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (value === undefined || value.length === 0 || value !== value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function environmentInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number {
  const value = requiredEnvironment(env, name);
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is invalid`);
  return parsed;
}

function mediaAllowlistedHosts(env: Readonly<Record<string, string | undefined>>): string[] {
  const value = requiredEnvironment(env, "OPENCLAW_MEDIA_ALLOWLIST");
  const hosts = value.split(",");
  if (
    hosts.length === 0 || hosts.some((host) =>
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host)
    )
  ) throw new Error("OPENCLAW_MEDIA_ALLOWLIST is invalid");
  return hosts;
}

function gatewayDeviceIdentity(value: string): {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Gateway device identity is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Gateway device identity is invalid");
  }
  const identity = parsed as Record<string, unknown>;
  if (
    Object.keys(identity).sort().join(",") !== "deviceId,privateKeyPem,publicKeyPem" ||
    typeof identity.deviceId !== "string" || typeof identity.publicKeyPem !== "string" ||
    typeof identity.privateKeyPem !== "string"
  ) throw new Error("Gateway device identity is invalid");
  return {
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
  };
}

/**
 * Hosts a proxy bypass may name: the stack's own service aliases and loopback.
 *
 * They are on the `internal: true` application network and have no external
 * route, so naming them in NO_PROXY cannot exfiltrate anything. Everything else -
 * every real destination, including the media gateway - must still go through the
 * egress broker, which is the property this check exists to protect.
 */
const INTRA_STACK_PROXY_BYPASS: ReadonlySet<string> = new Set([
  "localhost", "127.0.0.1", "::1", "cell", "bridge", "maintenance", "egress-broker",
]);

/**
 * Rejects a proxy bypass that would let a real destination skip the broker.
 *
 * This replaces a flat "NO_PROXY must be empty". That rule was unsatisfiable in
 * production: the reviewed `compose.cell.yaml` must set
 * `NO_PROXY=localhost,127.0.0.1,::1,cell,bridge,maintenance,egress-broker`, because
 * the bridge talks to the cell at `ws://cell:18789` and proxying `egress-broker`
 * through itself is a loop. Two committed test suites asserted the opposite of each
 * other - `infra/openclaw-zalo/test/compose-contract.test.ts` demanded those entries,
 * this file's test demanded none - and both passed, because nothing ever started the
 * bridge with the compose file's environment. The bridge could not boot at all.
 */
export function assertNoExternalProxyBypass(
  env: Readonly<Record<string, string | undefined>>,
): void {
  for (const name of ["NO_PROXY", "no_proxy"] as const) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    for (const entry of raw.split(",")) {
      const host = entry.trim().toLowerCase();
      if (host === "") continue;
      if (!INTRA_STACK_PROXY_BYPASS.has(host)) {
        throw new Error(`${name} may only bypass the stack's own hosts: ${entry.trim()}`);
      }
    }
  }
}

export function createBrokeredMediaEgressFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  request: typeof globalThis.fetch = globalThis.fetch,
): BrokeredMediaEgress {
  if (env.NODE_USE_ENV_PROXY !== "1") {
    throw new Error("NODE_USE_ENV_PROXY=1 is required for brokered media egress");
  }
  assertNoExternalProxyBypass(env);
  const rawProxy = env.HTTPS_PROXY;
  if (rawProxy === undefined || rawProxy.length === 0 || rawProxy !== rawProxy.trim()) {
    throw new Error("HTTPS_PROXY is required for brokered media egress");
  }
  let proxy: URL;
  try {
    proxy = new URL(rawProxy);
  } catch {
    throw new Error("HTTPS_PROXY is invalid");
  }
  if (
    proxy.protocol !== "http:" || proxy.username || proxy.password ||
    proxy.pathname !== "/" || proxy.search || proxy.hash || proxy.port === "" ||
    proxy.hostname === "localhost" || proxy.hostname.endsWith(".localhost") ||
    /^\d+(?:\.\d+){3}$/u.test(proxy.hostname)
  ) throw new Error("HTTPS_PROXY is invalid");
  return Object.freeze({
    async fetch(url: URL, init?: RequestInit): Promise<Response> {
      return await request(url, init);
    },
  });
}

export async function createBridgeRuntimeFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  address = readBridgeServerAddress(env),
  workHandlers?: BridgeWorkHandlers,
  mediaEgress?: BrokeredMediaEgress,
): Promise<BridgeRuntime> {
  const effectiveMediaEgress = mediaEgress ?? createBrokeredMediaEgressFromEnvironment(env);
  const runtimeCredentialFile = env.OPENCLAW_RUNTIME_CREDENTIAL_FILE ??
    "/run/secrets/openclaw_runtime_credential";
  const localCellSecretFile = env.OPENCLAW_ZALO_BRIDGE_SECRET_FILE ??
    "/run/secrets/openclaw_zalo_bridge_hmac";
  const gatewayDeviceTokenFile = env.OPENCLAW_GATEWAY_DEVICE_TOKEN_FILE ??
    "/run/secrets/openclaw_gateway_device_token";
  const gatewayDeviceIdentityFile = env.OPENCLAW_GATEWAY_DEVICE_IDENTITY_FILE ??
    "/run/secrets/openclaw_gateway_device_identity";
  const qrEncryptionKeyFile = requiredEnvironment(env, "OPENCLAW_QR_ENCRYPTION_KEY_FILE");
  const [
    credential,
    localCellSecretHex,
    gatewayDeviceToken,
    gatewayIdentityValue,
    qrEncryptionKeyValue,
  ] = await Promise.all([
    readProtectedSecretFile(runtimeCredentialFile),
    readProtectedSecretFile(localCellSecretFile),
    readProtectedSecretFile(gatewayDeviceTokenFile),
    readProtectedSecretFile(gatewayDeviceIdentityFile),
    readProtectedSecretFile(qrEncryptionKeyFile),
  ]);
  const binding: CellWorkloadBinding = {
    organizationId: requiredEnvironment(env, "OPENCLAW_ORGANIZATION_ID"),
    accountId: requiredEnvironment(env, "OPENCLAW_ACCOUNT_ID"),
    cellId: requiredEnvironment(env, "OPENCLAW_CELL_ID"),
    sessionGeneration: environmentInteger(env, "OPENCLAW_SESSION_GENERATION"),
    fencingToken: environmentInteger(env, "OPENCLAW_FENCING_TOKEN"),
  };
  const localCellBinding: LocalCellBindingV1 = {
    ...binding,
    controlVersion: environmentInteger(env, "OPENCLAW_CONTROL_VERSION"),
    takeoverVersion: environmentInteger(env, "OPENCLAW_TAKEOVER_VERSION"),
  };
  if (!/^[0-9a-f]{64,128}$/u.test(localCellSecretHex) || localCellSecretHex.length % 2 !== 0) {
    throw new Error("OPENCLAW_ZALO_BRIDGE_SECRET_FILE is invalid");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(qrEncryptionKeyValue)) {
    throw new Error("OPENCLAW_QR_ENCRYPTION_KEY_FILE is invalid");
  }
  const qrEncryptionKey = Buffer.from(qrEncryptionKeyValue, "base64");
  if (
    qrEncryptionKey.byteLength !== 32 ||
    qrEncryptionKey.toString("base64") !== qrEncryptionKeyValue
  ) throw new Error("OPENCLAW_QR_ENCRYPTION_KEY_FILE is invalid");
  const gatewayIdentity = gatewayDeviceIdentity(gatewayIdentityValue);
  const storage = await prepareBridgeStoragePaths({
    dataDirectory: env.OPENCLAW_DATA_DIRECTORY ?? "/var/lib/openclaw-bridge",
    spoolPath: env.OPENCLAW_SPOOL_PATH ?? "/var/lib/openclaw-bridge/spool.db",
    tempDirectory: env.OPENCLAW_MEDIA_TEMP_DIRECTORY ?? "/var/lib/openclaw-bridge/temp",
  });
  const { spoolPath, tempDirectory } = storage;
  await cleanupStaleInboundTempFiles({ directory: tempDirectory, maxAgeMs: 0 });
  const spool = new SqliteSpool(spoolPath);
  try {
    const runtime = createChannelRuntimeClient({
      functionsBaseUrl: requiredEnvironment(env, "OPENCLAW_FUNCTIONS_BASE_URL"),
      organizationId: binding.organizationId,
      accountId: binding.accountId,
      cellId: binding.cellId,
      sessionGeneration: binding.sessionGeneration,
      fencingToken: binding.fencingToken,
      credential,
    });
    const cellRpc = createGatewayCellRpcTransport({
      url: requiredEnvironment(env, "OPENCLAW_GATEWAY_URL"),
      deviceToken: gatewayDeviceToken,
      deviceIdentity: gatewayIdentity,
    });
    return createBridgeRuntime({
      address,
      binding,
      localCell: {
        binding: localCellBinding,
        secret: Buffer.from(localCellSecretHex, "hex"),
      },
      spool,
      runtime,
      cellRpc,
      channelAccountId: env.OPENCLAW_CHANNEL_ACCOUNT_ID ?? "default",
      qrEncryptionKey,
      knownSecretValues: [
        credential,
        localCellSecretHex,
        gatewayDeviceToken,
        gatewayIdentity.privateKeyPem,
        qrEncryptionKeyValue,
      ],
      inboundMedia: {
        gatewayUrl: requiredEnvironment(env, "OPENCLAW_MEDIA_GATEWAY_URL"),
        allowlistedHosts: mediaAllowlistedHosts(env),
        tempDirectory,
        egress: effectiveMediaEgress,
      },
      ...(workHandlers === undefined ? {} : { workHandlers }),
    });
  } catch (error) {
    spool.close();
    throw error;
  }
}

export async function startBridgeProcess(options: BridgeProcessOptions = {}) {
  const env = options.env ?? process.env;
  assertNoInlineSecretEnvironment(env);
  const address = readBridgeServerAddress(env);
  if (options.readiness !== undefined && options.runtimeOptions === undefined) {
    const server = createBridgeServer({ readiness: options.readiness });
    const bound = await listenBridgeServer(server, address);
    options.log?.(JSON.stringify({ event: "bridge_listening", ...bound }));
    return {
      server,
      address: bound,
      stop: async () => await closeBridgeServer(server),
    };
  }
  const runtime = options.runtimeOptions === undefined
    ? await createBridgeRuntimeFromEnvironment(
      env,
      address,
      options.workHandlers,
      options.mediaEgress,
    )
    : createBridgeRuntime({ address, ...options.runtimeOptions });
  let bound: BridgeListenAddress;
  try {
    bound = await runtime.start();
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    throw error;
  }
  options.log?.(JSON.stringify({ event: "bridge_listening", ...bound }));
  return { server: runtime.server, address: bound, stop: runtime.stop, runtime };
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && resolve(invoked) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
  void startBridgeProcess({ log: console.log }).then(({ stop: stopRuntime }) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void stopRuntime().then(
        () => {
          process.exitCode = 0;
        },
        () => {
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }, (error: unknown) => {
    console.error(JSON.stringify({
      event: "bridge_start_failed",
      error: redactLogValue(error),
    }));
    process.exitCode = 1;
  });
}
