import { describe, expect, it } from "vitest";

import {
  evaluateMediaPolicy,
  MAX_DECOMPRESSED_IMAGE_BYTES,
} from "../src/media-policy";

function pngHeader({
  width,
  height,
  bitDepth = 8,
  colorType = 6,
}: {
  width: number;
  height: number;
  bitDepth?: number;
  colorType?: number;
}): Uint8Array {
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
  const chunk = (type: string, data: Uint8Array) => {
    const value = new Uint8Array(12 + data.byteLength);
    const view = new DataView(value.buffer);
    view.setUint32(0, data.byteLength);
    value.set(new TextEncoder().encode(type), 4);
    value.set(data, 8);
    view.setUint32(8 + data.byteLength, crc32(value.subarray(4, 8 + data.byteLength)));
    return value;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr.set([bitDepth, colorType, 0, 0, 0], 8);
  const chunks = [
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0, 0, 0, 0, 1])),
    chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(8 + chunks.reduce((total, value) => total + value.byteLength, 0));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  for (const value of chunks) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
}

function policy(bytes: Uint8Array) {
  return evaluateMediaPolicy({
    bytes,
    declaredContentType: "image/png",
    declaredContentLength: bytes.byteLength,
    declaredSha256: "a".repeat(64),
    actualSha256: "a".repeat(64),
  });
}

describe("compressed image policy", () => {
  it("rejects an image whose declared dimensions exceed the decoded pixel budget", () => {
    expect(policy(pngHeader({ width: 10_000, height: 5_000 }))).toEqual({
      ok: false,
      failure: "DIMENSION_LIMIT",
    });
  });

  it("rejects malformed dimensions instead of accepting magic bytes alone", () => {
    expect(policy(pngHeader({ width: 0, height: 1 }))).toEqual({
      ok: false,
      failure: "DIMENSION_INVALID",
    });
  });

  it("caps the decompressed byte estimate even below the pixel ceiling", () => {
    expect(MAX_DECOMPRESSED_IMAGE_BYTES).toBe(160 * 1024 * 1024);
    expect(policy(pngHeader({
      width: 5_000,
      height: 5_000,
      bitDepth: 16,
      colorType: 6,
    }))).toEqual({
      ok: false,
      failure: "DECOMPRESSION_LIMIT",
    });
  });

  it("accepts a bounded, structurally valid PNG header", () => {
    expect(policy(pngHeader({ width: 1_920, height: 1_080 }))).toEqual({ ok: true });
  });

  it("enforces JPEG dimensions and accepts bounded single-frame GIF/WebP", () => {
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0,
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b,
    ]);
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0xff, 0xff, 0xff, 0xff,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 18, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0,
    ]);

    expect(evaluateMediaPolicy({
      bytes: jpeg,
      declaredContentType: "image/jpeg",
      declaredContentLength: jpeg.byteLength,
      declaredSha256: "a".repeat(64),
      actualSha256: "a".repeat(64),
    })).toEqual({ ok: false, failure: "DIMENSION_LIMIT" });
    for (const [declaredContentType, bytes] of [
      ["image/gif", gif],
      ["image/webp", webp],
    ] as const) {
      expect(evaluateMediaPolicy({
        bytes,
        declaredContentType,
        declaredContentLength: bytes.byteLength,
        declaredSha256: "a".repeat(64),
        actualSha256: "a".repeat(64),
      }), declaredContentType).toEqual({ ok: true });
    }
  });

  it("rejects a RIFF file that is not a structurally valid WebP", () => {
    const bytes = new TextEncoder().encode("RIFF0000NOT_WEBP");
    expect(evaluateMediaPolicy({
      bytes,
      declaredContentType: "image/webp",
      declaredContentLength: bytes.byteLength,
      declaredSha256: "a".repeat(64),
      actualSha256: "a".repeat(64),
    })).toEqual({ ok: false, failure: "MAGIC_MISMATCH" });
  });

  it("rejects PNG/PDF active-content polyglots and trailing bytes after IEND", () => {
    const png = pngHeader({ width: 1, height: 1 });
    const action = new TextEncoder().encode(
      "%PDF-1.7 /OpenAction << /S /JavaScript /JS (app.alert(1)) >>",
    );
    const bytes = new Uint8Array(png.byteLength + action.byteLength);
    bytes.set(png);
    bytes.set(action, png.byteLength);

    expect(policy(bytes)).toEqual({ ok: false, failure: "ACTIVE_CONTENT" });
  });

  it("rejects APNG animation chunks instead of budgeting only one canvas", () => {
    const bytes = pngHeader({ width: 2, height: 2 });
    bytes.set([0x61, 0x63, 0x54, 0x4c], 37);
    expect(policy(bytes)).toEqual({ ok: false, failure: "ANIMATION_FORBIDDEN" });
  });
});
