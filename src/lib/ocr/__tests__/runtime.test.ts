import { it, expect, vi } from "vitest";
import { readOcrCard } from "../runtime";

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
