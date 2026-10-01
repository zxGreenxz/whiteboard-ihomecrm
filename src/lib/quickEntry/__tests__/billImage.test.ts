import { describe, it, expect } from "vitest";
import {
  BILL_IMAGE_LADDER,
  MAX_BILL_IMAGE_BYTES,
  base64Length,
  encodeWithinBudget,
  scaledSize,
} from "../billImage";

describe("scaledSize", () => {
  it("giữ tỉ lệ, cạnh dài bằng trần", () => {
    expect(scaledSize(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(1170, 2532, 1600)).toEqual({ width: 739, height: 1600 });
  });

  it("ảnh nhỏ hơn trần thì giữ nguyên (không phóng to)", () => {
    expect(scaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("base64Length", () => {
  it("4 ký tự cho mỗi 3 byte, làm tròn lên", () => {
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    expect(base64Length(360_000)).toBe(480_000);
  });

  it("ảnh ở trần ngân sách + 24 KB prompt vẫn dưới trần body 512 KiB của proxy", () => {
    expect(base64Length(MAX_BILL_IMAGE_BYTES) + 24_000).toBeLessThan(524_288);
  });
});

describe("encodeWithinBudget", () => {
  const fakeEncoder = (sizes: number[]) => {
    const calls: number[] = [];
    const encode = async (step: { maxEdge: number; quality: number }) => {
      calls.push(step.maxEdge);
      return { size: sizes[calls.length - 1] } as Blob;
    };
    return { encode, calls };
  };

  it("nấc đầu đã vừa ⇒ dừng ngay", async () => {
    const f = fakeEncoder([200_000]);
    const out = await encodeWithinBudget(f.encode);
    expect(out?.step).toEqual(BILL_IMAGE_LADDER[0]);
    expect(f.calls).toEqual([BILL_IMAGE_LADDER[0].maxEdge]);
  });

  it("thử lần lượt từng nấc tới khi vừa", async () => {
    const f = fakeEncoder([600_000, 500_000, 300_000]);
    const out = await encodeWithinBudget(f.encode);
    expect(out?.step).toEqual(BILL_IMAGE_LADDER[2]);
    expect(f.calls).toHaveLength(3);
  });

  it("không nấc nào vừa ⇒ null (giao diện báo chụp lại gần hơn / nhập tay)", async () => {
    const f = fakeEncoder([900_000, 800_000, 700_000]);
    expect(await encodeWithinBudget(f.encode)).toBeNull();
    expect(f.calls).toHaveLength(BILL_IMAGE_LADDER.length);
  });

  it("bộ mã hoá ném lỗi ở một nấc ⇒ thử nấc kế", async () => {
    let n = 0;
    const out = await encodeWithinBudget(async () => {
      n += 1;
      if (n === 1) throw new Error("canvas");
      return { size: 100_000 } as Blob;
    });
    expect(out?.step).toEqual(BILL_IMAGE_LADDER[1]);
  });
});
