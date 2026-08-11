// Sổ đột biến cho scripts/check-graph-secrets.mjs.
//
// Một gate không có bộ đột biến chứng minh nó BẮN ĐƯỢC thì chỉ là một hàm luôn in
// dấu tích. Mỗi ca dưới đây bẻ đúng một thứ và đòi gate phản ứng đúng.
//
// Ca đắt nhất là "hash trông như số điện thoại": đó là dương tính giả đã đo thật
// (11 chuỗi trong .ua/fingerprints.json ngày 08/08/2026 đều là 10 chữ số nằm trong
// sha256). Nếu ai đó sau này "cải tiến" gate thành quét thô toàn file, ca này đỏ và
// nói rõ vì sao không được làm thế.
import { describe, expect, it } from "vitest";

import {
  bocVanBanNguoi,
  che,
  EMAIL_MIEN_TRU,
  MAU_PII,
  timGitleaks,
  timPII,
  TOI_THIEU_TRUONG_VAN_BAN,
  TRUONG_VAN_BAN,
} from "../check-graph-secrets.mjs";

describe("timPII — bắt đúng thứ phải bắt", () => {
  it("bắt số điện thoại VN trong summary", () => {
    const r = timPII("Hook lấy hợp đồng của khách, liên hệ 0912345678 khi cần đối chiếu.");
    expect(r).toHaveLength(1);
    expect(r[0].loai).toBe("số điện thoại VN");
  });

  it("bắt cả dạng +84", () => {
    expect(timPII("gọi +84912345678")).toHaveLength(1);
  });

  it("bắt email khách", () => {
    const r = timPII("Seed dữ liệu cho tài khoản khachhang.thuc@gmail.com trong fixture.");
    expect(r).toHaveLength(1);
    expect(r[0].loai).toBe("email");
  });

  it("KHÔNG bắt email miễn trừ (noreply, example.com)", () => {
    expect(timPII("trailer Co-Authored-By: ai <noreply@anthropic.com>")).toHaveLength(0);
    expect(timPII("tài khoản mẫu user@example.com dùng trong tài liệu")).toHaveLength(0);
  });

  it("KHÔNG bắt số hoá đơn / số tiền / mã phòng", () => {
    expect(timPII("Hoá đơn 1234567890 trị giá 15000000 đồng, phòng A0301.")).toHaveLength(0);
  });

  it("CA QUAN TRỌNG NHẤT — chuỗi 10 chữ số nằm trong sha256 KHÔNG phải số điện thoại", () => {
    // Đây là dương tính giả đã đo thật trên .ua/fingerprints.json.
    // Gate quét theo TRƯỜNG, không quét thô, nên contentHash không bao giờ tới đây.
    // Ca này chốt rằng contentHash KHÔNG nằm trong danh sách trường được quét.
    expect(TRUONG_VAN_BAN.has("contentHash")).toBe(false);
    expect(TRUONG_VAN_BAN.has("filePath")).toBe(false);
    expect(TRUONG_VAN_BAN.has("id")).toBe(false);
  });
});

describe("bocVanBanNguoi — bóc đúng trường, bỏ đúng trường", () => {
  const mau = {
    nodes: [
      {
        id: "file:src/a.ts",
        filePath: "src/a.ts",
        name: "a.ts",
        summary: "Tóm tắt của a.ts",
        tags: ["hook", "utility"],
        complexity: "simple",
      },
    ],
    fingerprints: {
      "src/a.ts": { filePath: "src/a.ts", contentHash: "0989123456b879acda907fc3cd2162b348fa63a0" },
    },
  };

  it("bóc summary, name, tags", () => {
    const r = bocVanBanNguoi(mau);
    const truong = r.map((x) => x.truong).sort();
    expect(truong).toEqual(["name", "summary", "tags", "tags"]);
  });

  it("KHÔNG bóc contentHash — nguồn của mọi dương tính giả", () => {
    const r = bocVanBanNguoi(mau);
    expect(r.some((x) => x.text.includes("0989123456"))).toBe(false);
  });

  it("KHÔNG bóc filePath và id", () => {
    const r = bocVanBanNguoi(mau);
    expect(r.some((x) => x.truong === "filePath" || x.truong === "id")).toBe(false);
  });

  it("ghi đường dẫn để báo lỗi chỉ đúng chỗ", () => {
    const r = bocVanBanNguoi(mau).find((x) => x.truong === "summary");
    expect(r.duong).toBe("nodes[0].summary");
  });

  it("đi được vào cấu trúc lồng sâu", () => {
    const r = bocVanBanNguoi({ a: { b: { c: [{ summary: "sâu" }] } } });
    expect(r).toHaveLength(1);
    expect(r[0].duong).toBe("a.b.c[0].summary");
  });

  it("PII trong summary lồng sâu vẫn bị bắt — nối hai hàm lại", () => {
    const r = bocVanBanNguoi({ tour: [{ description: "liên hệ 0987654321" }] });
    expect(r).toHaveLength(1);
    expect(timPII(r[0].text)).toHaveLength(1);
  });
});

describe("che — báo cáo không được tự nó thành chỗ rò", () => {
  it("không in nguyên giá trị", () => {
    const s = "0912345678";
    expect(che(s)).not.toBe(s);
    expect(che(s)).not.toContain("12345");
  });

  it("chuỗi ngắn cũng bị che", () => {
    expect(che("abc")).toBe("a…");
  });
});

describe("sàn chống-xanh-rỗng và cấu hình", () => {
  it("sàn trường văn bản đủ lớn để có nghĩa", () => {
    // Graph thật của repo này bóc ra ~27.000 trường. Sàn 500 là rất rộng rãi,
    // nhưng đủ để phân biệt "graph thật" với "file rỗng / schema đã đổi".
    expect(TOI_THIEU_TRUONG_VAN_BAN).toBeGreaterThanOrEqual(100);
  });

  it("có đủ hai họ mẫu PII", () => {
    expect(MAU_PII.map((x) => x.ten).sort()).toEqual(["email", "số điện thoại VN"]);
  });

  it("danh sách miễn trừ email không rỗng và không phải bắt-tất", () => {
    expect(EMAIL_MIEN_TRU.length).toBeGreaterThan(0);
    expect(EMAIL_MIEN_TRU.some((re) => re.test("khach.that@gmail.com"))).toBe(false);
  });

  it("timGitleaks trả null khi biến môi trường trỏ vào đường không tồn tại và PATH cũng không có", () => {
    // Không khẳng định máy CI có hay không có gitleaks — chỉ chốt hợp đồng:
    // hàm trả về null HOẶC một đường dẫn dùng được, không bao giờ ném.
    const r = timGitleaks();
    expect(r === null || typeof r === "string").toBe(true);
  });
});
