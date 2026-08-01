/**
 * Content policy for every byte the gateway accepts. Declared metadata is never
 * trusted on its own: the magic bytes, the actual length, and the actual digest
 * must all agree with the ticket before an object is stored.
 */

export const MAX_OBJECT_BYTES = 52_428_800; // 50 MiB

export interface MediaTypeRule {
  contentType: string;
  /** Leading bytes that must be present for the type to be accepted. */
  magic: readonly (readonly number[])[];
  /** Maximum decoded pixels, when the type is an image. */
  maxPixels?: number;
}

export const ALLOWED_MEDIA_TYPES: readonly MediaTypeRule[] = Object.freeze([
  {
    contentType: "image/png",
    magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    maxPixels: 40_000_000,
  },
  {
    contentType: "image/jpeg",
    magic: [[0xff, 0xd8, 0xff]],
    maxPixels: 40_000_000,
  },
  {
    contentType: "image/webp",
    magic: [[0x52, 0x49, 0x46, 0x46]],
    maxPixels: 40_000_000,
  },
  {
    contentType: "image/gif",
    magic: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    maxPixels: 40_000_000,
  },
  {
    contentType: "application/pdf",
    magic: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
  },
  {
    contentType: "video/mp4",
    // ....ftyp at offset 4; checked with an offset-aware rule below.
    magic: [[0x66, 0x74, 0x79, 0x70]],
  },
  {
    contentType: "audio/mpeg",
    magic: [[0x49, 0x44, 0x33], [0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2]],
  },
  {
    contentType: "application/json",
    // Audit anchors are canonical JSON objects.
    magic: [[0x7b]],
  },
]);

const MAGIC_OFFSET: Record<string, number> = { "video/mp4": 4 };

export type MediaPolicyFailure =
  | "TYPE_NOT_ALLOWED"
  | "MAGIC_MISMATCH"
  | "LENGTH_MISMATCH"
  | "TOO_LARGE"
  | "DIGEST_MISMATCH"
  | "ACTIVE_CONTENT";

export interface MediaPolicyResult {
  ok: boolean;
  failure?: MediaPolicyFailure;
}

function startsWith(bytes: Uint8Array, magic: readonly number[], offset: number): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * Anything that a browser might execute if it were ever served inline. Even
 * though responses are always `no-store` + `nosniff` + attachment, storing
 * active content at all is refused.
 */
const ACTIVE_CONTENT_MARKERS = [
  "<script",
  "<svg",
  "javascript:",
  "<!doctype html",
  "<html",
  "<?php",
];

export function checkActiveContent(bytes: Uint8Array): boolean {
  const probe = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
    .decode(bytes.slice(0, 1024))
    .toLowerCase();
  return ACTIVE_CONTENT_MARKERS.some((marker) => probe.includes(marker));
}

export function evaluateMediaPolicy({
  bytes,
  declaredContentType,
  declaredContentLength,
  declaredSha256,
  actualSha256,
}: {
  bytes: Uint8Array;
  declaredContentType: string;
  declaredContentLength: number;
  declaredSha256: string;
  actualSha256: string;
}): MediaPolicyResult {
  const rule = ALLOWED_MEDIA_TYPES.find((entry) => entry.contentType === declaredContentType);
  if (!rule) return { ok: false, failure: "TYPE_NOT_ALLOWED" };
  if (bytes.byteLength > MAX_OBJECT_BYTES) return { ok: false, failure: "TOO_LARGE" };
  // A partial upload shows up here: the promised length and the received length
  // disagree, so the object is never stored.
  if (bytes.byteLength !== declaredContentLength) {
    return { ok: false, failure: "LENGTH_MISMATCH" };
  }
  if (actualSha256 !== declaredSha256) return { ok: false, failure: "DIGEST_MISMATCH" };

  const offset = MAGIC_OFFSET[declaredContentType] ?? 0;
  if (!rule.magic.some((magic) => startsWith(bytes, magic, offset))) {
    return { ok: false, failure: "MAGIC_MISMATCH" };
  }
  if (declaredContentType !== "application/json" && checkActiveContent(bytes)) {
    return { ok: false, failure: "ACTIVE_CONTENT" };
  }
  return { ok: true };
}