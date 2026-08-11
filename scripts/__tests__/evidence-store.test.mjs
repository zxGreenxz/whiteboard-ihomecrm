// Sổ cho hợp đồng biên nhận rollout (check-evidence-store.mjs) và hai hàm băm
// mới của apply-reviewed-migration.mjs.
//
// Kho `docs/generated/schema-change-evidence/` là nguồn DUY NHẤT trả lời "ai đổi
// schema production, bằng file nào, ai cho phép" — ledger supabase_migrations đã
// tụt lại sau production. Một biên nhận thiếu trường không báo lỗi lúc ghi; nó chỉ
// im lặng, và cái im lặng đó lộ ra vào đúng lúc đang truy sự cố.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BAT_BUOC, MIEN_TRU, thieuTruong } from "../check-evidence-store.mjs";
import { chuanHoaSql, digestChuanHoa } from "../apply-reviewed-migration.mjs";

const DIR = new URL("../../docs/generated/schema-change-evidence/", import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("chuanHoaSql — phân biệt ĐỊNH DẠNG LẠI với ĐỔI NỘI DUNG", () => {
  it("bỏ comment dòng và comment khối", () => {
    expect(chuanHoaSql("-- a\nSELECT 1; /* b */")).toBe("SELECT 1;");
  });

  it("CRLF và LF cho cùng một digest — Windows không được tạo báo động giả", () => {
    // core.autocrlf=true trên máy dev nghĩa là mở file rồi lưu lại là đủ đổi
    // sha256. Nếu đó thành báo động thì người ta học cách bỏ qua báo động.
    expect(digestChuanHoa("SELECT 1;\r\nSELECT 2;\r\n")).toBe(digestChuanHoa("SELECT 1;\nSELECT 2;\n"));
  });

  it("gộp khoảng trắng thừa", () => {
    expect(digestChuanHoa("SELECT    1 ;")).toBe(digestChuanHoa("SELECT 1 ;"));
  });

  it("ĐỔI NỘI DUNG vẫn ra digest khác — chuẩn hoá không được nuốt thay đổi thật", () => {
    expect(digestChuanHoa("SELECT 1;")).not.toBe(digestChuanHoa("SELECT 2;"));
  });

  it("thêm một câu lệnh ⇒ digest đổi", () => {
    expect(digestChuanHoa("DROP TABLE a;")).not.toBe(digestChuanHoa("DROP TABLE a; DROP TABLE b;"));
  });
});

describe("hợp đồng biên nhận", () => {
  const day = () =>
    Object.fromEntries(BAT_BUOC.map(([k]) => [k, k === "catalog" ? { changed: true } : "x"]));

  it("biên nhận đủ trường ⇒ không thiếu gì", () => {
    expect(thieuTruong(day())).toEqual([]);
  });

  it("mỗi trường bắt buộc, thiếu một cái là bắt được — không trường nào là trang trí", () => {
    for (const [k] of BAT_BUOC) {
      const bn = day();
      delete bn[k];
      expect(thieuTruong(bn).join(" "), `thiếu ${k} mà không bị bắt`).toContain(k);
    }
  });

  it("null bị coi là THIẾU, không phải 'đã khai giá trị null'", () => {
    expect(thieuTruong({ ...day(), actor: null }).join(" ")).toContain("actor");
  });

  it("mọi trường bắt buộc đều kèm LÝ DO — yêu cầu không giải thích được sẽ bị cắt", () => {
    for (const [k, ly] of BAT_BUOC) {
      expect(ly?.length, `${k} thiếu lý do`).toBeGreaterThan(10);
    }
  });
});

describe("miễn trừ", () => {
  it("mỗi miễn trừ trỏ file CÓ THẬT và kèm lý do dài", () => {
    for (const [f, ly] of MIEN_TRU) {
      expect(FILES, `${f} không còn trong kho`).toContain(f);
      expect(ly.length, `${f} lý do quá ngắn`).toBeGreaterThan(60);
    }
  });

  it("chống-xanh-rỗng: kho có biên nhận, và số miễn trừ KHÔNG vượt tổng", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(2);
    expect(MIEN_TRU.size).toBeLessThanOrEqual(FILES.length);
  });

  it("ghim: đúng 2 miễn trừ hôm nay — danh sách này chỉ được TEO", () => {
    // Thêm tên vào MIEN_TRU là sai cách dùng: nó chốt hiện trạng, không mở rộng.
    // Ca này đỏ khi ai đó thêm — và đỏ là đúng, phải xét lại chứ không nới số.
    expect(MIEN_TRU.size).toBe(2);
  });

  it("biên nhận 20260807163000 thiếu giấy phép — ghim để không mất dấu vết", () => {
    const bn = JSON.parse(readFileSync(new URL("20260807163000_ie_types_org_boundary.json", DIR), "utf8"));
    expect(bn.promotionToken).toBe(false);
    expect(bn.backupTaken).toBe(false);
  });
});
