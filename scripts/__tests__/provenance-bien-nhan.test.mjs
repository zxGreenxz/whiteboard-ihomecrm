// Sổ cho nguồn bằng chứng BIÊN NHẬN ROLLOUT của generate-migration-provenance.mjs.
//
// Vì sao nguồn này mạnh nhất trong ba nguồn:
//   ledger    khớp `version|name` — mà tên đổi được, và version thì trùng (40 nhóm)
//   catalog   nói object CÓ TỒN TẠI — không nói file nào tạo ra nó
//   biên nhận ghi sha256 CỦA CHÍNH FILE + thời điểm apply + giấy phép đã dùng
//
// Khớp theo sha256 nên tên đổi thì bằng chứng vẫn đúng, còn nội dung đổi thì bằng
// chứng mất hiệu lực — đúng điều ta muốn với một manifest bất biến.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bienNhanTheoSha, classify, giayPhep } from "../generate-migration-provenance.mjs";

const TRONG = { tables: [], functions: [], views: [], indexes: [], policies: [], triggers: [] };
const entry = (o) => ({ version: "v", name: "n", created: TRONG, ...o });
const ctx = (bienNhan) => ({ ledgerIndex: new Map(), catalog: null, bienNhan });

const DIR = new URL("../../docs/generated/schema-change-evidence/", import.meta.url);
const BIEN_NHAN = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")));

describe("bienNhanTheoSha", () => {
  it("nạp được biên nhận thật trong repo", () => {
    // Sàn chống-xanh-rỗng: mọi ca dưới vô nghĩa nếu thư mục rỗng.
    expect(BIEN_NHAN.length).toBeGreaterThanOrEqual(2);
    expect(bienNhanTheoSha(BIEN_NHAN).size).toBe(BIEN_NHAN.length);
  });

  it("bỏ qua biên nhận thiếu sha256 hoặc thiếu file — không dựng khoá undefined", () => {
    expect(bienNhanTheoSha([{ file: "a.sql" }, { sha256: "abc" }, {}]).size).toBe(0);
  });
});

describe("giayPhep — hai schema biên nhận cùng tồn tại", () => {
  it("bản mới: authorization.loai", () => {
    expect(giayPhep({ authorization: { loai: "bien-nhan-backup" } })).toBe("bien-nhan-backup");
  });

  it("bản cũ: promotionToken phẳng", () => {
    expect(giayPhep({ promotionToken: "xxx" })).toBe("promotion-token");
  });

  it("bản cũ: backupTaken phẳng", () => {
    expect(giayPhep({ backupTaken: true })).toBe("bien-nhan-backup");
  });

  it("dạng thứ ba ⇒ nói KHÔNG RÕ, không đoán bừa thành 'đã phê duyệt'", () => {
    // Biên nhận không đọc được giấy phép vẫn chứng minh file ĐÃ CHẠY, nhưng không
    // được lặng lẽ trông như đã có người duyệt.
    expect(giayPhep({ appliedAt: "2026-01-01" })).toBe("khong-ro-giay-phep");
  });

  it("ĐÚNG MỘT biên nhận thật thiếu giấy phép — và đó là phát hiện, không phải lỗi test", () => {
    // Ca này viết ban đầu là "cả hai biên nhận đều đọc ra giấy phép" và nó ĐỎ.
    // Đọc ra thì `20260807163000_ie_types_org_boundary.json` ghi
    // `promotionToken: false`, `backupTaken: false`, `appliedBy: "agent"` — tức
    // migration đó đã chạy lên production KHÔNG có promotion token và KHÔNG có
    // backup, trái Contract §11.
    //
    // Ghim con số 1 ở đây để nó không âm thầm tăng. Đóng ca này nghĩa là bổ sung
    // giấy phép hồi tố (nếu có) hoặc ghi rõ vào sổ vì sao lần đó không có — KHÔNG
    // phải nới khẳng định.
    const thieu = BIEN_NHAN.filter((bn) => giayPhep(bn) === "khong-ro-giay-phep");
    expect(thieu.map((b) => b.file)).toEqual([
      "supabase/migrations/20260807163000_ie_types_org_boundary.sql",
    ]);
  });
});

describe("classify với biên nhận", () => {
  const bn = bienNhanTheoSha(BIEN_NHAN);

  it("sha khớp biên nhận ⇒ ledger-applied kèm evidence `receipt:`", () => {
    const kq = classify(entry({ sha256: BIEN_NHAN[0].sha256 }), ctx(bn));
    expect(kq.state).toBe("ledger-applied");
    expect(kq.evidence[0]).toMatch(/^receipt:/);
  });

  it("biên nhận THẮNG ledger — nó chứng minh đúng byte, ledger chỉ khớp tên", () => {
    const ledgerIndex = new Map([["v|n", true]]);
    const kq = classify(entry({ sha256: BIEN_NHAN[0].sha256 }), { ledgerIndex, catalog: null, bienNhan: bn });
    expect(kq.evidence[0]).toMatch(/^receipt:/);
  });

  it("sha KHÔNG khớp ⇒ không mượn biên nhận của file khác", () => {
    expect(classify(entry({ sha256: "khong-ton-tai" }), ctx(bn)).state).toBe("unknown");
  });

  it("entry không có sha256 ⇒ không khớp gì (undefined không được thành khoá)", () => {
    expect(classify(entry({}), ctx(bn)).state).toBe("unknown");
  });

  it("không có biên nhận nào ⇒ hành vi y như trước khi thêm nguồn này", () => {
    const ledgerIndex = new Map([["v|n", true]]);
    const kq = classify(entry({ sha256: "abc" }), { ledgerIndex, catalog: null, bienNhan: new Map() });
    expect(kq.state).toBe("ledger-applied");
    expect(kq.evidence[0]).toMatch(/^ledger:/);
  });
});
