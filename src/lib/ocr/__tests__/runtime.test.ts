import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { assetBytes, readOcrCard } from "../runtime";

it("validates the decoded stream when gzip Content-Length describes compressed bytes", async () => {
  const bytes = readFileSync("vendor/cccd-ocr/latin-dict.json");
  const compressed = gzipSync(bytes);
  expect(compressed.length).not.toBe(bytes.length);
  const fetch = vi.fn(
    async () =>
      new Response(bytes, {
        headers: {
          "Content-Encoding": "gzip",
          "Content-Length": String(compressed.length),
        },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("crypto", webcrypto);
  try {
    expect(new Uint8Array(await assetBytes("latin-dict.json"))).toEqual(
      new Uint8Array(bytes),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each(["oversize", "short", "corrupt"])(
  "still rejects a %s decoded asset with a compressed transfer header",
  async (kind) => {
    const original = readFileSync("vendor/cccd-ocr/latin-dict.json");
    const bytes =
      kind === "oversize"
        ? Buffer.concat([original, Buffer.from([0])])
        : kind === "short"
          ? original.subarray(1)
          : Buffer.from(original);
    if (kind === "corrupt") bytes[0] ^= 1;
    const fetch = vi.fn(
      async () =>
        new Response(bytes, {
          headers: {
            "Content-Encoding": "gzip",
            "Content-Length": "90",
          },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", webcrypto);
    try {
      await expect(assetBytes("latin-dict.json")).rejects.toThrow(
        kind === "corrupt" ? "digest mismatch" : "size mismatch",
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("releases every CV allocation and input tensor when detector inference rejects", async () => {
  const mats: Mat[] = [],
    tensors: Tensor[] = [];
  class Mat {
    rows = 8;
    cols = 8;
    data = new Uint8Array(8 * 8 * 3);
    deleted = false;
    constructor() {
      mats.push(this);
    }
    delete() {
      this.deleted = true;
    }
  }
  class Tensor {
    disposed = false;
    constructor() {
      tensors.push(this);
    }
    dispose() {
      this.disposed = true;
    }
  }
  const runtime = {
    cv: {
      Mat,
      Size: class {},
      matFromImageData: () => new Mat(),
      cvtColor() {},
      resize() {},
      COLOR_RGBA2BGR: 0,
      INTER_LINEAR: 1,
    },
    ort: { Tensor },
    det: {
      inputNames: ["input"],
      run: async () => {
        throw Error("injected inference fault");
      },
    },
  } as unknown as Parameters<typeof readOcrCard>[1];
  await expect(
    readOcrCard(
      { width: 8, height: 8, data: new Uint8ClampedArray(256) } as ImageData,
      runtime,
      performance.now() + 1000,
    ),
  ).rejects.toThrow("injected inference fault");
  expect(mats.length).toBeGreaterThan(0);
  expect(mats.every((m) => m.deleted)).toBe(true);
  expect(tensors).toHaveLength(1);
  expect(tensors[0].disposed).toBe(true);
});
it("disposes a just-created tensor if the deadline expires before inference begins", async () => {
  let expired = false,
    disposed = false;
  const clock = vi
    .spyOn(performance, "now")
    .mockImplementation(() => (expired ? 2000 : 0));
  class Mat {
    rows = 8;
    cols = 8;
    data = new Uint8Array(192);
    delete() {}
  }
  class Tensor {
    constructor() {
      expired = true;
    }
    dispose() {
      disposed = true;
    }
  }
  const runtime = {
    cv: {
      Mat,
      Size: class {},
      matFromImageData: () => new Mat(),
      cvtColor() {},
      resize() {},
      COLOR_RGBA2BGR: 0,
      INTER_LINEAR: 1,
    },
    ort: { Tensor },
    det: {
      inputNames: ["input"],
      run: async () => {
        throw Error("must not infer after deadline");
      },
    },
  } as unknown as Parameters<typeof readOcrCard>[1];
  try {
    await expect(
      readOcrCard(
        { width: 8, height: 8, data: new Uint8ClampedArray(256) } as ImageData,
        runtime,
        1000,
      ),
    ).rejects.toThrow("OCR timeout");
    expect(disposed).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
