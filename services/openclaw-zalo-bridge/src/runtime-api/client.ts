import { createHash } from "node:crypto";

import { canonicalJson } from "../spool/checksum.js";

export type RuntimeClientStage = "TOKEN_EXCHANGE" | "RUNTIME_REQUEST";

export class RuntimeApiError extends Error {
  readonly stage: RuntimeClientStage;
  readonly status: number | null;

  constructor(stage: RuntimeClientStage, status: number | null, message: string) {
    super(message);
    this.name = "RuntimeApiError";
    this.stage = stage;
    this.status = status;
  }
}

export interface ChannelRuntimeClientOptions {
  functionsBaseUrl: string;
  organizationId: string;
  accountId: string;
  cellId: string;
  sessionGeneration: number;
  fencingToken: number;
  credential: string;
  fetch?: typeof globalThis.fetch;
  nowEpochSeconds?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
}

export interface ChannelRuntimeClient {
  post<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  localSessionGeneration(): number;
  adoptSessionGeneration(generation: number): void;
  close(): Promise<void>;
}

export const CHANNEL_RUNTIME_PATHS = Object.freeze([
  "/v1/heartbeat",
  "/v1/qr/publish",
  "/v1/qr/result",
  "/v1/inbound/batch",
  "/v1/outbox/claim",
  "/v1/outbox/preflight",
  "/v1/outbox/authorize-send",
  "/v1/outbox/requeue",
  "/v1/outbox/complete",
  "/v1/work/claim",
  "/v1/work/context",
  "/v1/work/complete",
  "/v1/work/create-outbox",
  "/v1/media/upload-ticket",
  "/v1/media/upload-complete",
] as const);
const TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;
const RUNTIME_RESPONSE_MAX_BYTES = 256 * 1024;
const WORK_CONTEXT_RESPONSE_MAX_BYTES = 512 * 1024;

function functionsOrigin(value: string): URL {
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    !url.pathname.endsWith("/functions/v1/")
  ) {
    throw new TypeError("functionsBaseUrl must be an exact HTTPS Supabase functions URL");
  }
  return url;
}

function runtimePath(value: string): string {
  if (!(CHANNEL_RUNTIME_PATHS as readonly string[]).includes(value)) {
    throw new TypeError("runtime path is invalid");
  }
  return value;
}

function responseResult(value: unknown, stage: RuntimeClientStage): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeApiError(stage, null, `${stage.toLowerCase()} returned an invalid envelope`);
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1 || !("result" in envelope)) {
    throw new RuntimeApiError(stage, null, `${stage.toLowerCase()} returned an invalid envelope`);
  }
  return envelope.result;
}

async function readResponseBytes(
  response: Response,
  stage: RuntimeClientStage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/u.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new RuntimeApiError(stage, response.status, `${stage.toLowerCase()} response exceeds byte cap`);
  }
  if (response.body === null) {
    throw new RuntimeApiError(stage, response.status, `${stage.toLowerCase()} returned an empty body`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let rejectAbort!: (reason?: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        complete = true;
        break;
      }
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        throw new RuntimeApiError(stage, response.status, `${stage.toLowerCase()} response exceeds byte cap`);
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readEnvelope(
  response: Response,
  stage: RuntimeClientStage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.ok) {
    throw new RuntimeApiError(stage, response.status, `${stage.toLowerCase()} failed`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new RuntimeApiError(stage, response.status, `${stage.toLowerCase()} returned non-JSON`);
  }
  try {
    const bytes = await readResponseBytes(response, stage, maxBytes, signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return responseResult(JSON.parse(text), stage);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof RuntimeApiError) throw error;
    throw new RuntimeApiError(stage, response.status, `${stage.toLowerCase()} returned invalid JSON`);
  }
}

export function createChannelRuntimeClient(
  options: ChannelRuntimeClientOptions,
): ChannelRuntimeClient {
  const baseUrl = functionsOrigin(options.functionsBaseUrl);
  if (options.credential.length < 32 || options.credential !== options.credential.trim()) {
    throw new TypeError("runtime credential is invalid");
  }
  if (
    !Number.isSafeInteger(options.sessionGeneration) || options.sessionGeneration < 1 ||
    !Number.isSafeInteger(options.fencingToken) || options.fencingToken < 1
  ) throw new TypeError("runtime generation binding is invalid");
  const request = options.fetch ?? globalThis.fetch;
const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RangeError("runtime request timeout is invalid");
  }
  const nowEpochSeconds = options.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1_000));
  const nonce = options.nonce ?? (() => crypto.randomUUID());
  const usedNonces = new Map<string, number>();
  const controllers = new Set<AbortController>();
  let localSessionGeneration = options.sessionGeneration;
  let closed = false;

  const requestEnvelope = async (
    url: URL,
    init: RequestInit,
    stage: RuntimeClientStage,
    maxResponseBytes: number,
    callerSignal?: AbortSignal,
  ): Promise<{ response: Response; result: unknown }> => {
    if (closed) throw new RuntimeApiError(stage, null, "runtime client is closed");
    const controller = new AbortController();
    controllers.add(controller);
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      return {
        response,
        result: await readEnvelope(response, stage, maxResponseBytes, controller.signal),
      };
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (error instanceof RuntimeApiError) throw error;
      // Name the underlying failure. A bare "transport failed" hid the difference
      // between a 10s abort, a DNS failure, and a TLS reset - three different bugs
      // with three different fixes - and diagnosing which meant rebuilding the
      // image with a log line anyway. The error NAME is content-free; bodies,
      // URLs, and headers stay out of it.
      const detail = error instanceof Error
        ? `${error.name}${error.cause instanceof Error ? `/${(error.cause as Error).name}` : ""}`
        : typeof error;
      throw new RuntimeApiError(stage, null, `${stage.toLowerCase()} transport failed (${detail})`);
    } finally {
      globalThis.clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controllers.delete(controller);
    }
  };

  /**
   * One runtime call at a time, process-wide.
   *
   * The bridge drives four loops against this one client - inbound drain, outbox and
   * work every SECOND, heartbeat every ten - and each call is really two requests, a
   * token exchange then the call. That is roughly six requests a second, and the SQL
   * behind them takes `FOR UPDATE` on the same account, cell and command rows. They
   * do not merely queue, they fight: `pg_stat_activity` showed these RPCs blocking
   * each other on `transactionid` with `LockManager` contention behind them.
   *
   * The heartbeat is the loser, because it is the rarest. It would connect, get no
   * response, and abort - so no command was ever claimed, no QR was ever produced,
   * and the cockpit sat at "Đang chờ máy chủ phát mã" while the bridge reported
   * itself healthy. Wiping the spool appeared to fix it only because a fresh spool
   * leaves the 1s loops with nothing to do for a moment.
   *
   * Serialising here keeps every loop's cadence but stops them overlapping, so the
   * database sees one runtime transaction at a time instead of six racing for the
   * same rows.
   */
  let gate: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = gate.then(run, run);
    gate = next.then(() => undefined, () => undefined);
    return next;
  };

  return Object.freeze({
    async post<T = unknown>(pathValue: string, body: unknown, signal?: AbortSignal): Promise<T> {
      // NO retry here, deliberately.
      //
      // A retry looks right and makes this exact failure worse. When a facade call
      // is slow, the request is still running on the server long after this client
      // gave up; a second attempt does not replace it, it queues behind it and takes
      // another PostgREST connection. Measured during the outage: twenty connections,
      // all the same heartbeat facade, all waiting on `Lock: tuple`, draining never.
      // The Edge function now bounds its own call instead, and the next tick is the
      // retry.
      return await serialize(() => attempt<T>(pathValue, body, signal));
    },
    localSessionGeneration(): number {
      return localSessionGeneration;
    },
    adoptSessionGeneration(generation: number): void {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new TypeError("adopted session generation is invalid");
      }
      if (generation === localSessionGeneration) return;
      if (generation !== localSessionGeneration + 1) {
        throw new TypeError("adopted session generation is not contiguous");
      }
      localSessionGeneration = generation;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  });

  async function attempt<T = unknown>(pathValue: string, body: unknown, signal?: AbortSignal): Promise<T> {
      if (closed) throw new RuntimeApiError("TOKEN_EXCHANGE", null, "runtime client is closed");
      const path = runtimePath(pathValue);
      const bytes = canonicalJson(body);
      const timestamp = nowEpochSeconds();
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
        throw new RuntimeApiError("TOKEN_EXCHANGE", null, "runtime clock is invalid");
      }
      for (const [value, usedAt] of usedNonces) {
        if (usedAt < timestamp - 600) usedNonces.delete(value);
      }
      const takeNonce = (): string => {
        const value = nonce();
        if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
          throw new RuntimeApiError("TOKEN_EXCHANGE", null, "runtime nonce is invalid");
        }
        if (usedNonces.has(value)) {
          throw new RuntimeApiError("TOKEN_EXCHANGE", null, "runtime nonce was reused");
        }
        usedNonces.set(value, timestamp);
        return value;
      };
      const runtimeNonce = takeNonce();
      let exchangeNonce: string;
      try {
        exchangeNonce = takeNonce();
      } catch (error) {
        if (error instanceof RuntimeApiError) throw error;
        throw new RuntimeApiError("TOKEN_EXCHANGE", null, "runtime nonce is invalid");
      }
      const runtimeBodySha256 = createHash("sha256").update(bytes, "utf8").digest("hex");
      const exchangeBody = canonicalJson({
        version: 1,
        principalKind: "CHANNEL",
        organizationId: options.organizationId,
        accountId: options.accountId,
        cellId: options.cellId,
        localSessionGeneration,
        runtimeMethod: "POST",
        runtimePath: path,
        runtimeTimestamp: timestamp,
        runtimeNonce,
        runtimeBodySha256,
        exchangeNonce,
      });

      const tokenExchange = await requestEnvelope(
        new URL("openclaw-runtime-token", baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openclaw-credential": options.credential,
          },
          body: exchangeBody,
        },
        "TOKEN_EXCHANGE",
        TOKEN_RESPONSE_MAX_BYTES,
        signal,
      );
      const tokenResponse = tokenExchange.response;
      const tokenResult = tokenExchange.result;
      if (!tokenResult || typeof tokenResult !== "object" || Array.isArray(tokenResult)) {
        throw new RuntimeApiError("TOKEN_EXCHANGE", tokenResponse.status, "token exchange result invalid");
      }
      const tokenRecord = tokenResult as Record<string, unknown>;
      if (Object.keys(tokenRecord).sort().join(",") !== "expiresInSeconds,token,version") {
        throw new RuntimeApiError("TOKEN_EXCHANGE", tokenResponse.status, "token exchange result invalid");
      }
      const token = tokenRecord.token;
      if (
        tokenRecord.version !== 1 || typeof token !== "string" || token.length === 0 ||
        !Number.isSafeInteger(tokenRecord.expiresInSeconds) ||
        (tokenRecord.expiresInSeconds as number) < 1 ||
        (tokenRecord.expiresInSeconds as number) > 300
      ) {
        throw new RuntimeApiError("TOKEN_EXCHANGE", tokenResponse.status, "token exchange result invalid");
      }

      const runtimeRequest = await requestEnvelope(
        new URL(`openclaw-runtime${path}`, baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "x-openclaw-nonce": runtimeNonce,
            "x-openclaw-timestamp": String(timestamp),
          },
          body: bytes,
        },
        "RUNTIME_REQUEST",
        path === "/v1/work/context" ? WORK_CONTEXT_RESPONSE_MAX_BYTES : RUNTIME_RESPONSE_MAX_BYTES,
        signal,
      );
      return runtimeRequest.result as T;
  }
}
