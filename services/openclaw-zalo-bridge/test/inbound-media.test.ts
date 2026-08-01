import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allResolvedAddressesAllowed,
  evaluateResolvedAddress,
} from "../src/media/ip-policy.js";
import {
  evaluateRedirectChain,
  isAllowedMediaHost,
  MAX_REDIRECTS,
} from "../src/media/redirect-policy.js";
import {
  fetchInboundMedia,
  withFetchedInboundMedia,
} from "../src/media/inbound-fetch.js";
import {
  cacheVerifiedInboundMedia,
  createInboundMediaProcessor,
} from "../src/media/cache.js";
import { createRuntimeInboundMediaProcessor } from "../src/media/runtime-upload.js";
import {
  cleanupStaleInboundTempFiles,
  INBOUND_TEMP_PREFIX,
} from "../src/media/temp-cleanup.js";
import { inspectMediaMagic } from "../src/media/magic-byte.js";
import { canonicalJson } from "../src/spool/checksum.js";
import { SqliteSpool } from "../src/spool/sqlite-spool.js";

const ALLOWLIST = ["zalo.me", "zaloapp.com", "zdn.vn"];
const cleanup: string[] = [];

function mediaReceiptHash(receipt: unknown): string {
  return createHash("sha256")
    .update("ihome-openclaw-media-upload-receipt-v1\0", "utf8")
    .update(canonicalJson(receipt), "utf8")
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function onePixelPng(): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

describe("Inbound media IP policy", () => {
  it("allows an ordinary public address", () => {
    expect(evaluateResolvedAddress("203.0.113.10").reason).toBe("RESERVED");
    expect(evaluateResolvedAddress("1.1.1.1")).toEqual({ allowed: true });
    expect(evaluateResolvedAddress("2606:4700:4700::1111")).toEqual({ allowed: true });
  });

  it("denies loopback, private, link-local, and metadata addresses", () => {
    expect(evaluateResolvedAddress("127.0.0.1").reason).toBe("LOOPBACK");
    expect(evaluateResolvedAddress("10.1.2.3").reason).toBe("PRIVATE");
    expect(evaluateResolvedAddress("172.16.0.1").reason).toBe("PRIVATE");
    expect(evaluateResolvedAddress("172.32.0.1").allowed).toBe(true);
    expect(evaluateResolvedAddress("192.168.1.1").reason).toBe("PRIVATE");
    expect(evaluateResolvedAddress("169.254.1.1").reason).toBe("LINK_LOCAL");
    expect(evaluateResolvedAddress("169.254.169.254").reason).toBe("METADATA");
  });

  it("denies multicast, unspecified, carrier-grade NAT, and reserved space", () => {
    expect(evaluateResolvedAddress("224.0.0.1").reason).toBe("MULTICAST");
    expect(evaluateResolvedAddress("0.0.0.0").reason).toBe("UNSPECIFIED");
    expect(evaluateResolvedAddress("100.64.0.1").reason).toBe("RESERVED");
    expect(evaluateResolvedAddress("240.0.0.1").reason).toBe("RESERVED");
  });

  it("denies IPv6 loopback, link-local, unique-local, and multicast", () => {
    expect(evaluateResolvedAddress("::1").reason).toBe("LOOPBACK");
    expect(evaluateResolvedAddress("fe80::1").reason).toBe("LINK_LOCAL");
    expect(evaluateResolvedAddress("febf::1").reason).toBe("LINK_LOCAL");
    expect(evaluateResolvedAddress("fd00::1").reason).toBe("UNIQUE_LOCAL");
    expect(evaluateResolvedAddress("fc00::1").reason).toBe("UNIQUE_LOCAL");
    expect(evaluateResolvedAddress("ff02::1").reason).toBe("MULTICAST");
    expect(evaluateResolvedAddress("::").reason).toBe("UNSPECIFIED");
  });

  it("judges IPv4-mapped IPv6 by the IPv4 rules so mapping cannot bypass policy", () => {
    expect(evaluateResolvedAddress("::ffff:127.0.0.1").reason).toBe("LOOPBACK");
    expect(evaluateResolvedAddress("::ffff:169.254.169.254").reason).toBe("METADATA");
    expect(evaluateResolvedAddress("::ffff:10.0.0.1").reason).toBe("PRIVATE");
  });

  it("denies transition-space addresses that can tunnel a private destination", () => {
    expect(evaluateResolvedAddress("2002:7f00:1::").reason).toBe("RESERVED");
    expect(evaluateResolvedAddress("64:ff9b:1::1").reason).toBe("RESERVED");
  });

  it("denies the configured 9Router or CLI host even when its address is public", () => {
    expect(evaluateResolvedAddress("1.1.1.1", ["1.1.1.1"]).reason).toBe("FORBIDDEN_HOST");
  });

  it("rejects a garbage address rather than defaulting to allow", () => {
    expect(evaluateResolvedAddress("not-an-ip").reason).toBe("INVALID_ADDRESS");
    expect(evaluateResolvedAddress("").reason).toBe("INVALID_ADDRESS");
  });

  it("requires every resolved address to pass, not just the first", () => {
    expect(allResolvedAddressesAllowed(["1.1.1.1", "127.0.0.1"]).reason).toBe("LOOPBACK");
    expect(allResolvedAddressesAllowed(["1.1.1.1", "8.8.8.8"])).toEqual({ allowed: true });
    expect(allResolvedAddressesAllowed([]).reason).toBe("INVALID_ADDRESS");
  });
});

describe("Inbound media redirect policy", () => {
  it("allows an exact host or a subdomain of an allowlisted host", () => {
    expect(isAllowedMediaHost("zalo.me", ALLOWLIST)).toBe(true);
    expect(isAllowedMediaHost("cdn.zalo.me", ALLOWLIST)).toBe(true);
    expect(isAllowedMediaHost("evil.com", ALLOWLIST)).toBe(false);
    expect(isAllowedMediaHost("notzalo.me", ALLOWLIST)).toBe(false);
  });

  it("caps the redirect chain at three hops", () => {
    const chain = (count: number) =>
      Array.from({ length: count + 1 }, (_unused, index) => `https://cdn.zalo.me/${index}`);
    expect(evaluateRedirectChain(chain(MAX_REDIRECTS), ALLOWLIST).allowed).toBe(true);
    expect(evaluateRedirectChain(chain(MAX_REDIRECTS + 1), ALLOWLIST).reason)
      .toBe("TOO_MANY_REDIRECTS");
  });

  it("revalidates the scheme at every hop", () => {
    expect(
      evaluateRedirectChain(
        ["https://cdn.zalo.me/a", "http://cdn.zalo.me/b"],
        ALLOWLIST,
      ).reason,
    ).toBe("SCHEME_DOWNGRADE");
  });

  it("revalidates the host at every hop, not just the first", () => {
    expect(
      evaluateRedirectChain(
        ["https://cdn.zalo.me/a", "https://evil.example/b"],
        ALLOWLIST,
      ).reason,
    ).toBe("HOST_NOT_ALLOWED");
  });

  it("rejects credentials embedded in a redirect target", () => {
    expect(
      evaluateRedirectChain(["https://user:pass@cdn.zalo.me/a"], ALLOWLIST).reason,
    ).toBe("INVALID_URL");
  });

  it("rejects non-default HTTPS ports at every hop", () => {
    expect(
      evaluateRedirectChain(["https://cdn.zalo.me:8443/a"], ALLOWLIST).reason,
    ).toBe("NON_DEFAULT_PORT");
  });
});

describe("Inbound media dimension-bomb rejection", () => {
  it("parses VP8L dimensions instead of accepting an unbounded WebP", () => {
    const webp = Buffer.alloc(25);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8L", 12, "ascii");
    webp[20] = 0x2f;
    // VP8L stores width-1 in 14 bits. This encodes width 8193, one above cap.
    webp[21] = 0x00;
    webp[22] = 0x20;
    expect(() => inspectMediaMagic(webp)).toThrow(/dimension/i);
  });
});

describe("Inbound media fetch, verification, cache, and cleanup", () => {
  it("aborts a brokered provider GET at the hard media deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-timeout-"));
    cleanup.push(directory);
    const brokerFetch = vi.fn(async (_url: URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));

    await expect(fetchInboundMedia({
      url: "https://cdn.zalo.me/media/timeout",
      allowlistedHosts: ALLOWLIST,
      expectedMime: "image/png",
      expectedBytes: 24,
      tempDirectory: directory,
      timeoutMs: 100,
      egress: { fetch: brokerFetch },
    })).rejects.toMatchObject({ code: "MEDIA_TIMEOUT" });
    expect(brokerFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("propagates caller cancellation into the brokered provider fetch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-caller-abort-"));
    cleanup.push(directory);
    const brokerFetch = vi.fn(async (_url: URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));
    const processMedia = createRuntimeInboundMediaProcessor({
      runtime: { post: vi.fn() },
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      timeoutMs: 1_000,
      egress: { fetch: brokerFetch },
    });
    const controller = new AbortController();
    const operation = processMedia({
      localSequence: 1,
      mediaManifest: [{
        version: 1,
        index: 0,
        providerMediaId: "provider-media-1",
        kind: "IMAGE",
        mime: "image/png",
        byteLength: 24,
        providerChecksum: null,
        fetchRef: "https://cdn.zalo.me/1",
        byteState: "PENDING",
      }],
    } as never, [{
      manifestIndex: 0,
      mediaId: "dddd9000-0000-4000-8000-000000000020",
    }], controller.signal);

    await vi.waitFor(() => expect(brokerFetch).toHaveBeenCalledOnce());
    controller.abort(new Error("bridge stopping"));

    await expect(operation).rejects.toMatchObject({ code: "MEDIA_ABORTED" });
    expect(brokerFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it("requires one broker transport for both provider download and gateway upload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-broker-"));
    cleanup.push(directory);
    const event = {
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      mediaManifest: [{
        version: 1,
        index: 0,
        providerMediaId: "provider-media-1",
        kind: "IMAGE",
        mime: "image/png",
        byteLength: 24,
        providerChecksum: null,
        fetchRef: "https://cdn.zalo.me/1",
        byteState: "PENDING",
      }],
    } as never;
    const mediaId = "dddd9000-0000-4000-8000-000000000020";
    const ticketId = "dddd9000-0000-4000-8000-000000000021";
    const receiptId = "dddd9000-0000-4000-8000-000000000022";
    const mediaSha256 = createHash("sha256").update(onePixelPng()).digest("hex");
    const objectKey = `v1/org/${event.organizationId}/account/${event.accountId}/media/${mediaId}/original.png`;
    const ticket = {
      version: 1, aud: "openclaw-media-gateway", operation: "PUT", subject: "RUNTIME",
      jti: ticketId, organizationId: event.organizationId, accountId: event.accountId,
      objectKey, sha256: mediaSha256, contentType: "image/png", contentLength: 24,
      sessionGeneration: 5, gatewayKeyGeneration: 1, receiptSigningKeyGeneration: 1,
      iat: 1_785_062_400,
      exp: 1_785_062_430, cellId: event.cellId, credentialGeneration: 4,
      leaseGeneration: 3, fencingToken: 7, signature: "A".repeat(86),
    };
    const receipt = {
      version: 1, receiptKind: "MEDIA_UPLOAD", receiptId,
      organizationId: event.organizationId, accountId: event.accountId, cellId: event.cellId,
      mediaId, objectKey, sha256: mediaSha256, contentType: "image/png", contentLength: 24,
      uploadTicketJti: ticketId, credentialGeneration: 4, leaseGeneration: 3,
      fencingToken: 7, sessionGeneration: 5, objectVersionOrEtag: "version-1",
      storedAt: "2026-08-01T00:00:00.000Z", gatewaySigningKeyGeneration: 1,
      signature: "A".repeat(86),
    };
    const runtime = { post: vi.fn(async (path: string) => path === "/v1/media/upload-ticket"
      ? { version: 1, ticketId, ticketHash: "b".repeat(64), expiresAt: "2026-08-01T00:00:30.000Z", state: "ISSUED", ticket }
      : { version: 1, mediaId, byteState: "AVAILABLE", receiptHash: mediaReceiptHash(receipt), idempotentReplay: false }) };
    const brokerFetch = vi.fn(async (url: URL, init?: RequestInit) => {
      if (url.hostname === "cdn.zalo.me") {
        expect(init?.method).toBe("GET");
        return new Response(onePixelPng(), { status: 200, headers: { "content-type": "image/png", "content-length": "24" } });
      }
      expect(url.href).toBe("https://media.example/v1/object");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify(receipt), { status: 201, headers: { "content-type": "application/json" } });
    });
    const processMedia = createRuntimeInboundMediaProcessor({
      runtime,
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      timeoutMs: 1_000,
      egress: { fetch: brokerFetch },
    });

    await processMedia(event, [{ manifestIndex: 0, mediaId }]);

    expect(brokerFetch.mock.calls.map(([url]) => url.hostname)).toEqual([
      "cdn.zalo.me",
      "media.example",
    ]);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects an oversized brokered gateway receipt body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-receipt-cap-"));
    cleanup.push(directory);
    const event = {
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      mediaManifest: [{
        version: 1, index: 0, providerMediaId: "provider-media-1", kind: "IMAGE",
        mime: "image/png", byteLength: 24, providerChecksum: null,
        fetchRef: "https://cdn.zalo.me/1", byteState: "PENDING",
      }],
    } as never;
    const mediaId = "dddd9000-0000-4000-8000-000000000030";
    const ticketId = "dddd9000-0000-4000-8000-000000000031";
    const mediaSha256 = createHash("sha256").update(onePixelPng()).digest("hex");
    const ticket = {
      version: 1, aud: "openclaw-media-gateway", operation: "PUT", subject: "RUNTIME",
      jti: ticketId, organizationId: event.organizationId, accountId: event.accountId,
      objectKey: `v1/org/${event.organizationId}/account/${event.accountId}/media/${mediaId}/original.png`,
      sha256: mediaSha256, contentType: "image/png", contentLength: 24,
      sessionGeneration: 5, gatewayKeyGeneration: 1, receiptSigningKeyGeneration: 1,
      iat: 1_785_062_400,
      exp: 1_785_062_430, cellId: event.cellId, credentialGeneration: 4,
      leaseGeneration: 3, fencingToken: 7, signature: "A".repeat(86),
    };
    const runtime = { post: vi.fn(async () => ({
      version: 1, ticketId, ticketHash: "b".repeat(64),
      expiresAt: "2026-08-01T00:00:30.000Z", state: "ISSUED", ticket,
    })) };
    const brokerFetch = vi.fn(async (url: URL) => url.hostname === "cdn.zalo.me"
      ? new Response(onePixelPng(), { status: 200, headers: { "content-type": "image/png", "content-length": "24" } })
      : new Response(JSON.stringify({ oversized: "x".repeat(70 * 1024) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }));
    const processMedia = createRuntimeInboundMediaProcessor({
      runtime,
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      timeoutMs: 1_000,
      egress: { fetch: brokerFetch },
    });

    await expect(processMedia(event, [{ manifestIndex: 0, mediaId }]))
      .rejects.toThrow(/receipt.*(?:large|cap)|byte cap/i);
    expect(runtime.post).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });


  it("uploads each Runtime-mapped media byte stream and finalizes its signed gateway receipt before ack", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-runtime-upload-"));
    cleanup.push(directory);
    const mediaId = "dddd9000-0000-4000-8000-000000000010";
    const ticketId = "dddd9000-0000-4000-8000-000000000011";
    const receiptId = "dddd9000-0000-4000-8000-000000000012";
    const event = {
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      mediaManifest: [{
        version: 1,
        index: 0,
        providerMediaId: "provider-media-1",
        kind: "IMAGE",
        mime: "image/png",
        byteLength: 24,
        providerChecksum: null,
        fetchRef: "https://cdn.zalo.me/1",
        byteState: "PENDING",
      }],
    } as never;
    const sha256 = createHash("sha256").update(onePixelPng()).digest("hex");
    const ticket = {
      version: 1,
      aud: "openclaw-media-gateway",
      operation: "PUT",
      subject: "RUNTIME",
      jti: ticketId,
      organizationId: event.organizationId,
      accountId: event.accountId,
      objectKey: `v1/org/${event.organizationId}/account/${event.accountId}/media/${mediaId}/original.png`,
      sha256,
      contentType: "image/png",
      contentLength: 24,
      sessionGeneration: 5,
      gatewayKeyGeneration: 1,
      receiptSigningKeyGeneration: 9,
      iat: 1_785_062_400,
      exp: 1_785_062_430,
      cellId: event.cellId,
      credentialGeneration: 4,
      leaseGeneration: 3,
      fencingToken: 7,
      signature: "A".repeat(86),
    };
    const receipt = {
      version: 1,
      receiptKind: "MEDIA_UPLOAD",
      receiptId,
      organizationId: event.organizationId,
      accountId: event.accountId,
      cellId: event.cellId,
      mediaId,
      objectKey: ticket.objectKey,
      sha256,
      contentType: "image/png",
      contentLength: 24,
      uploadTicketJti: ticketId,
      credentialGeneration: 4,
      leaseGeneration: 3,
      fencingToken: 7,
      sessionGeneration: 5,
      objectVersionOrEtag: "version-1",
      storedAt: "2026-08-01T00:00:00.000Z",
      gatewaySigningKeyGeneration: 9,
      signature: "A".repeat(86),
    };
    const runtime = {
      post: vi.fn(async (path: string, body: unknown) => {
        if (path === "/v1/media/upload-ticket") {
          expect(body).toEqual({
            version: 1,
            mediaId,
            operation: "PUT",
            verifiedSha256: sha256,
            contentType: "image/png",
            contentLength: 24,
          });
          return { version: 1, ticketId, ticketHash: "b".repeat(64), expiresAt: "2026-08-01T00:00:30.000Z", state: "ISSUED", ticket };
        }
        expect(path).toBe("/v1/media/upload-complete");
        expect(body).toEqual({ version: 1, mediaId, gatewayReceipt: receipt });
        return { version: 1, mediaId, byteState: "AVAILABLE", receiptHash: mediaReceiptHash(receipt), idempotentReplay: false };
      }),
    };
    const mismatchedBrokerFetch = vi.fn(async (url: URL) => url.hostname === "cdn.zalo.me"
      ? new Response(onePixelPng(), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "24" },
        })
      : new Response(JSON.stringify({ ...receipt, gatewaySigningKeyGeneration: 8 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }));
    const rejectMismatchedReceipt = createRuntimeInboundMediaProcessor({
      runtime,
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      egress: { fetch: mismatchedBrokerFetch },
    });

    await expect(rejectMismatchedReceipt(event, [{ manifestIndex: 0, mediaId }]))
      .rejects.toThrow(/receipt.*bound to ticket/i);
    expect(runtime.post).toHaveBeenCalledTimes(1);
    runtime.post.mockClear();

    const upload = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.method).toBe("PUT");
      expect(init.headers).toMatchObject({ "content-type": "image/png", "content-length": "24" });
      return new Response(JSON.stringify(receipt), { status: 201, headers: { "content-type": "application/json" } });
    });
    const brokerFetch = vi.fn(async (url: URL, init: RequestInit) => url.hostname === "cdn.zalo.me"
      ? new Response(onePixelPng(), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "24" },
        })
      : await upload(url, init));
    const processMedia = createRuntimeInboundMediaProcessor({
      runtime,
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      egress: { fetch: brokerFetch },
    });

    await processMedia(event, [{ manifestIndex: 0, mediaId }]);

    expect(runtime.post).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps pressure-deferred media pending and retryable instead of terminal-skipping it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-pressure-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"));
    try {
      const appended = spool.append({
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        eventKind: "MESSAGE",
        providerEventId: "pressure-event",
        providerMessageId: "pressure-message",
        providerTimestamp: Date.now(),
        rawPayload: { raw: true },
        normalizedPayload: { text: "image" },
        mediaManifest: [{
          index: 0,
          kind: "IMAGE",
          mime: "image/png",
          byteLength: 24,
          providerChecksum: null,
          fetchRef: "https://cdn.zalo.me/pressure",
        }],
      });
      const event = spool.pending()[0]!;
      const mediaId = "dddd9000-0000-4000-8000-000000000040";
      const processMedia = createRuntimeInboundMediaProcessor({
        runtime: { post: vi.fn() },
        gatewayUrl: "https://media.example/v1/object",
        allowlistedHosts: ALLOWLIST,
        tempDirectory: directory,
        checkpoints: spool,
        mediaPrefetchAllowed: () => false,
        egress: { fetch: vi.fn() },
      });

      await expect(processMedia(event, [{ manifestIndex: 0, mediaId }]))
        .rejects.toThrow(/pressure|defer|prefetch/i);
      expect(spool.mediaCheckpoint(appended.localSequence!, 0)).toMatchObject({
        state: "PENDING",
        retryCount: 0,
        terminalReason: null,
      });
    } finally {
      spool.close();
    }
  });

  it("terminally skips GIF and WebP manifests before provider fetch or ticket issuance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-unsupported-image-"));
    cleanup.push(directory);
    const runtime = { post: vi.fn() };
    const gatewayFetch = vi.fn();
    const processMedia = createRuntimeInboundMediaProcessor({
      runtime,
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      egress: { fetch: gatewayFetch },
    });
    const event = {
      localSequence: 1,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      mediaManifest: [
        {
          index: 0,
          kind: "IMAGE",
          mime: "image/gif",
          byteLength: 24,
          providerChecksum: null,
          fetchRef: "https://cdn.zalo.me/unsupported.gif",
        },
        {
          index: 1,
          kind: "IMAGE",
          mime: "image/webp",
          byteLength: 24,
          providerChecksum: null,
          fetchRef: "https://cdn.zalo.me/unsupported.webp",
        },
      ],
    } as never;

    await expect(processMedia(event, [
      { manifestIndex: 0, mediaId: "dddd9000-0000-4000-8000-000000000070" },
      { manifestIndex: 1, mediaId: "dddd9000-0000-4000-8000-000000000071" },
    ])).resolves.toBeUndefined();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(runtime.post).not.toHaveBeenCalled();
  });

  it("verifies an explicit provider SHA-256 before requesting an upload ticket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-provider-sha-"));
    cleanup.push(directory);
    const runtime = { post: vi.fn() };
    const processMedia = createRuntimeInboundMediaProcessor({
      runtime,
      gatewayUrl: "https://media.example/v1/object",
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      egress: { fetch: vi.fn(async () => new Response(onePixelPng(), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "24" },
      })) },
    });
    const event = {
      localSequence: 1,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      mediaManifest: [{
        index: 0,
        kind: "IMAGE",
        mime: "image/png",
        byteLength: 24,
        providerChecksum: "f".repeat(64),
        fetchRef: "https://cdn.zalo.me/checksum",
      }],
    } as never;

    await expect(processMedia(event, [{
      manifestIndex: 0,
      mediaId: "dddd9000-0000-4000-8000-000000000045",
    }])).rejects.toMatchObject({ code: "MEDIA_CHECKSUM_MISMATCH" });
    expect(runtime.post).not.toHaveBeenCalled();
  });

  it("never discards a stored gateway receipt after repeated finalize failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-receipt-retry-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"));
    try {
      const appended = spool.append({
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        eventKind: "MESSAGE",
        providerEventId: "receipt-event",
        providerMessageId: "receipt-message",
        providerTimestamp: Date.now(),
        rawPayload: { raw: true },
        normalizedPayload: { text: "image" },
        mediaManifest: [{
          index: 0,
          kind: "IMAGE",
          mime: "image/png",
          byteLength: 24,
          providerChecksum: null,
          fetchRef: "https://cdn.zalo.me/receipt",
        }],
      });
      const event = spool.pending()[0]!;
      const mediaId = "dddd9000-0000-4000-8000-000000000050";
      const ticketId = "dddd9000-0000-4000-8000-000000000051";
      const receiptId = "dddd9000-0000-4000-8000-000000000052";
      const checksum = createHash("sha256").update(onePixelPng()).digest("hex");
      const ticket = {
        version: 1, aud: "openclaw-media-gateway", operation: "PUT", subject: "RUNTIME",
        jti: ticketId, organizationId: event.organizationId, accountId: event.accountId,
        objectKey: `v1/org/${event.organizationId}/account/${event.accountId}/media/${mediaId}/original.png`,
        sha256: checksum, contentType: "image/png", contentLength: 24,
        sessionGeneration: 5, gatewayKeyGeneration: 1, receiptSigningKeyGeneration: 1,
        iat: 1_785_062_400,
        exp: 1_785_062_430, cellId: event.cellId, credentialGeneration: 4,
        leaseGeneration: 3, fencingToken: 7, signature: "A".repeat(86),
      };
      const receipt = {
        version: 1, receiptKind: "MEDIA_UPLOAD", receiptId,
        organizationId: event.organizationId, accountId: event.accountId, cellId: event.cellId,
        mediaId, objectKey: ticket.objectKey, sha256: checksum, contentType: "image/png",
        contentLength: 24, uploadTicketJti: ticketId, credentialGeneration: 4,
        leaseGeneration: 3, fencingToken: 7, sessionGeneration: 5,
        objectVersionOrEtag: "version-1", storedAt: "2026-08-01T00:00:00.000Z",
        gatewaySigningKeyGeneration: 1, signature: "A".repeat(86),
      };
      spool.ensureMediaCheckpoint(appended.localSequence!, 0, mediaId);
      spool.storeMediaTicket(appended.localSequence!, 0, ticketId, ticket);
      spool.storeMediaReceipt(
        appended.localSequence!,
        0,
        receipt,
        mediaReceiptHash(receipt),
      );
      const processMedia = createRuntimeInboundMediaProcessor({
        runtime: { post: vi.fn(async () => { throw new Error("Runtime unavailable"); }) },
        gatewayUrl: "https://media.example/v1/object",
        allowlistedHosts: ALLOWLIST,
        tempDirectory: directory,
        checkpoints: spool,
        egress: { fetch: vi.fn() },
      });

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await expect(processMedia(event, [{ manifestIndex: 0, mediaId }])).rejects.toThrow();
      }
      expect(spool.mediaCheckpoint(appended.localSequence!, 0)).toMatchObject({
        state: "RECEIPT_STORED",
        retryCount: 3,
        terminalReason: null,
        gatewayReceipt: receipt,
      });
    } finally {
      spool.close();
    }
  });

  it("replays an old ticket before refreshing only after an explicit expired-no-work response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-expired-ticket-"));
    cleanup.push(directory);
    const spool = new SqliteSpool(join(directory, "spool.db"));
    try {
      const appended = spool.append({
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        accountId: "dddd1000-0000-4000-8000-000000000001",
        cellId: "dddd2000-0000-4000-8000-000000000001",
        sessionGeneration: 5,
        eventKind: "MESSAGE",
        providerEventId: "expired-event",
        providerMessageId: "expired-message",
        providerTimestamp: Date.now(),
        rawPayload: { raw: true },
        normalizedPayload: { text: "image" },
        mediaManifest: [{
          index: 0,
          kind: "IMAGE",
          mime: "image/png",
          byteLength: 24,
          providerChecksum: null,
          fetchRef: "https://cdn.zalo.me/expired",
        }],
      });
      const event = spool.pending()[0]!;
      const mediaId = "dddd9000-0000-4000-8000-000000000060";
      const oldTicketId = "dddd9000-0000-4000-8000-000000000061";
      const freshTicketId = "dddd9000-0000-4000-8000-000000000062";
      const receiptId = "dddd9000-0000-4000-8000-000000000063";
      const checksum = createHash("sha256").update(onePixelPng()).digest("hex");
      const ticket = (jti: string, exp: number) => ({
        version: 1, aud: "openclaw-media-gateway", operation: "PUT", subject: "RUNTIME",
        jti, organizationId: event.organizationId, accountId: event.accountId,
        objectKey: `v1/org/${event.organizationId}/account/${event.accountId}/media/${mediaId}/original.png`,
        sha256: checksum, contentType: "image/png", contentLength: 24,
        sessionGeneration: 5, gatewayKeyGeneration: 1, receiptSigningKeyGeneration: 1,
        iat: exp - 30, exp,
        cellId: event.cellId, credentialGeneration: 4, leaseGeneration: 3,
        fencingToken: 7, signature: "A".repeat(86),
      });
      const oldTicket = ticket(oldTicketId, 1_785_062_430);
      const freshTicket = ticket(freshTicketId, 1_785_062_550);
      const receipt = {
        version: 1, receiptKind: "MEDIA_UPLOAD", receiptId,
        organizationId: event.organizationId, accountId: event.accountId, cellId: event.cellId,
        mediaId, objectKey: freshTicket.objectKey, sha256: checksum, contentType: "image/png",
        contentLength: 24, uploadTicketJti: freshTicketId, credentialGeneration: 4,
        leaseGeneration: 3, fencingToken: 7, sessionGeneration: 5,
        objectVersionOrEtag: "version-1", storedAt: "2026-08-01T00:02:00.000Z",
        gatewaySigningKeyGeneration: 1, signature: "A".repeat(86),
      };
      spool.ensureMediaCheckpoint(appended.localSequence!, 0, mediaId);
      spool.storeMediaTicket(appended.localSequence!, 0, oldTicketId, oldTicket);
      const runtime = {
        post: vi.fn(async (path: string) => path === "/v1/media/upload-ticket"
          ? {
              version: 1,
              ticketId: freshTicketId,
              ticketHash: "b".repeat(64),
              expiresAt: "2026-08-01T00:02:30.000Z",
              state: "ISSUED",
              ticket: freshTicket,
            }
          : {
              version: 1,
              mediaId,
              byteState: "AVAILABLE",
              receiptHash: mediaReceiptHash(receipt),
              idempotentReplay: false,
            }),
      };
      let uploadAttempt = 0;
      let returnExplicitExpiredNoWork = false;
      const gatewayFetch = vi.fn(async (url: URL, init: RequestInit) => {
        if (url.hostname === "cdn.zalo.me") {
          return new Response(onePixelPng(), {
            status: 200,
            headers: { "content-type": "image/png", "content-length": "24" },
          });
        }
        uploadAttempt += 1;
        const encoded = (init.headers as Record<string, string>)["x-openclaw-media-ticket"];
        const uploadedTicket = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (uploadedTicket.jti === oldTicketId) {
          expect(uploadedTicket.jti).toBe(oldTicketId);
          if (!returnExplicitExpiredNoWork) {
            return new Response("ambiguous gateway failure", { status: 503 });
          }
          return new Response(JSON.stringify({
            error: { code: "TICKET_EXPIRED_NO_WORK" },
          }), { status: 410, headers: { "content-type": "application/json" } });
        }
        expect(uploadedTicket.jti).toBe(freshTicketId);
        return new Response(JSON.stringify(receipt), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      });
      const processMedia = createRuntimeInboundMediaProcessor({
        runtime,
        gatewayUrl: "https://media.example/v1/object",
        allowlistedHosts: ALLOWLIST,
        tempDirectory: directory,
        checkpoints: spool,
        egress: { fetch: gatewayFetch },
      });

      await expect(processMedia(event, [{ manifestIndex: 0, mediaId }]))
        .rejects.toThrow(/gateway upload failed/i);
      expect(runtime.post).not.toHaveBeenCalled();
      expect(spool.mediaCheckpoint(appended.localSequence!, 0)).toMatchObject({
        state: "TICKET_ISSUED",
        ticketJti: oldTicketId,
        retryCount: 1,
      });

      returnExplicitExpiredNoWork = true;
      await processMedia(event, [{ manifestIndex: 0, mediaId }]);

      expect(uploadAttempt).toBe(3);
      expect(runtime.post.mock.calls.map(([path]) => path)).toEqual([
        "/v1/media/upload-ticket",
        "/v1/media/upload-complete",
      ]);
      expect(spool.mediaCheckpoint(appended.localSequence!, 0)).toMatchObject({
        state: "AVAILABLE",
        ticketJti: freshTicketId,
        retryCount: 1,
      });
    } finally {
      spool.close();
    }
  });

  it("pins public DNS, verifies magic bytes, caches a small image, and removes temp bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-"));
    cleanup.push(directory);
    const request = vi.fn(async ({ pinnedAddress }: { pinnedAddress: string }) => {
      expect(pinnedAddress).toBe("1.1.1.1");
      return new Response(onePixelPng(), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "24" },
      });
    });
    const upload = vi.fn(async () => ({ objectKey: "private/media.png" }));

    const result = await withFetchedInboundMedia({
      url: "https://cdn.zalo.me/media/1",
      allowlistedHosts: ALLOWLIST,
      expectedMime: "image/png",
      expectedBytes: 24,
      tempDirectory: directory,
      resolveHost: async () => ["1.1.1.1"],
      request,
    }, async (media) => {
      expect(media).toMatchObject({ mime: "image/png", bytes: 24, width: 1, height: 1 });
      return await cacheVerifiedInboundMedia(media, { upload });
    });

    expect(result).toEqual({ status: "CACHED", objectKey: "private/media.png" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("cleans partial bytes when MIME/magic verification fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-fail-"));
    cleanup.push(directory);

    await expect(fetchInboundMedia({
      url: "https://cdn.zalo.me/media/1",
      allowlistedHosts: ALLOWLIST,
      expectedMime: "image/jpeg",
      tempDirectory: directory,
      resolveHost: async () => ["1.1.1.1"],
      request: async () => new Response(onePixelPng(), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    })).rejects.toThrow(/mime|magic/i);
    expect(await readdir(directory)).toEqual([]);
  });

  it("cancels the response stream and removes partial bytes after a byte-cap failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-cap-"));
    cleanup.push(directory);
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(25));
      },
      cancel,
    });

    await expect(fetchInboundMedia({
      url: "https://cdn.zalo.me/media/oversized",
      allowlistedHosts: ALLOWLIST,
      maxBytes: 24,
      tempDirectory: directory,
      resolveHost: async () => ["1.1.1.1"],
      request: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    })).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("auto-processes only eligible small-image manifest entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-processor-"));
    cleanup.push(directory);
    const request = vi.fn(async () => new Response(onePixelPng(), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "24" },
    }));
    const upload = vi.fn(async () => ({ objectKey: "private/media.png" }));
    const processMedia = createInboundMediaProcessor({
      allowlistedHosts: ALLOWLIST,
      tempDirectory: directory,
      resolveHost: async () => ["1.1.1.1"],
      request,
      upload,
    });
    const base = {
      localSequence: 1,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
    };

    await processMedia({
      ...base,
      mediaManifest: [
        { kind: "IMAGE", mime: "image/png", byteLength: 24, providerChecksum: null, fetchRef: "https://cdn.zalo.me/1" },
        { kind: "FILE", mime: "application/pdf", byteLength: 24, providerChecksum: null, fetchRef: "https://cdn.zalo.me/2" },
        { kind: "IMAGE", mime: "image/png", byteLength: 5 * 1024 * 1024 + 1, providerChecksum: null, fetchRef: "https://cdn.zalo.me/3" },
      ],
    } as never);

    expect(request).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("propagates configured forbidden infrastructure addresses through the media processor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-forbidden-"));
    cleanup.push(directory);
    const request = vi.fn(async () => new Response(onePixelPng(), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "24" },
    }));
    const processMedia = createInboundMediaProcessor({
      allowlistedHosts: ALLOWLIST,
      forbiddenHostAddresses: ["8.8.8.8"],
      tempDirectory: directory,
      resolveHost: async () => ["8.8.8.8"],
      request,
      upload: vi.fn(async () => ({ objectKey: "private/media.png" })),
    });

    await expect(processMedia({
      localSequence: 1,
      organizationId: "dddd0000-0000-4000-8000-000000000001",
      accountId: "dddd1000-0000-4000-8000-000000000001",
      cellId: "dddd2000-0000-4000-8000-000000000001",
      mediaManifest: [{
        kind: "IMAGE",
        mime: "image/png",
        byteLength: 24,
        providerChecksum: null,
        fetchRef: "https://cdn.zalo.me/1",
      }],
    } as never)).rejects.toMatchObject({ code: "MEDIA_ADDRESS_DENIED" });
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("removes every owned orphan on restart even at the exact startup timestamp", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openclaw-media-restart-"));
    cleanup.push(directory);
    const path = join(directory, `${INBOUND_TEMP_PREFIX}orphan.part`);
    const nowMs = 1_785_062_400_000;
    await writeFile(path, "partial", "utf8");
    await utimes(path, nowMs / 1_000, nowMs / 1_000);

    await expect(cleanupStaleInboundTempFiles({ directory, nowMs, maxAgeMs: 0 }))
      .resolves.toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });
});
