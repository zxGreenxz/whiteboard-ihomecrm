import { createHash } from "node:crypto";

import { allResolvedAddressesAllowed } from "./ip-policy.js";
import { evaluateRedirectChain, MAX_REDIRECTS } from "./redirect-policy.js";
import { MediaMagicError, verifyMediaMagic } from "./magic-byte.js";
import { createInboundTempFile, removeInboundTempFile } from "./temp-cleanup.js";

export const INBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const MAGIC_PREFIX_MAX_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface VerifiedInboundMedia {
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width?: number;
  readonly height?: number;
  dispose(): Promise<void>;
}

interface InboundMediaFetchCommonOptions {
  url: string;
  allowlistedHosts: readonly string[];
  expectedMime?: string;
  expectedBytes?: number;
  expectedSha256?: string;
  maxBytes?: number;
  tempDirectory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  forbiddenHostAddresses?: readonly string[];
}

export interface BrokeredMediaFetch {
  fetch(url: URL, init?: RequestInit): Promise<Response>;
}

export type DirectMediaResolver = (hostname: string) => Promise<readonly string[]>;
export type PinnedMediaRequest = (input: {
  url: URL;
  pinnedAddress: string;
  resolvedAddresses: readonly string[];
  signal?: AbortSignal;
}) => Promise<Response>;

export type InboundMediaFetchOptions = InboundMediaFetchCommonOptions & ({
  egress: BrokeredMediaFetch;
  resolveHost?: never;
  request?: never;
} | {
  egress?: never;
  resolveHost: DirectMediaResolver;
  request: PinnedMediaRequest;
});

export class InboundMediaFetchError extends Error {
  readonly code: string;

  constructor(code: string, message = "inbound media fetch failed") {
    super(message);
    this.name = "InboundMediaFetchError";
    this.code = code;
  }
}

function canonicalLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new InboundMediaFetchError("MEDIA_LENGTH_INVALID", "declared media length is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InboundMediaFetchError("MEDIA_LENGTH_INVALID", "declared media length is invalid");
  }
  return parsed;
}

function validateStartUrl(value: string, allowlistedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InboundMediaFetchError("MEDIA_URL_INVALID", "media URL is invalid");
  }
  const policy = evaluateRedirectChain([url.href], allowlistedHosts);
  if (!policy.allowed) throw new InboundMediaFetchError("MEDIA_URL_DENIED", "media URL is denied");
  return url;
}

async function responseForAllowedHop(
  url: URL,
  options: InboundMediaFetchOptions,
): Promise<Response> {
  if (options.signal?.aborted) throw new InboundMediaFetchError("MEDIA_ABORTED", "media fetch aborted");
  if (options.egress !== undefined) {
    try {
      return await options.egress.fetch(url, {
        method: "GET",
        headers: { accept: "*/*", "accept-encoding": "identity" },
        redirect: "manual",
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch {
      if (options.signal?.aborted) {
        throw new InboundMediaFetchError("MEDIA_ABORTED", "media fetch aborted");
      }
      throw new InboundMediaFetchError("MEDIA_TRANSPORT_FAILED", "media transport failed");
    }
  }
  let addresses: readonly string[];
  try {
    addresses = await options.resolveHost(url.hostname);
  } catch {
    throw new InboundMediaFetchError("MEDIA_DNS_FAILED", "media DNS resolution failed");
  }
  const addressPolicy = allResolvedAddressesAllowed(addresses, options.forbiddenHostAddresses);
  if (!addressPolicy.allowed || !addresses[0]) {
    throw new InboundMediaFetchError("MEDIA_ADDRESS_DENIED", "media address is denied");
  }
  try {
    return await options.request({
      url,
      pinnedAddress: addresses[0],
      resolvedAddresses: addresses,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    throw new InboundMediaFetchError("MEDIA_TRANSPORT_FAILED", "media transport failed");
  }
}

async function followRedirects(options: InboundMediaFetchOptions): Promise<Response> {
  let url = validateStartUrl(options.url, options.allowlistedHosts);
  const chain = [url.href];
  for (let redirects = 0; ; redirects += 1) {
    const response = await responseForAllowedHop(url, options);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= MAX_REDIRECTS) {
      throw new InboundMediaFetchError("MEDIA_REDIRECT_LIMIT", "media redirect limit exceeded");
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new InboundMediaFetchError("MEDIA_REDIRECT_INVALID", "media redirect is invalid");
    }
    try {
      url = new URL(location, url);
    } catch {
      throw new InboundMediaFetchError("MEDIA_REDIRECT_INVALID", "media redirect is invalid");
    }
    chain.push(url.href);
    const policy = evaluateRedirectChain(chain, options.allowlistedHosts);
    if (!policy.allowed) {
      throw new InboundMediaFetchError("MEDIA_REDIRECT_DENIED", "media redirect is denied");
    }
  }
}

async function fetchInboundMediaWithinDeadline(
  options: InboundMediaFetchOptions,
): Promise<VerifiedInboundMedia> {
  const maxBytes = options.maxBytes ?? INBOUND_MEDIA_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > INBOUND_MEDIA_MAX_BYTES) {
    throw new RangeError("maxBytes is invalid");
  }
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 1 || options.expectedBytes > maxBytes)
  ) throw new RangeError("expectedBytes is invalid");
  if (options.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/u.test(options.expectedSha256)) {
    throw new TypeError("expectedSha256 is invalid");
  }

  const response = await followRedirects(options);
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new InboundMediaFetchError("MEDIA_RESPONSE_REJECTED", "media response was rejected");
  }
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
    await response.body?.cancel().catch(() => undefined);
    throw new InboundMediaFetchError("MEDIA_COMPRESSION_FORBIDDEN", "compressed media response is forbidden");
  }
  const declaredBytes = canonicalLength(response.headers.get("content-length"));
  if (
    (declaredBytes !== null && declaredBytes > maxBytes) ||
    (declaredBytes !== null && options.expectedBytes !== undefined && declaredBytes !== options.expectedBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new InboundMediaFetchError("MEDIA_LENGTH_MISMATCH", "declared media length is invalid");
  }
  const declaredMime = response.headers.get("content-type");
  if (declaredMime === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new InboundMediaFetchError("MEDIA_MIME_MISSING", "media MIME is missing");
  }
  if (response.body === null) throw new InboundMediaFetchError("MEDIA_BODY_MISSING", "media body is missing");

  const temporary = await createInboundTempFile(options.tempDirectory);
  let handleOpen = true;
  try {
    const digest = createHash("sha256");
    const prefix: Buffer[] = [];
    let prefixBytes = 0;
    let bytes = 0;
    const reader = response.body.getReader();
    let streamComplete = false;
    try {
      for (;;) {
        if (options.signal?.aborted) throw new InboundMediaFetchError("MEDIA_ABORTED", "media fetch aborted");
        const chunk = await reader.read();
        if (chunk.done) {
          streamComplete = true;
          break;
        }
        const value = Buffer.from(chunk.value);
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new InboundMediaFetchError("MEDIA_TOO_LARGE", "media exceeds byte limit");
        digest.update(value);
        if (prefixBytes < MAGIC_PREFIX_MAX_BYTES) {
          const selected = value.subarray(0, MAGIC_PREFIX_MAX_BYTES - prefixBytes);
          prefix.push(selected);
          prefixBytes += selected.byteLength;
        }
        await temporary.handle.write(value);
      }
    } finally {
      if (!streamComplete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (bytes < 1 || (declaredBytes !== null && bytes !== declaredBytes) ||
      (options.expectedBytes !== undefined && bytes !== options.expectedBytes)) {
      throw new InboundMediaFetchError("MEDIA_LENGTH_MISMATCH", "actual media length does not match");
    }
    const sha256 = digest.digest("hex");
    if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
      throw new InboundMediaFetchError("MEDIA_CHECKSUM_MISMATCH", "media checksum does not match");
    }
    const inspection = verifyMediaMagic({
      bytes: Buffer.concat(prefix, prefixBytes),
      declaredMime,
      ...(options.expectedMime === undefined ? {} : { expectedMime: options.expectedMime }),
    });
    await temporary.handle.sync();
    await temporary.handle.close();
    handleOpen = false;
    let disposed = false;
    return Object.freeze({
      path: temporary.path,
      mime: inspection.mime,
      bytes,
      sha256,
      ...(inspection.width === undefined ? {} : { width: inspection.width }),
      ...(inspection.height === undefined ? {} : { height: inspection.height }),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await removeInboundTempFile(temporary.path);
      },
    });
  } catch (error) {
    if (handleOpen) await temporary.handle.close().catch(() => undefined);
    await removeInboundTempFile(temporary.path).catch(() => undefined);
    if (error instanceof InboundMediaFetchError || error instanceof MediaMagicError) throw error;
    throw new InboundMediaFetchError("MEDIA_VERIFICATION_FAILED");
  }
}

export async function fetchInboundMedia(
  options: InboundMediaFetchOptions,
): Promise<VerifiedInboundMedia> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new RangeError("media timeout is invalid");
  }
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("media deadline exceeded"));
  }, timeoutMs);
  try {
    return await fetchInboundMediaWithinDeadline({ ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new InboundMediaFetchError("MEDIA_TIMEOUT", "media deadline exceeded");
    if (options.signal?.aborted) {
      throw new InboundMediaFetchError("MEDIA_ABORTED", "media fetch aborted");
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}

export async function withFetchedInboundMedia<T>(
  options: InboundMediaFetchOptions,
  consume: (media: VerifiedInboundMedia) => Promise<T>,
): Promise<T> {
  const media = await fetchInboundMedia(options);
  try {
    return await consume(media);
  } finally {
    await media.dispose();
  }
}
