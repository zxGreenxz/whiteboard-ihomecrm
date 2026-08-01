/**
 * Content policy for every byte the gateway accepts. Declared metadata is never
 * trusted on its own: the magic bytes, the actual length, and the actual digest
 * must all agree with the ticket before an object is stored.
 */

export const MAX_OBJECT_BYTES = 52_428_800; // 50 MiB
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIT_BYTES = 1024 * 1024;
export const MAX_DECOMPRESSED_IMAGE_BYTES = 160 * 1024 * 1024;

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
    contentType: "image/gif",
    magic: [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    maxPixels: 40_000_000,
  },
  {
    contentType: "image/webp",
    magic: [[0x57, 0x45, 0x42, 0x50]],
    maxPixels: 40_000_000,
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

const MAGIC_OFFSET: Record<string, number> = { "video/mp4": 4, "image/webp": 8 };

export type MediaPolicyFailure =
  | "TYPE_NOT_ALLOWED"
  | "MAGIC_MISMATCH"
  | "LENGTH_MISMATCH"
  | "TOO_LARGE"
  | "DIGEST_MISMATCH"
  | "ACTIVE_CONTENT"
  | "DIMENSION_INVALID"
  | "DIMENSION_LIMIT"
  | "DECOMPRESSION_LIMIT"
  | "ANIMATION_FORBIDDEN";

export interface MediaPolicyResult {
  ok: boolean;
  failure?: MediaPolicyFailure;
}

export function maximumBytesForContentType(contentType: string): number {
  if (contentType === "application/json") return MAX_AUDIT_BYTES;
  if (contentType.startsWith("image/")) return MAX_IMAGE_BYTES;
  return MAX_OBJECT_BYTES;
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
  "%pdf-",
  "/javascript",
  "/openaction",
  "/js",
];

export function checkActiveContent(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  const overlapLength = Math.max(...ACTIVE_CONTENT_MARKERS.map((marker) => marker.length)) - 1;
  let overlap = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1_024) {
    const text = (overlap + decoder.decode(
      bytes.subarray(offset, Math.min(bytes.byteLength, offset + 64 * 1_024)),
    )).toLowerCase();
    if (ACTIVE_CONTENT_MARKERS.some((marker) => text.includes(marker))) return true;
    overlap = text.slice(-overlapLength);
  }
  return false;
}

function pngDecodedSize(bytes: Uint8Array):
  | { width: number; height: number; decodedBytes: number }
  | null {
  if (bytes.byteLength < 57) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 255;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  const crc32 = (input: Uint8Array) => {
    let crc = 0xffffffff;
    for (const byte of input) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return null;
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    if (view.getUint32(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) {
      return null;
    }
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return null;
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16] ?? 0;
      colorType = bytes[offset + 17] ?? 255;
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) {
        return null;
      }
      sawHeader = true;
    } else if (type === "IHDR") {
      return null;
    } else if (type === "IDAT") {
      if (length < 1 || sawEnd) return null;
      sawImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawImageData || end !== bytes.byteLength) return null;
      sawEnd = true;
    } else if ((bytes[offset + 4] ?? 0) >= 0x41 && (bytes[offset + 4] ?? 0) <= 0x5a &&
      !["PLTE"].includes(type)) {
      return null;
    }
    offset = end;
  }
  if (!sawHeader || !sawImageData || !sawEnd || offset !== bytes.byteLength) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  const allowedDepths = ({
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  } as Record<number, number[]>)[colorType];
  if (width < 1 || height < 1 || channels === undefined || !allowedDepths?.includes(bitDepth)) {
    return null;
  }
  const bitsPerRow = width * channels * bitDepth;
  const decodedBytes = (Math.ceil(bitsPerRow / 8) + 1) * height;
  return { width, height, decodedBytes };
}

function gifDecodedSize(bytes: Uint8Array):
  | { width: number; height: number; decodedBytes: number }
  | null {
  if (bytes.byteLength < 14) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const canvasWidth = view.getUint16(6, true);
  const canvasHeight = view.getUint16(8, true);
  if (canvasWidth < 1 || canvasHeight < 1) return null;
  const packed = bytes[10] ?? 0;
  let offset = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0);
  let frames = 0;
  let decodedPixels = 0;
  const skipSubBlocks = () => {
    while (offset < bytes.byteLength) {
      const length = bytes[offset++] ?? 0;
      if (length === 0) return true;
      if (offset + length > bytes.byteLength) return false;
      offset += length;
    }
    return false;
  };
  while (offset < bytes.byteLength) {
    const introducer = bytes[offset++] ?? 0;
    if (introducer === 0x3b) {
      if (offset !== bytes.byteLength || frames < 1) return null;
      return {
        width: canvasWidth,
        height: canvasHeight,
        decodedBytes: decodedPixels * 4,
      };
    }
    if (introducer === 0x21) {
      if (offset >= bytes.byteLength) return null;
      offset += 1;
      if (!skipSubBlocks()) return null;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.byteLength) return null;
    const width = view.getUint16(offset + 4, true);
    const height = view.getUint16(offset + 6, true);
    const imagePacked = bytes[offset + 8] ?? 0;
    offset += 9;
    if (width < 1 || height < 1) return null;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
    if (offset >= bytes.byteLength || (bytes[offset++] ?? 0) < 2 || !skipSubBlocks()) return null;
    frames += 1;
    decodedPixels += width * height;
    if (frames > 4 || decodedPixels > 40_000_000) return null;
  }
  return null;
}

function webpDecodedSize(bytes: Uint8Array):
  | { width: number; height: number; decodedBytes: number }
  | null {
  if (bytes.byteLength < 26 || !startsWith(bytes, [0x52, 0x49, 0x46, 0x46], 0)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.byteLength) return null;
  let offset = 12;
  let dimensions: { width: number; height: number } | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const type = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    const length = view.getUint32(offset + 4, true);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (end > bytes.byteLength) return null;
    if (type === "ANIM" || type === "ANMF") return null;
    if (type === "VP8X") {
      if (length !== 10 || ((bytes[dataOffset] ?? 0) & 0x02) !== 0) return null;
      dimensions = {
        width: 1 + (bytes[dataOffset + 4] ?? 0) + ((bytes[dataOffset + 5] ?? 0) << 8) +
          ((bytes[dataOffset + 6] ?? 0) << 16),
        height: 1 + (bytes[dataOffset + 7] ?? 0) + ((bytes[dataOffset + 8] ?? 0) << 8) +
          ((bytes[dataOffset + 9] ?? 0) << 16),
      };
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataOffset] !== 0x2f) return null;
      const bits = view.getUint32(dataOffset + 1, true);
      dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (type === "VP8 ") {
      if (length < 10 || bytes[dataOffset + 3] !== 0x9d || bytes[dataOffset + 4] !== 0x01 ||
        bytes[dataOffset + 5] !== 0x2a) return null;
      dimensions = {
        width: view.getUint16(dataOffset + 6, true) & 0x3fff,
        height: view.getUint16(dataOffset + 8, true) & 0x3fff,
      };
    }
    offset = end + (length % 2);
  }
  if (!dimensions || offset !== bytes.byteLength || dimensions.width < 1 || dimensions.height < 1) {
    return null;
  }
  return { ...dimensions, decodedBytes: dimensions.width * dimensions.height * 4 };
}

function jpegDecodedSize(bytes: Uint8Array):
  | { width: number; height: number; decodedBytes: number }
  | null {
  let offset = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const segmentLength = view.getUint16(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) return null;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (segmentLength < 7) return null;
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      if (width < 1 || height < 1) return null;
      return { width, height, decodedBytes: width * height * 4 };
    }
    offset += segmentLength;
  }
  return null;
}

function decodedImageSize(contentType: string, bytes: Uint8Array):
  | { width: number; height: number; decodedBytes: number }
  | null {
  if (contentType === "image/png") return pngDecodedSize(bytes);
  if (contentType === "image/jpeg") return jpegDecodedSize(bytes);
  if (contentType === "image/gif") return gifDecodedSize(bytes);
  if (contentType === "image/webp") return webpDecodedSize(bytes);
  return null;
}

function hasPngAnimation(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) return false;
    if (
      bytes[offset + 4] === 0x61 && bytes[offset + 5] === 0x63 &&
      bytes[offset + 6] === 0x54 && bytes[offset + 7] === 0x4c
    ) return true;
    offset = end;
  }
  return false;
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
  if (bytes.byteLength > maximumBytesForContentType(declaredContentType)) {
    return { ok: false, failure: "TOO_LARGE" };
  }
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
  if (declaredContentType === "image/png" && hasPngAnimation(bytes)) {
    return { ok: false, failure: "ANIMATION_FORBIDDEN" };
  }
  if (declaredContentType !== "application/json" && checkActiveContent(bytes)) {
    return { ok: false, failure: "ACTIVE_CONTENT" };
  }
  if (declaredContentType.startsWith("image/")) {
    const dimensions = decodedImageSize(declaredContentType, bytes);
    if (!dimensions) return { ok: false, failure: "DIMENSION_INVALID" };
    if (dimensions.width * dimensions.height > (rule.maxPixels ?? 0)) {
      return { ok: false, failure: "DIMENSION_LIMIT" };
    }
    if (dimensions.decodedBytes > MAX_DECOMPRESSED_IMAGE_BYTES) {
      return { ok: false, failure: "DECOMPRESSION_LIMIT" };
    }
  }
  return { ok: true };
}
