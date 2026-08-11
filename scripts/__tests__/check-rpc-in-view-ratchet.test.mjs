// Sổ đột biến cho scripts/check-rpc-in-view-ratchet.mjs.
//
// Ca đắt nhất: "thay thế trong cùng file". Đó chính là chỗ ratchet theo SỐ ĐẾM bỏ
// lọt — xoá một call site rồi thêm một cái khác trong cùng file cho ra cùng con số,
// nên vi phạm mới đi qua. Án lệ rpc-cast-baseline của repo dùng đếm; file này cố ý
// dùng tập vân tay và ca dưới đây là lý do.
import { describe, expect, it } from "vitest";

import { laFileCanQuet, rutVanTay, soSanh, TOI_THIEU_FILE, VUNG } from "../check-rpc-in-view-ratchet.mjs";

describe("rutVanTay — bắt đúng lời gọi, bỏ đúng thứ không phải lời gọi", () => {
  it("bắt nháy kép và nháy đơn", () => {
    expect(rutVanTay("a.tsx", `supabase.rpc("ham_a", {})`)).toEqual(["a.tsx::ham_a"]);
    expect(rutVanTay("a.tsx", `supabase.rpc('ham_b')`)).toEqual(["a.tsx::ham_b"]);
  });

  it("bắt cả khi nối chuỗi trên builder", () => {
    expect(rutVanTay("a.ts", `createClient({}).rpc("get_public_available_rooms", { p_token: t })`)).toEqual([
      "a.ts::get_public_available_rooms",
    ]);
  });

  it("bắt nhiều lời gọi trong một file", () => {
    const r = rutVanTay("a.tsx", `supabase.rpc('get_x');\nsupabase.rpc('set_x', {})`);
    expect(r).toEqual(["a.tsx::get_x", "a.tsx::set_x"]);
  });

  it("KHÔNG bắt comment nhắc tới supabase.rpc()", () => {
    // Đã gặp thật: TaskCompleteDialog.tsx có một dòng comment giải thích
    // `supabase.rpc()` trả PostgrestBuilder. Đếm theo grep `.rpc(` ra 9;
    // đếm theo lời gọi thật ra 8.
    expect(rutVanTay("a.tsx", "// `supabase.rpc()` trả PostgrestBuilder — chỉ implements PromiseLike")).toEqual([]);
  });

  it("KHÔNG bắt tên RPC là biến — cố ý, để không dính JSON-RPC của cầu nối OpenClaw", () => {
    expect(rutVanTay("a.ts", "client.rpc(tenHam, args)")).toEqual([]);
  });
});

describe("laFileCanQuet", () => {
  it("nhận .ts và .tsx", () => {
    expect(laFileCanQuet("src/pages/a.tsx")).toBe(true);
    expect(laFileCanQuet("src/pages/a.ts")).toBe(true);
  });

  it("bỏ test — test gọi thẳng RPC là hợp lệ", () => {
    expect(laFileCanQuet("src/pages/__tests__/a.tsx")).toBe(false);
    expect(laFileCanQuet("src/pages/a.test.ts")).toBe(false);
    expect(laFileCanQuet("src/pages/a.spec.tsx")).toBe(false);
  });

  it("bỏ file không phải TS", () => {
    expect(laFileCanQuet("src/pages/a.css")).toBe(false);
    expect(laFileCanQuet("src/pages/a.md")).toBe(false);
  });
});

describe("soSanh — ratchet chỉ đi một chiều", () => {
  it("vân tay mới ⇒ báo trong `moi`", () => {
    const r = soSanh(["a.tsx::x"], ["a.tsx::x", "b.tsx::y"]);
    expect(r.moi).toEqual(["b.tsx::y"]);
    expect(r.daXoa).toEqual([]);
  });

  it("chuyển đi rồi ⇒ báo trong `daXoa`, không phải vi phạm", () => {
    const r = soSanh(["a.tsx::x", "b.tsx::y"], ["a.tsx::x"]);
    expect(r.moi).toEqual([]);
    expect(r.daXoa).toEqual(["b.tsx::y"]);
  });

  it("CA QUAN TRỌNG NHẤT — thay thế TRONG CÙNG FILE bị bắt (đếm sẽ bỏ lọt)", () => {
    const truoc = ["a.tsx::ham_cu"];
    const sau = ["a.tsx::ham_moi"];
    const r = soSanh(truoc, sau);
    // Số đếm giống hệt: 1 → 1. Ratchet theo đếm sẽ nói "không có gì đổi".
    expect(truoc.length).toBe(sau.length);
    // Vân tay thì thấy ngay.
    expect(r.moi).toEqual(["a.tsx::ham_moi"]);
    expect(r.daXoa).toEqual(["a.tsx::ham_cu"]);
  });

  it("không đổi gì ⇒ cả hai rỗng", () => {
    const r = soSanh(["a.tsx::x"], ["a.tsx::x"]);
    expect(r.moi).toEqual([]);
    expect(r.daXoa).toEqual([]);
  });
});

describe("chống-xanh-rỗng", () => {
  it("sàn số file đủ lớn để có nghĩa (thực tế quét 628 file)", () => {
    expect(TOI_THIEU_FILE).toBeGreaterThanOrEqual(50);
  });

  it("chỉ quét vùng view, không quét hooks/lib — đó là nơi RPC ĐƯỢC PHÉP sống", () => {
    expect(VUNG).toEqual(["src/components", "src/pages"]);
    expect(VUNG).not.toContain("src/hooks");
    expect(VUNG).not.toContain("src/lib");
  });
});
