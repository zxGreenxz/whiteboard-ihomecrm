// Sổ đột biến cho scripts/check-new-modules-strict.mjs.
//
// Gate này có một cách hỏng đặc thù: nó phụ thuộc LỊCH SỬ GIT. Khi không phân giải
// được mốc (checkout nông, ref không tồn tại) thì "không có file mới" và "không
// kiểm được" trông y hệt nhau nếu cả hai cùng exit 0 — và cái sau bị đọc thành cái
// trước là mất trắng phép kiểm. Vì thế mốc hỏng phải là exit 3.
import { describe, expect, it } from "vitest";

import { docDao, duocMienTru, laModuleApp, MIEN_TRU } from "../check-new-modules-strict.mjs";

describe("laModuleApp — phạm vi luật", () => {
  it("bắt .ts và .tsx trong src/", () => {
    expect(laModuleApp("src/lib/a.ts")).toBe(true);
    expect(laModuleApp("src/pages/B.tsx")).toBe(true);
  });

  it("bỏ file ngoài src/", () => {
    expect(laModuleApp("scripts/x.mjs")).toBe(false);
    expect(laModuleApp("services/openclaw-zalo-bridge/src/a.ts")).toBe(false);
    expect(laModuleApp("infra/network-center-worker/src/a.ts")).toBe(false);
  });

  it("bỏ file không phải TS", () => {
    expect(laModuleApp("src/index.css")).toBe(false);
    expect(laModuleApp("src/assets/a.webp")).toBe(false);
  });
});

describe("miễn trừ — mỗi nhóm một lý do, không phải danh sách cho tiện", () => {
  it("test được miễn: kiểu lỏng trong test là công cụ, không phải nợ", () => {
    expect(duocMienTru("src/lib/__tests__/a.test.ts")).toBe(true);
    expect(duocMienTru("src/lib/a.test.ts")).toBe(true);
    expect(duocMienTru("src/pages/a.spec.tsx")).toBe(true);
  });

  it(".d.ts được miễn: không có thân hàm để strict", () => {
    expect(duocMienTru("src/vite-env.d.ts")).toBe(true);
  });

  it("types.ts sinh tự động được miễn: không sửa tay được", () => {
    expect(duocMienTru("src/integrations/supabase/types.ts")).toBe(true);
  });

  it("KHÔNG miễn mã app thường — nếu không thì luật rỗng", () => {
    expect(duocMienTru("src/lib/tienMoi.ts")).toBe(false);
    expect(duocMienTru("src/pages/TrangMoi.tsx")).toBe(false);
    expect(duocMienTru("src/app/providers/AppProviders.tsx")).toBe(false);
  });

  it("mỗi mục miễn trừ đều có lý do viết ra", () => {
    for (const m of MIEN_TRU) {
      expect(typeof m.vi).toBe("string");
      expect(m.vi.length).toBeGreaterThan(5);
    }
  });
});

describe("docDao — đọc include từ tsconfig JSONC", () => {
  it("bỏ comment dòng và comment khối trước khi parse", () => {
    const s = `{
      // đảo strict — ratchet một chiều
      /* khối
         nhiều dòng */
      "extends": "./tsconfig.app.json",
      "include": ["src/lib/a.ts", "src/lib/b.ts"]
    }`;
    const d = docDao(s);
    expect(d.has("src/lib/a.ts")).toBe(true);
    expect(d.size).toBe(2);
  });

  it("KHÔNG cắt nhầm `//` trong chuỗi URL", () => {
    const s = `{ "$comment": "xem https://ví dụ", "include": ["src/a.ts"] }`;
    expect(docDao(s).has("src/a.ts")).toBe(true);
  });

  it("thiếu include ⇒ tập rỗng, không ném", () => {
    expect(docDao('{"extends":"./x.json"}').size).toBe(0);
  });
});
