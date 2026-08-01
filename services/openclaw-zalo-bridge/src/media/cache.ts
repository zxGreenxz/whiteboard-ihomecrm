import {
  withFetchedInboundMedia,
  type DirectMediaResolver,
  type PinnedMediaRequest,
  type VerifiedInboundMedia,
} from "./inbound-fetch.js";
import type { SpooledEvent } from "../spool/sqlite-spool.js";

export const AUTO_CACHE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export type InboundMediaCacheResult =
  | Readonly<{ status: "CACHED"; objectKey: string }>
  | Readonly<{ status: "SKIPPED"; reason: "NOT_IMAGE" | "IMAGE_TOO_LARGE" }>;

export async function cacheVerifiedInboundMedia(
  media: VerifiedInboundMedia,
  dependencies: {
    upload(input: {
      path: string;
      mime: string;
      bytes: number;
      sha256: string;
    }): Promise<{ objectKey: string }>;
  },
): Promise<InboundMediaCacheResult> {
  if (!media.mime.startsWith("image/")) {
    return Object.freeze({ status: "SKIPPED", reason: "NOT_IMAGE" });
  }
  if (media.bytes > AUTO_CACHE_IMAGE_MAX_BYTES) {
    return Object.freeze({ status: "SKIPPED", reason: "IMAGE_TOO_LARGE" });
  }
  const uploaded = await dependencies.upload({
    path: media.path,
    mime: media.mime,
    bytes: media.bytes,
    sha256: media.sha256,
  });
  if (!uploaded || typeof uploaded.objectKey !== "string" || uploaded.objectKey.length === 0) {
    throw new TypeError("media cache upload result is invalid");
  }
  return Object.freeze({ status: "CACHED", objectKey: uploaded.objectKey });
}

export function createInboundMediaProcessor(options: {
  allowlistedHosts: readonly string[];
  forbiddenHostAddresses?: readonly string[];
  tempDirectory: string;
  resolveHost: DirectMediaResolver;
  request: PinnedMediaRequest;
  upload(input: {
    event: SpooledEvent;
    manifestEntry: Readonly<Record<string, unknown>>;
    path: string;
    mime: string;
    bytes: number;
    sha256: string;
  }): Promise<{ objectKey: string }>;
}): (event: SpooledEvent) => Promise<void> {
  return async (event: SpooledEvent): Promise<void> => {
    for (const value of event.mediaManifest) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const manifestEntry = value as Readonly<Record<string, unknown>>;
      const bytes = manifestEntry.byteLength;
      if (
        manifestEntry.kind !== "IMAGE" || typeof manifestEntry.fetchRef !== "string" ||
        manifestEntry.fetchRef.length === 0 || typeof manifestEntry.mime !== "string" ||
        !Number.isSafeInteger(bytes) || (bytes as number) < 1 ||
        (bytes as number) > AUTO_CACHE_IMAGE_MAX_BYTES
      ) continue;
      const checksum = manifestEntry.providerChecksum;
      if (checksum !== null && (typeof checksum !== "string" || !/^[0-9a-f]{64}$/u.test(checksum))) {
        throw new TypeError("inbound media provider checksum is invalid");
      }
      await withFetchedInboundMedia({
        url: manifestEntry.fetchRef,
        allowlistedHosts: options.allowlistedHosts,
        expectedMime: manifestEntry.mime,
        expectedBytes: bytes as number,
        ...(typeof checksum === "string" ? { expectedSha256: checksum } : {}),
        ...(options.forbiddenHostAddresses === undefined
          ? {}
          : { forbiddenHostAddresses: options.forbiddenHostAddresses }),
        tempDirectory: options.tempDirectory,
        resolveHost: options.resolveHost,
        request: options.request,
      }, async (media) => await cacheVerifiedInboundMedia(media, {
        upload: async (input) => await options.upload({
          event,
          manifestEntry,
          ...input,
        }),
      }));
    }
  };
}
