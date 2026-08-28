// Sổ cho phần STAGE + LOCK của kiem-nhanh-truoc-push (28/08/2026).
//
// Bản cũ stage theo delta `git status` toàn repo trước/sau Bước 1 ∪ mọi file
// bẩn dưới docs/generated/ — trên working tree chung nhiều phiên, nó vơ cả file
// phiên khác ghi trong cửa sổ 30-60s và file bẩn sẵn của họ vào staging của
// mình (vi phạm chính Contract §3/§11.3 mà nó phục vụ). Bản mới: allowlist SỞ
// HỮU tường minh theo từng generator, so với INDEX chứ không so trước/sau.
import { describe, expect, it } from "vitest";

import { danhGiaLock, thuocSoHuu, tinhTapStage } from "../kiem-nhanh-truoc-push.mjs";

describe("thuocSoHuu", () => {
  it("khớp file đích danh và tiền tố thư mục (kết thúc bằng /)", () => {
    expect(thuocSoHuu("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(thuocSoHuu("docs/generated/x.md", ["docs/generated/"])).toBe(true);
    expect(thuocSoHuu("docs/generated-khac/x.md", ["docs/generated/"])).toBe(false);
    expect(thuocSoHuu("src/a.ts.bak", ["src/a.ts"])).toBe(false);
  });
});

describe("tinhTapStage", () => {
  const muc = (over) => ({ ten: "t", kieu: "may", soHuu: [], thanhCong: true, daSua: [], ...over });

  it("may: chỉ stage file THUỘC soHuu đang khác index — file lạ của phiên khác không bị vơ", () => {
    const cacMuc = [muc({ soHuu: ["src/integrations/supabase/types.ts"] })];
    const dangKhac = new Set([
      "src/integrations/supabase/types.ts",
      "docs/generated/gia-lap-phien-khac.md", // bẩn dưới docs/generated nhưng KHÔNG ai sở hữu
      "src/copilot/wip-phien-khac.ts",
    ]);
    const { stage } = tinhTapStage(cacMuc, dangKhac, new Set());
    expect(stage).toEqual(["src/integrations/supabase/types.ts"]);
  });

  it("may nhưng generator HỎNG (offline) ⇒ không đụng soHuu của nó", () => {
    const cacMuc = [muc({ soHuu: ["contracts/surfaces/rpc-surface.json"], thanhCong: false })];
    const { stage } = tinhTapStage(cacMuc, new Set(["contracts/surfaces/rpc-surface.json"]), new Set());
    expect(stage).toEqual([]);
  });

  it("va-tay: stage file DA_SUA của lượt này, BỎ QUA file đã bẩn từ trước (có thể phiên khác)", () => {
    const cacMuc = [muc({ kieu: "va-tay", daSua: ["docs/CODEBASE_STRUCTURE.md", "supabase/README.md"] })];
    const banTruoc = new Set(["docs/CODEBASE_STRUCTURE.md"]);
    const { stage, boQua } = tinhTapStage(cacMuc, new Set(), banTruoc);
    expect(stage).toEqual(["supabase/README.md"]);
    expect(boQua.map((b) => b.file)).toEqual(["docs/CODEBASE_STRUCTURE.md"]);
  });

  it("chạy hai lần liên tiếp vẫn stage đủ — so với INDEX, không so trước/sau", () => {
    // Lượt 2 generator không sinh gì mới, nhưng artifact của lượt 1 chưa stage
    // vẫn đang khác index ⇒ vẫn vào tập stage. Đây là ca mà phép delta cũ hụt.
    const cacMuc = [muc({ soHuu: ["docs/generated/repository-inventory.json"] })];
    const { stage } = tinhTapStage(cacMuc, new Set(["docs/generated/repository-inventory.json"]), new Set());
    expect(stage).toEqual(["docs/generated/repository-inventory.json"]);
  });
});

describe("danhGiaLock", () => {
  const pidSong = () => true;
  const pidChet = () => false;

  it("pid còn sống trong hạn ⇒ song (phải chờ)", () => {
    expect(danhGiaLock({ pid: 123, batDauMs: 1000 }, pidSong, 1000 + 60_000)).toBe("song");
  });

  it("pid đã chết ⇒ stale (chiếm được)", () => {
    expect(danhGiaLock({ pid: 123, batDauMs: 1000 }, pidChet, 2000)).toBe("stale");
  });

  it("quá 20 phút ⇒ stale kể cả pid còn sống — gate không chạy lâu vậy, đó là xác treo", () => {
    expect(danhGiaLock({ pid: 123, batDauMs: 0 }, pidSong, 21 * 60 * 1000)).toBe("stale");
  });

  it("lock hỏng/không đọc được ⇒ stale", () => {
    expect(danhGiaLock(null, pidSong, 0)).toBe("stale");
    expect(danhGiaLock({ khong: "co-pid" }, pidSong, 0)).toBe("stale");
  });
});
