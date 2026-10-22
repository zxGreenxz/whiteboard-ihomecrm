import { createHash, randomBytes } from "node:crypto";

import { CameraMultipartParser, type CameraStreamMessage } from "./eventParser.js";
import type { CameraChannelObservation, CameraDiskObservation, CameraIssue, CameraSnapshot } from "./types.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const md5 = (value: string) => createHash("md5").update(value, "utf8").digest("hex");

export class CameraClientError extends Error {
  constructor(readonly code: "AUTH_DENIED" | "UNREACHABLE" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE" | "UNSUPPORTED" | "STREAM_ENDED" | "STREAM_TIMEOUT") {
    super(code);
    this.name = "CameraClientError";
  }
}

export interface DahuaClientOptions {
  /** Private routed address; never embed credentials in this URL. */
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxResponseBytes?: number;
  /** Declared recorder capacity, including empty slots; detect truncated replies. */
  expectedChannelCount?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function parseCameraStates(value: unknown): CameraChannelObservation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new CameraClientError("INVALID_RESPONSE");
  const seen = new Set<number>();
  return value.map((row): CameraChannelObservation => {
    if (!object(row) || !Number.isInteger(row.channel) || Number(row.channel) < 0 || Number(row.channel) > 255 || typeof row.connectionState !== "string") {
      throw new CameraClientError("INVALID_RESPONSE");
    }
    const channel = Number(row.channel) + 1;
    if (seen.has(channel)) throw new CameraClientError("INVALID_RESPONSE");
    seen.add(channel);
    const state = row.connectionState === "Connected" ? "CONNECTED"
      : row.connectionState === "Unconnected" || row.connectionState === "Disconnected" ? "DISCONNECTED"
      : row.connectionState === "Empty" ? "EMPTY" : "UNKNOWN";
    return { channel, state };
  });
}

export function parseCameraStorage(text: string): CameraDiskObservation[] {
  const rows = new Map<string, Map<string, string>>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^list(?:\.info)?\[(\d+)\]\.(\S+?)=(.*)$/u.exec(line);
    if (!match) continue;
    const slot = match[1]!;
    if (!Number.isInteger(Number(slot)) || Number(slot) < 0 || Number(slot) > 31) throw new CameraClientError("INVALID_RESPONSE");
    let row = rows.get(slot);
    if (!row) { row = new Map(); rows.set(slot, row); }
    if (row.has(match[2]!)) throw new CameraClientError("INVALID_RESPONSE");
    row.set(match[2]!, match[3]!);
  }
  if (rows.size === 0 || rows.size > 32) throw new CameraClientError("INVALID_RESPONSE");
  return [...rows].map(([slot, row]): CameraDiskObservation => {
    const errors = [...row].filter(([key]) => /^Detail\[\d+\]\.IsError$/u.test(key)).map(([, value]) => value);
    const diskState = row.get("State");
    const state = errors.includes("true") ? "ERROR"
      : diskState === "Success" && errors.length > 0 && errors.every((error) => error === "false") ? "NORMAL" : "UNKNOWN";
    const sum = (field: string): number | undefined => {
      const entries = [...row].filter(([key]) => new RegExp(`^Detail\\[\\d+\\]\\.${field}$`, "u").test(key));
      if (!entries.length) return undefined;
      let total = 0;
      for (const [, value] of entries) {
        if (!/^\d+(?:\.0+)?$/u.test(value)) return undefined;
        total += Number(value);
        if (!Number.isSafeInteger(total)) return undefined;
      }
      return total;
    };
    const totalBytes = sum("TotalBytes");
    const usedBytes = sum("UsedBytes");
    return { slot: Number(slot) + 1, state, ...(totalBytes === undefined ? {} : { totalBytes }), ...(usedBytes === undefined ? {} : { usedBytes }) };
  });
}

/** All requests stay on the supplied origin. Errors contain fixed codes only. */
export class DahuaClient {
  private readonly base: URL;
  private readonly requestFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maximumBytes: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: DahuaClientOptions) {
    this.base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== "/") {
      throw new Error("INVALID_CAMERA_BASE_URL");
    }
    if (/[\r\n]/u.test(options.username) || !options.username || !options.password) throw new Error("INVALID_CAMERA_CREDENTIAL");
    this.requestFetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumBytes = options.maxResponseBytes ?? 512 * 1024;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    for (const value of [this.timeoutMs, this.maximumBytes, this.streamIdleTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_CAMERA_LIMIT");
    }
    if (options.expectedChannelCount !== undefined && (!Number.isInteger(options.expectedChannelCount) || options.expectedChannelCount < 1 || options.expectedChannelCount > 256)) throw new Error("INVALID_CAMERA_CHANNEL_COUNT");
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.requestFetch(new URL(path, this.base), { ...init, signal, redirect: "error" });
    } catch {
      throw new CameraClientError("UNREACHABLE");
    }
  }

  private async boundedBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) throw new CameraClientError("INVALID_RESPONSE");
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.maximumBytes) throw new CameraClientError("RESPONSE_TOO_LARGE");
        body += decoder.decode(part.value, { stream: true });
      }
      return body + decoder.decode();
    } catch (error) {
      if (error instanceof CameraClientError) throw error;
      throw new CameraClientError("UNREACHABLE");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private checkStatus(response: Response): void {
    if (response.status === 401 || response.status === 403) throw new CameraClientError("AUTH_DENIED");
    if (!response.ok) throw new CameraClientError("UNSUPPORTED");
  }

  private async rpc(method: string, params: unknown, id: number, session?: string | number, login = false): Promise<ObjectValue> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.request(login ? "/RPC2_Login" : "/RPC2", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, params, id, ...(session === undefined ? {} : { session }) }),
      }, controller.signal);
      this.checkStatus(response);
      let parsed: unknown;
      try { parsed = JSON.parse(await this.boundedBody(response)); } catch (error) {
        if (error instanceof CameraClientError) throw error;
        throw new CameraClientError("INVALID_RESPONSE");
      }
      if (!object(parsed)) throw new CameraClientError("INVALID_RESPONSE");
      return parsed;
    } finally {
      clearTimeout(timeout);
      await response?.body?.cancel().catch(() => undefined);
    }
  }

  private assertRpcSuccess(response: ObjectValue): void {
    if (response.result === true) return;
    const error = object(response.error) ? response.error : response;
    if ([268632080, 268632081, 268632082, 268894210, 285409284].includes(Number(error.code ?? error.errCode))) throw new CameraClientError("AUTH_DENIED");
    throw new CameraClientError("UNSUPPORTED");
  }

  private async login(): Promise<string | number> {
    const challenge = await this.rpc("global.login", { userName: this.options.username, password: "", clientType: "Web5.0" }, 1, undefined, true);
    if (!object(challenge.params) || typeof challenge.params.realm !== "string" || typeof challenge.params.random !== "string") {
      this.assertRpcSuccess(challenge);
      throw new CameraClientError("INVALID_RESPONSE");
    }
    if (typeof challenge.session !== "string" && typeof challenge.session !== "number") throw new CameraClientError("INVALID_RESPONSE");
    if (challenge.params.encryption !== undefined && challenge.params.encryption !== "Default") throw new CameraClientError("UNSUPPORTED");
    const { realm, random } = challenge.params;
    const firstHash = md5(`${this.options.username}:${realm}:${this.options.password}`).toUpperCase();
    const password = md5(`${this.options.username}:${random}:${firstHash}`).toUpperCase();
    const result = await this.rpc("global.login", {
      userName: this.options.username, password, clientType: "Web5.0", realm, random,
      passwordType: "Default", authorityType: "Default",
    }, 2, challenge.session, true);
    this.assertRpcSuccess(result);
    if ((typeof result.session !== "number" && typeof result.session !== "string") || !result.session) throw new CameraClientError("INVALID_RESPONSE");
    return result.session;
  }

  private digestAuthorization(challenge: string, path: string): string {
    if (!/^Digest\s/iu.test(challenge)) throw new CameraClientError("UNSUPPORTED");
    const values = new Map<string, string>();
    for (const match of challenge.slice(7).matchAll(/([a-zA-Z]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/gu)) {
      values.set(match[1]!.toLowerCase(), (match[2] ?? match[3] ?? "").replace(/\\(.)/gu, "$1"));
    }
    const realm = values.get("realm");
    const nonce = values.get("nonce");
    const algorithm = (values.get("algorithm") ?? "MD5").toUpperCase();
    const qop = values.get("qop");
    if (realm === undefined || !nonce || (algorithm !== "MD5" && algorithm !== "SHA-256") || (qop !== undefined && !qop.split(",").map((value) => value.trim()).includes("auth"))) {
      throw new CameraClientError("UNSUPPORTED");
    }
    const hash = (value: string) => createHash(algorithm === "MD5" ? "md5" : "sha256").update(value, "utf8").digest("hex");
    const cnonce = randomBytes(16).toString("hex");
    const ha1 = hash(`${this.options.username}:${realm}:${this.options.password}`);
    const ha2 = hash(`GET:${path}`);
    const digest = qop ? hash(`${ha1}:${nonce}:00000001:${cnonce}:auth:${ha2}`) : hash(`${ha1}:${nonce}:${ha2}`);
    const quote = (value: string) => `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
    const parts = [`username=${quote(this.options.username)}`, `realm=${quote(realm)}`, `nonce=${quote(nonce)}`, `uri=${quote(path)}`, `response=${quote(digest)}`, `algorithm=${algorithm}`];
    if (qop) parts.push("qop=auth", "nc=00000001", `cnonce=${quote(cnonce)}`);
    if (values.has("opaque")) parts.push(`opaque=${quote(values.get("opaque")!)}`);
    return `Digest ${parts.join(", ")}`;
  }

  private async digestGet(path: string, signal: AbortSignal): Promise<Response> {
    let response = await this.request(path, { method: "GET" }, signal);
    if (response.status === 401) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      await response.body?.cancel().catch(() => undefined);
      if (!/^Digest\s/iu.test(challenge)) throw new CameraClientError("AUTH_DENIED");
      response = await this.request(path, { method: "GET", headers: { Authorization: this.digestAuthorization(challenge, path) } }, signal);
    }
    try { this.checkStatus(response); } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  }

  async readStorage(): Promise<CameraDiskObservation[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.digestGet("/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo", controller.signal);
      return parseCameraStorage(await this.boundedBody(response));
    } finally { clearTimeout(timer); }
  }

  async poll(): Promise<CameraSnapshot> {
    const snapshot: CameraSnapshot = { observedAt: this.now().toISOString(), status: "UNKNOWN", channels: [], storage: [], eventCoverage: "STATE_POLLING_ONLY", issues: [] };
    let session: string | number | undefined;
    let loggedIn = false;
    let phase: "login" | "channels" | "storage" = "login";
    try {
      session = await this.login();
      loggedIn = true;
      phase = "channels";
      const channels = await this.rpc("LogicDeviceManager.getCameraState", { uniqueChannels: [-1] }, 3, session);
      this.assertRpcSuccess(channels);
      if (!object(channels.params)) throw new CameraClientError("INVALID_RESPONSE");
      snapshot.channels = parseCameraStates(channels.params.states);
      const expectedCount = this.options.expectedChannelCount;
      if (expectedCount !== undefined && (snapshot.channels.length !== expectedCount || snapshot.channels.some((channel) => channel.channel > expectedCount))) {
        throw new CameraClientError("INVALID_RESPONSE");
      }
      phase = "storage";
      snapshot.storage = await this.readStorage();
      snapshot.status = "ONLINE";
      if (snapshot.channels.some((channel) => channel.state === "UNKNOWN")) {
        snapshot.issues.push("CHANNEL_STATUS_UNAVAILABLE");
        snapshot.status = "UNKNOWN";
      }
      if (snapshot.storage.some((disk) => disk.state === "UNKNOWN")) {
        snapshot.issues.push("STORAGE_STATUS_UNAVAILABLE");
        snapshot.status = "UNKNOWN";
      }
    } catch (error) {
      const code = error instanceof CameraClientError ? error.code : "INVALID_RESPONSE";
      // Do not deliver an out-of-assignment channel in a failure snapshot: the
      // ingestion boundary correctly rejects it even when status is UNKNOWN.
      if (phase === "channels") snapshot.channels = [];
      snapshot.status = code === "AUTH_DENIED" ? "AUTH_DENIED" : code === "UNREACHABLE" && !loggedIn ? "OFFLINE" : "UNKNOWN";
      const issue: CameraIssue = code === "AUTH_DENIED" ? "AUTHENTICATION_FAILED"
        : code === "UNREACHABLE" && !loggedIn ? "NETWORK_UNREACHABLE"
        : code === "INVALID_RESPONSE" || code === "RESPONSE_TOO_LARGE" ? "DEVICE_RESPONSE_INVALID"
        : phase === "channels" ? "CHANNEL_STATUS_UNAVAILABLE"
        : phase === "storage" ? "STORAGE_STATUS_UNAVAILABLE" : "DEVICE_RESPONSE_INVALID";
      snapshot.issues.push(issue);
    } finally {
      if (session !== undefined) {
        try { this.assertRpcSuccess(await this.rpc("global.logout", null, 4, session)); }
        catch { if (!snapshot.issues.includes("DEVICE_RESPONSE_INVALID")) snapshot.issues.push("DEVICE_RESPONSE_INVALID"); }
      }
      snapshot.observedAt = this.now().toISOString();
    }
    return snapshot;
  }

  async *openEventStream(signal?: AbortSignal): AsyncGenerator<CameraStreamMessage> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timer = setTimeout(abort, this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.digestGet("/cgi-bin/eventManager.cgi?action=attach&codes=[VideoLoss,StorageFailure,StorageNotExist,StorageLowSpace]&heartbeat=5", controller.signal);
      clearTimeout(timer);
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(response.headers.get("content-type") ?? "");
      if (!boundary || !response.body) { await response.body?.cancel(); throw new CameraClientError("INVALID_RESPONSE"); }
      const parser = new CameraMultipartParser(boundary[1] ?? boundary[2]!);
      reader = response.body.getReader();
      while (!signal?.aborted) {
        timer = setTimeout(abort, this.streamIdleTimeoutMs);
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch {
          if (signal?.aborted) return;
          throw new CameraClientError(controller.signal.aborted ? "STREAM_TIMEOUT" : "UNREACHABLE");
        } finally { clearTimeout(timer); }
        if (chunk.done) throw new CameraClientError("STREAM_ENDED");
        for (const message of parser.push(chunk.value)) {
          if (message.type === "event" && message.event.channelNumber !== undefined
            && message.event.channelNumber > (this.options.expectedChannelCount ?? 256)) {
            throw new CameraClientError("INVALID_RESPONSE");
          }
          yield message;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
}
