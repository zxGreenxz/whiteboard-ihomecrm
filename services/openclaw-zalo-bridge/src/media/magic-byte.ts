export const MAX_IMAGE_PIXELS = 20_000_000;
export const MAX_IMAGE_DIMENSION = 8_192;

export interface MediaMagicInspection {
  mime: string;
  width?: number;
  height?: number;
}

export class MediaMagicError extends Error {
  readonly code: string;

  constructor(code: string, message = "media magic-byte verification failed") {
    super(message);
    this.name = "MediaMagicError";
    this.code = code;
  }
}

function image(mime: string, width?: number, height?: number): MediaMagicInspection {
  if (width !== undefined && height !== undefined) {
    if (
      width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
      width * height > MAX_IMAGE_PIXELS
    ) throw new MediaMagicError("IMAGE_DIMENSION_LIMIT", "image dimensions exceed the safe limit");
    return { mime, width, height };
  }
  return { mime };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + length + 2 > bytes.byteLength) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += length + 2;
  }
  return undefined;
}

export function inspectMediaMagic(bytes: Uint8Array): MediaMagicInspection {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.byteLength >= 24 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    if (buffer.toString("ascii", 12, 16) !== "IHDR") {
      throw new MediaMagicError("PNG_HEADER_INVALID", "PNG header is invalid");
    }
    return image("image/png", buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (buffer.byteLength >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return image("image/gif", buffer.readUInt16LE(6), buffer.readUInt16LE(8));
  }
  if (buffer.byteLength >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    const dimensions = jpegDimensions(buffer);
    if (dimensions === undefined) {
      throw new MediaMagicError("IMAGE_DIMENSIONS_UNKNOWN", "JPEG dimensions are unavailable");
    }
    return image("image/jpeg", dimensions.width, dimensions.height);
  }
  if (
    buffer.byteLength >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (buffer.byteLength >= 30 && buffer.toString("ascii", 12, 16) === "VP8X") {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return image("image/webp", width, height);
    }
    if (
      buffer.byteLength >= 25 && buffer.toString("ascii", 12, 16) === "VP8L" &&
      buffer[20] === 0x2f
    ) {
      const width = 1 + buffer[21]! + ((buffer[22]! & 0x3f) << 8);
      const height = 1 + ((buffer[22]! & 0xc0) >> 6) + (buffer[23]! << 2) +
        ((buffer[24]! & 0x0f) << 10);
      return image("image/webp", width, height);
    }
    if (
      buffer.byteLength >= 30 && buffer.toString("ascii", 12, 16) === "VP8 " &&
      buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a
    ) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return image("image/webp", width, height);
    }
    throw new MediaMagicError("IMAGE_DIMENSIONS_UNKNOWN", "WebP dimensions are unavailable");
  }
  if (buffer.byteLength >= 5 && buffer.toString("ascii", 0, 5) === "%PDF-") {
    return { mime: "application/pdf" };
  }
  if (buffer.byteLength >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return { mime: "video/mp4" };
  }
  if (buffer.byteLength >= 4 && buffer.subarray(0, 4).equals(Buffer.from("4f676753", "hex"))) {
    return { mime: "application/ogg" };
  }
  if (buffer.byteLength >= 4 && buffer.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) {
    return { mime: "video/webm" };
  }
  if (
    (buffer.byteLength >= 3 && buffer.toString("ascii", 0, 3) === "ID3") ||
    (buffer.byteLength >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)
  ) return { mime: "audio/mpeg" };
  throw new MediaMagicError("MEDIA_MAGIC_UNKNOWN", "media magic bytes are unsupported");
}

export function normalizeMediaMime(value: string): string {
  const mime = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mime)) {
    throw new MediaMagicError("MEDIA_MIME_INVALID", "media MIME is invalid");
  }
  return mime;
}

export function verifyMediaMagic(input: {
  bytes: Uint8Array;
  declaredMime: string;
  expectedMime?: string;
}): MediaMagicInspection {
  const declared = normalizeMediaMime(input.declaredMime);
  const expected = input.expectedMime === undefined ? undefined : normalizeMediaMime(input.expectedMime);
  const inspected = inspectMediaMagic(input.bytes);
  if (inspected.mime !== declared || (expected !== undefined && inspected.mime !== expected)) {
    throw new MediaMagicError("MEDIA_MIME_MAGIC_MISMATCH", "media MIME does not match magic bytes");
  }
  return inspected;
}
