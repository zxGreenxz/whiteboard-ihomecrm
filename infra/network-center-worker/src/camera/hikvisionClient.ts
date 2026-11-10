import { digestAuthorization, selectDigestChallenge } from "./digestAuth.js";
import { CameraClientError, type CameraClientErrorCode } from "./errors.js";
import { childText, childrenNamed, parseXml, type XmlElement } from "./isapiXml.js";
import { PinnedHttpClient, ReusedSocketClosedError, type PinnedHttpReply } from "./pinnedHttp.js";
import type { CameraChannelObservation, CameraChannelState, CameraDiskObservation, CameraIssue, CameraPollingClient, CameraSnapshot } from "./types.js";

// Every element name, value vocabulary and status code below follows the
// published ISAPI schema. None of it has been checked against a reply captured
// from a real recorder yet; each parser is a pure export so a captured fixture
// can replace the documented one without touching the transport.

export const HIKVISION_ANALOG_CHANNELS_PATH = "/ISAPI/System/Video/inputs/channels";
export const HIKVISION_PROXY_CHANNELS_PATH = "/ISAPI/ContentMgmt/InputProxy/channels";
export const HIKVISION_PROXY_STATUS_PATH = "/ISAPI/ContentMgmt/InputProxy/channels/status";
export const HIKVISION_STORAGE_PATH = "/ISAPI/ContentMgmt/Storage";

const MEGABYTE = 1024 * 1024;
const invalid = () => new CameraClientError("INVALID_RESPONSE");

function positiveInteger(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined || !/^\d{1,9}$/u.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 && number <= maximum ? number : undefined;
}

function flag(value: string | undefined): boolean | undefined {
  const text = value?.toLowerCase();
  return text === "true" ? true : text === "false" ? false : undefined;
}

/** Bound a recorder label to what ingestion accepts: no control characters, at most 128 UTF-16 units, whole code points. */
function label(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let name = "";
  for (const char of [...value].map((item) => (item.charCodeAt(0) < 32 || item.charCodeAt(0) === 127 ? " " : item)).join("").trim()) {
    if (name.length + char.length > 128) break;
    name += char;
  }
  return name || undefined;
}

/** Items of a list document. A firmware that answers with the bare item is read as a list of one. */
function listItems(xml: string, list: string, item: string): XmlElement[] {
  const root = parseXml(xml);
  if (root.name === list.toLowerCase()) return childrenNamed(root, item);
  if (root.name === item.toLowerCase()) return [root];
  throw invalid();
}

export interface HikvisionAnalogChannel {
  id: number;
  name?: string;
  state: CameraChannelState;
}

/**
 * `<VideoInputChannel>`: a disabled input is an empty slot; `resDesc` holding
 * "NO VIDEO" is a camera that stopped sending; any other `resDesc` is a live
 * signal; no `resDesc` is not evidence either way.
 */
export function parseHikvisionAnalogChannels(xml: string): HikvisionAnalogChannel[] {
  const seen = new Set<number>();
  return listItems(xml, "VideoInputChannelList", "VideoInputChannel").map((row): HikvisionAnalogChannel => {
    const id = positiveInteger(childText(row, "id"), 256);
    if (id === undefined || seen.has(id)) throw invalid();
    seen.add(id);
    const resolution = childText(row, "resDesc");
    const state: CameraChannelState = flag(childText(row, "videoInputEnabled")) === false ? "EMPTY"
      : !resolution ? "UNKNOWN"
      : /no\s*video/iu.test(resolution) ? "DISCONNECTED" : "CONNECTED";
    const name = label(childText(row, "name"));
    return { id, state, ...(name === undefined ? {} : { name }) };
  });
}

export interface HikvisionProxyChannel {
  id: number;
  name?: string;
}

/** `<InputProxyChannel>`: one configured IP channel. Only its direct `<id>` and `<name>` are read. */
export function parseHikvisionProxyChannels(xml: string): HikvisionProxyChannel[] {
  const seen = new Set<number>();
  return listItems(xml, "InputProxyChannelList", "InputProxyChannel").map((row): HikvisionProxyChannel => {
    const id = positiveInteger(childText(row, "id"), 4096);
    if (id === undefined || seen.has(id)) throw invalid();
    seen.add(id);
    const name = label(childText(row, "name"));
    return { id, ...(name === undefined ? {} : { name }) };
  });
}

/** `<InputProxyChannelStatus>`: IP channel id to its `<online>` flag. A row without a readable flag is left out. */
export function parseHikvisionProxyStatus(xml: string): Map<number, boolean> {
  const online = new Map<number, boolean>();
  for (const row of listItems(xml, "InputProxyChannelStatusList", "InputProxyChannelStatus")) {
    const id = positiveInteger(childText(row, "id"), 4096);
    if (id === undefined || online.has(id)) throw invalid();
    const value = flag(childText(row, "online"));
    if (value !== undefined) online.set(id, value);
  }
  return online;
}

const DISK_STATES = new Map<string, CameraDiskObservation["state"]>([
  ["ok", "NORMAL"], ["idle", "NORMAL"], ["sleeping", "NORMAL"],
  ["unformatted", "ERROR"], ["error", "ERROR"], ["smartfailed", "ERROR"], ["mismatch", "ERROR"], ["abnormal", "ERROR"], ["bad", "ERROR"],
  ["notexist", "MISSING"], ["offline", "MISSING"],
]);

/** `<hdd>` rows of `<storage><hddList>`. `capacity` and `freeSpace` are megabytes. */
export function parseHikvisionStorage(xml: string): CameraDiskObservation[] {
  const root = parseXml(xml);
  if (root.name !== "storage" && root.name !== "hddlist") throw invalid();
  const list = root.name === "hddlist" ? root : childrenNamed(root, "hddList")[0];
  if (!list) return [];
  const megabytes = (value: string | undefined) => (value !== undefined && /^\d{1,12}$/u.test(value) ? Number(value) : undefined);
  const seen = new Set<number>();
  return childrenNamed(list, "hdd").map((row): CameraDiskObservation => {
    const slot = positiveInteger(childText(row, "id"), 32);
    if (slot === undefined || seen.has(slot)) throw invalid();
    seen.add(slot);
    const state = DISK_STATES.get((childText(row, "status") ?? "").toLowerCase()) ?? "UNKNOWN";
    const capacity = megabytes(childText(row, "capacity"));
    const free = megabytes(childText(row, "freeSpace"));
    const totalBytes = capacity === undefined ? undefined : capacity * MEGABYTE;
    const usedBytes = capacity === undefined || free === undefined ? undefined : Math.max(0, capacity - free) * MEGABYTE;
    return {
      slot, state,
      ...(totalBytes === undefined || !Number.isSafeInteger(totalBytes) ? {} : { totalBytes }),
      ...(usedBytes === undefined || !Number.isSafeInteger(usedBytes) ? {} : { usedBytes }),
    };
  });
}

export interface HikvisionChannelInput {
  analog: readonly HikvisionAnalogChannel[];
  proxy: readonly HikvisionProxyChannel[];
  /** IP channel id to online flag; an id without an entry has no status row. */
  online: ReadonlyMap<number, boolean>;
  /** Enrolled recorder capacity, including empty slots. */
  channelCount: number;
}

/**
 * Merge both channel types into user-facing channel numbers 1..channelCount.
 *
 * An analog channel keeps its id. An IP channel keeps its id when every IP id
 * is already above the analog range (firmware that numbers IP channels after
 * the analog ones); otherwise the analog range is added to it (firmware that
 * restarts IP ids at 1). The analog range is the larger of the analog row count
 * and the highest analog id, so a gap in the analog ids cannot make the two
 * ranges overlap.
 *
 * Measured 2026-11-10 on a hybrid DVR with 8 analog inputs (firmware V4.70):
 * its IP channels are listed as ids 9 and 10 and id 9 streams as 901, so the
 * first branch is what that firmware does. The "restart at 1" branch still
 * follows the documentation only.
 *
 * A slot in neither list is EMPTY. A number above the enrolled capacity, above
 * 256, or already taken is not emitted and is counted in `dropped`.
 */
export function mapHikvisionChannels(input: HikvisionChannelInput): { channels: CameraChannelObservation[]; dropped: number } {
  const limit = Math.min(256, Math.max(0, Math.trunc(input.channelCount)));
  const analogRange = Math.max(input.analog.length, ...input.analog.map((channel) => channel.id));
  const shift = input.proxy.every((channel) => channel.id > analogRange) ? 0 : analogRange;
  const byNumber = new Map<number, CameraChannelObservation>();
  let dropped = 0;
  const place = (channel: number, state: CameraChannelState, name: string | undefined) => {
    if (channel > limit || byNumber.has(channel)) {
      dropped += 1;
      return;
    }
    byNumber.set(channel, { channel, state, ...(name === undefined ? {} : { name }) });
  };
  for (const channel of input.analog) place(channel.id, channel.state, channel.name);
  for (const channel of input.proxy) {
    const online = input.online.get(channel.id);
    place(channel.id + shift, online === undefined ? "UNKNOWN" : online ? "CONNECTED" : "DISCONNECTED", channel.name);
  }
  for (let channel = 1; channel <= limit; channel += 1) {
    if (!byNumber.has(channel)) byNumber.set(channel, { channel, state: "EMPTY" });
  }
  return { channels: [...byNumber.values()].sort((left, right) => left.channel - right.channel), dropped };
}

function findElement(root: XmlElement, name: string): XmlElement | undefined {
  if (root.name === name) return root;
  for (const child of root.children) {
    const found = findElement(child, name);
    if (found) return found;
  }
  return undefined;
}

export type HikvisionReplyKind = "OK" | "NOT_SUPPORTED" | "DENIED" | "FAILED";

/**
 * What a non-401 reply means for one endpoint. A model without a channel type
 * answers 403/404, or a `<ResponseStatus>` whose `subStatusCode` is
 * `notSupport`/`invalidOperation`. A `<ResponseStatus>` naming a privilege
 * problem is never read as "no such channel type": that would turn a
 * restricted account into a recorder full of empty slots.
 */
export function classifyHikvisionReply(status: number, body: string): HikvisionReplyKind {
  let code: number | undefined;
  let detail: string | undefined;
  try {
    const root = parseXml(body);
    if (root.name === "responsestatus") {
      code = positiveInteger(childText(root, "statusCode"), 99);
      detail = childText(root, "subStatusCode")?.toLowerCase();
    }
  } catch { /* An HTML or empty error page says nothing beyond its status code. */ }
  if (status >= 200 && status < 300 && (code === undefined || code === 1)) return "OK";
  if (detail === "lowprivilege" || detail === "badauthorization") return "DENIED";
  if (detail === "notsupport" || detail === "invalidoperation") return "NOT_SUPPORTED";
  if (status === 403 || status === 404) return "NOT_SUPPORTED";
  return "FAILED";
}

/** True when a refusal states that the account or this client address is locked; no login may be sent then. */
export function hikvisionLockedOut(body: string): boolean {
  try {
    return /^lock/iu.test(findElement(parseXml(body), "lockstatus")?.text.trim() ?? "");
  } catch {
    return false;
  }
}

export interface HikvisionClientOptions {
  /** Private routed address; never embed credentials in this URL. */
  baseUrl: string;
  username: string;
  password: string;
  /** Lower-case hex SHA-256 of the recorder certificate. Required for https, refused for http. */
  tlsFingerprint256?: string | undefined;
  /** Enrolled recorder capacity, including empty slots. */
  channelCount: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

/**
 * Read-only ISAPI polling: channel state and disk state, HTTP Digest only.
 * All requests stay on the supplied origin. There is no event stream in this
 * version. Errors and diagnostics are fixed codes, never device text.
 */
export class HikvisionClient implements CameraPollingClient {
  private readonly base: URL;
  private readonly timeoutMs: number;
  private readonly maximumBytes: number;
  private readonly now: () => Date;
  private reuseConnections = true;
  private failure: CameraClientErrorCode | null = null;

  constructor(private readonly options: HikvisionClientOptions) {
    this.base = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || this.base.pathname !== "/") {
      throw new Error("INVALID_CAMERA_BASE_URL");
    }
    if (/[\r\n]/u.test(options.username) || !options.username || !options.password) throw new Error("INVALID_CAMERA_CREDENTIAL");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumBytes = options.maxResponseBytes ?? 512 * 1024;
    this.now = options.now ?? (() => new Date());
    for (const value of [this.timeoutMs, this.maximumBytes]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_CAMERA_LIMIT");
    }
    if (!Number.isInteger(options.channelCount) || options.channelCount < 1 || options.channelCount > 256) throw new Error("INVALID_CAMERA_CHANNEL_COUNT");
    // Validates the pin rules now, so a misconfigured recorder fails before any connection is opened.
    this.transport().close();
  }

  /** First failure code of the most recent poll, for operator logs; null when every request succeeded. */
  get lastFailure(): CameraClientErrorCode | null {
    return this.failure;
  }

  private transport(): PinnedHttpClient {
    return new PinnedHttpClient({
      origin: this.base, tlsFingerprint256: this.options.tlsFingerprint256,
      connectTimeoutMs: this.timeoutMs, maxResponseBytes: this.maximumBytes, keepAlive: this.reuseConnections,
    });
  }

  private async digestGet(http: PinnedHttpClient, path: string, signal: AbortSignal): Promise<PinnedHttpReply> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const challenge = await http.get(path, {}, signal);
        if (challenge.status !== 401) return challenge;
        const offer = selectDigestChallenge(challenge.challenges);
        // Without a Digest offer the only way in would be Basic, which is never used.
        // While the recorder states a lock-out, a login cannot succeed and may count against the account.
        if (offer === null || hikvisionLockedOut(challenge.body)) throw new CameraClientError("AUTH_DENIED");
        let authorization: string;
        try {
          authorization = digestAuthorization({ challenge: offer, method: "GET", uri: path, username: this.options.username, password: this.options.password });
        } catch {
          throw new CameraClientError("AUTH_DENIED");
        }
        const reply = await http.get(path, { Authorization: authorization }, signal);
        // One authenticated attempt per request. A refusal is final: these
        // recorders lock the account and the client address after a few.
        if (reply.status === 401) throw new CameraClientError("AUTH_DENIED");
        return reply;
      } catch (error) {
        if (!(error instanceof ReusedSocketClosedError) || attempt > 0) throw error;
        // The recorder closed a kept-alive socket under the request, so nothing
        // was answered. Ask once more with a new challenge, one connection per
        // request, and keep it that way for this recorder.
        this.reuseConnections = false;
        http.disableReuse();
      }
    }
  }

  /** Parsed list of one endpoint, or null when this model does not have it. */
  private async read<T>(http: PinnedHttpClient, path: string, parse: (xml: string) => T): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const reply = await this.digestGet(http, path, controller.signal);
      const kind = classifyHikvisionReply(reply.status, reply.body);
      if (kind === "NOT_SUPPORTED") return null;
      if (kind === "DENIED") throw new CameraClientError("AUTH_DENIED");
      if (kind === "FAILED") throw new CameraClientError("UNSUPPORTED");
      return parse(reply.body);
    } finally {
      clearTimeout(timer);
    }
  }

  async poll(): Promise<CameraSnapshot> {
    const snapshot: CameraSnapshot = { observedAt: this.now().toISOString(), status: "UNKNOWN", channels: [], storage: [], eventCoverage: "STATE_POLLING_ONLY", issues: [] };
    const http = this.transport();
    this.failure = null;
    const codeOf = (error: unknown): CameraClientErrorCode => {
      const code = error instanceof CameraClientError ? error.code : "INVALID_RESPONSE";
      this.failure ??= code;
      return code;
    };
    // These end the poll at once: a refused login must not be repeated on the
    // next endpoint, and a peer that failed the pin or never answered has nothing to add.
    const ends = (code: CameraClientErrorCode) => code === "AUTH_DENIED" || code === "TLS_PIN_MISMATCH" || code === "TLS_HANDSHAKE_FAILED"
      || (code === "UNREACHABLE" && !http.answered);
    const issueOf = (code: CameraClientErrorCode, phase: CameraIssue): CameraIssue =>
      code === "INVALID_RESPONSE" || code === "RESPONSE_TOO_LARGE" ? "DEVICE_RESPONSE_INVALID" : phase;
    try {
      let channelsRead = false;
      try {
        const analog = await this.read(http, HIKVISION_ANALOG_CHANNELS_PATH, parseHikvisionAnalogChannels);
        const proxy = await this.read(http, HIKVISION_PROXY_CHANNELS_PATH, parseHikvisionProxyChannels);
        // Neither channel type could be listed: that is no evidence of an empty recorder.
        if (analog === null && proxy === null) throw new CameraClientError("UNSUPPORTED");
        let online: ReadonlyMap<number, boolean> = new Map();
        if (proxy !== null && proxy.length > 0) {
          try {
            online = (await this.read(http, HIKVISION_PROXY_STATUS_PATH, parseHikvisionProxyStatus)) ?? online;
          } catch (error) {
            // IP channels stay listed as UNKNOWN; analog channels keep their measured state.
            const code = codeOf(error);
            if (ends(code)) throw error;
            snapshot.issues.push(issueOf(code, "CHANNEL_STATUS_UNAVAILABLE"));
          }
        }
        const mapped = mapHikvisionChannels({ analog: analog ?? [], proxy: proxy ?? [], online, channelCount: this.options.channelCount });
        snapshot.channels = mapped.channels;
        if (mapped.dropped > 0 || mapped.channels.some((channel) => channel.state === "UNKNOWN")) snapshot.issues.push("CHANNEL_STATUS_UNAVAILABLE");
        channelsRead = true;
      } catch (error) {
        const code = codeOf(error);
        if (ends(code)) throw error;
        snapshot.issues.push(issueOf(code, "CHANNEL_STATUS_UNAVAILABLE"));
      }
      try {
        const disks = await this.read(http, HIKVISION_STORAGE_PATH, parseHikvisionStorage);
        if (disks !== null) snapshot.storage = disks;
        if (disks === null || disks.some((disk) => disk.state === "UNKNOWN")) snapshot.issues.push("STORAGE_STATUS_UNAVAILABLE");
      } catch (error) {
        const code = codeOf(error);
        if (ends(code)) throw error;
        snapshot.issues.push(issueOf(code, "STORAGE_STATUS_UNAVAILABLE"));
      }
      // One unreadable channel or disk is reported as UNKNOWN in place and
      // flagged above; it does not discard the states that were measured.
      snapshot.status = channelsRead ? "ONLINE" : "UNKNOWN";
      snapshot.issues = [...new Set(snapshot.issues)];
    } catch (error) {
      const code = codeOf(error);
      snapshot.channels = [];
      snapshot.storage = [];
      snapshot.status = code === "AUTH_DENIED" ? "AUTH_DENIED" : code === "UNREACHABLE" && !http.answered ? "OFFLINE" : "UNKNOWN";
      snapshot.issues = [code === "AUTH_DENIED" ? "AUTHENTICATION_FAILED" : code === "UNREACHABLE" && !http.answered ? "NETWORK_UNREACHABLE" : "DEVICE_RESPONSE_INVALID"];
    } finally {
      http.close();
      snapshot.observedAt = this.now().toISOString();
    }
    return snapshot;
  }
}
