// Sổ cho ratchet chống nuốt lỗi — trọng tâm là MẪU KHỐI mới (plan C mục 4).
//
// Mẫu cũ `if-error-return-rong` chỉ bắt dạng MỘT DÒNG `if (error) return [];`.
// Dạng thật sự phổ biến trong repo lại là khối ba dòng:
//
//   if (error) {
//     console.error('useAreas error:', error);
//     return [];
//   }
//
// 40 chỗ dạng này nằm ngoài tầm gate suốt từ 07/08/2026 — gate vẫn xanh trong khi
// mỗi chỗ biến "không có quyền / mạng hỏng" thành "không có dữ liệu".
//
// Hai bất biến được chốt ở đây:
//   1. Khối có `throw` KHÔNG phải nuốt lỗi (kể cả khi trước đó có `return null`
//      cho nhánh không-tìm-thấy) — nếu không, cách sửa đúng lại bị gate chặn.
//   2. Chú thích không đổi được kết quả theo CẢ HAI chiều (luật Contract §8):
//      chuỗi vi phạm nằm trong comment không bị đếm, VÀ một `throw` bị comment-out
//      không cứu được khối đang thật sự trả rỗng.
import { describe, expect, it } from "vitest";

import {
  MAU_KHOI,
  domFile,
  domKhoi,
  laVungQuetKhoi,
  themMoiNgoaiMau,
  timKhoiIfError,
} from "../check-error-swallow-ratchet.mjs";

const khoiNuot = `
export const useAreas = () => useQuery({
  queryFn: async () => {
    const { data, error } = await supabase.from("areas").select("*");
    if (error) {
      console.error('useAreas error:', error);
      return [];
    }
    return data;
  },
});
`;

describe("timKhoiIfError — cắt đúng thân khối if (error) { … }", () => {
  it("lấy được thân khối, không nuốt sang phần sau", () => {
    const than = timKhoiIfError(khoiNuot);
    expect(than).toHaveLength(1);
    expect(than[0]).toContain("return []");
    expect(than[0]).not.toContain("return data");
  });

  it("bắt cả tên biến lỗi khác (rpcError, fetchError)", () => {
    const than = timKhoiIfError("if (rpcError) {\n  return [];\n}\nif (fetchError) {\n  throw fetchError;\n}\n");
    expect(than).toHaveLength(2);
  });

  it("không khớp `if (errorCount > 0)` — điều kiện không phải bản thân lỗi", () => {
    expect(timKhoiIfError("if (errorCount > 0) {\n  return [];\n}\n")).toHaveLength(0);
  });

  it("khối lồng nhau vẫn cắt tới dấu đóng ĐÚNG cấp", () => {
    const than = timKhoiIfError("if (error) {\n  if (a) { log(); }\n  return [];\n}\nafter();\n");
    expect(than).toHaveLength(1);
    expect(than[0]).toContain("return []");
    expect(than[0]).not.toContain("after()");
  });
});

describe("domKhoi — cái gì là nuốt lỗi, cái gì không", () => {
  it("khối trả [] bị tính là nuốt", () => {
    expect(domKhoi(khoiNuot, "src/hooks/useAreas.ts")).toEqual([
      `src/hooks/useAreas.ts#${MAU_KHOI}#0`,
    ]);
  });

  it("khối trả {} / null / undefined cũng bị tính", () => {
    const n = domKhoi(
      "if (error) {\n  return {};\n}\nif (error) {\n  return null;\n}\nif (error) {\n  return undefined;\n}\n",
      "src/hooks/x.ts",
    );
    expect(n).toHaveLength(3);
  });

  it("khối `throw error` KHÔNG bị tính", () => {
    const sach = khoiNuot.replace("return [];", "throw error;");
    expect(domKhoi(sach, "src/hooks/useAreas.ts")).toEqual([]);
  });

  it("khối trả null cho nhánh không-tìm-thấy RỒI throw KHÔNG bị tính", () => {
    // Đây chính là cách sửa đúng cho `.single()`: PGRST116 là "không có dòng",
    // không phải lỗi. Gate mà chặn cách này thì nó đang đẩy người ta về chỗ cũ.
    const sua = `
      if (error) {
        if (classifyDbError(error) === "not_found") return null;
        console.error('useArea error:', error);
        throw error;
      }
    `;
    expect(domKhoi(sua, "src/hooks/useAreas.ts")).toEqual([]);
  });

  it("chỉ quét src/hooks và src/lib — chỗ khác để mẫu cũ lo", () => {
    expect(laVungQuetKhoi("src/hooks/useAreas.ts")).toBe(true);
    expect(laVungQuetKhoi("src/lib/salaryBonusNotify.ts")).toBe(true);
    expect(laVungQuetKhoi("src/pages/invoices/InvoicePrintPage.tsx")).toBe(false);
    expect(domKhoi(khoiNuot, "src/pages/invoices/InvoicePrintPage.tsx")).toEqual([]);
  });

  it("thứ tự fingerprint ổn định theo vị trí trong file", () => {
    const hai = `${khoiNuot}\n${khoiNuot.replace("return [];", "return null;")}`;
    expect(domKhoi(hai, "src/hooks/a.ts")).toEqual([
      `src/hooks/a.ts#${MAU_KHOI}#0`,
      `src/hooks/a.ts#${MAU_KHOI}#1`,
    ]);
  });
});

describe("chú thích không đổi được kết quả (Contract §8)", () => {
  it("chuỗi vi phạm nằm trong comment KHÔNG bị đếm", () => {
    const chiLaVanKe = `
      // Trước đây chỗ này viết: if (error) { return []; } — đã bỏ.
      /* Mẫu cũ:
         if (error) {
           return null;
         }
      */
      if (error) {
        throw error;
      }
    `;
    expect(domKhoi(chiLaVanKe, "src/hooks/useAreas.ts")).toEqual([]);
    expect(domFile(chiLaVanKe, "src/hooks/useAreas.ts")).toEqual([]);
  });

  it("`throw` bị comment-out KHÔNG cứu được khối đang trả rỗng", () => {
    // Chiều nguy hiểm hơn: gate xanh trong khi mã vẫn nuốt lỗi.
    const giaVo = `
      if (error) {
        // throw error;
        return [];
      }
    `;
    expect(domKhoi(giaVo, "src/hooks/useAreas.ts")).toHaveLength(1);
  });

  it("dấu } trong comment không cắt nhầm thân khối", () => {
    const nguyTrang = `
      if (error) {
        // đóng ngoặc giả }
        return [];
      }
    `;
    expect(domKhoi(nguyTrang, "src/hooks/useAreas.ts")).toHaveLength(1);
  });
});

describe("themMoiNgoaiMau — nhận mẫu mới một lần, KHÔNG mở cửa cho mẫu cũ", () => {
  const themMoi = [
    `src/hooks/a.ts#${MAU_KHOI}#0`,
    "src/hooks/b.ts#catch-rong#0",
  ];

  it("chỉ tha fingerprint của mẫu được nêu tên", () => {
    expect(themMoiNgoaiMau(themMoi, [MAU_KHOI])).toEqual(["src/hooks/b.ts#catch-rong#0"]);
  });

  it("không nêu tên mẫu nào thì không tha gì", () => {
    expect(themMoiNgoaiMau(themMoi, [])).toEqual(themMoi);
  });
});
