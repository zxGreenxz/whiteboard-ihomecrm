import { describe, it, expect } from "vitest";
import { findMoneyCandidates, normalizeForParse, pickAmount } from "../amount";

// Mọi số mong đợi dưới đây tính tay, không dùng hàm đang test.
const value = (text: string) => pickAmount(text)?.value ?? null;

describe("pickAmount — số kèm đơn vị rõ ràng", () => {
  it.each([
    ["50k", 50_000],
    ["50K", 50_000],
    ["50 k", 50_000],
    ["50 nghìn", 50_000],
    ["50 ngàn", 50_000],
    ["50 nghin", 50_000],
    ["50ng", 50_000],
    ["2,5k", 2_500],
  ])("nghìn: %s → %d", (text, want) => {
    expect(value(text)).toBe(want);
  });

  it.each([
    ["1tr", 1_000_000],
    ["1 tr", 1_000_000],
    ["1 triệu", 1_000_000],
    ["1 trieu", 1_000_000],
    ["1tr2", 1_200_000],
    ["1tr25", 1_250_000],
    ["1tr200", 1_200_000],
    ["1tr05", 1_050_000],
    ["1 tr 2", 1_200_000],
    ["1 triệu 2", 1_200_000],
    ["1 triệu 250", 1_250_000],
    ["1,2tr", 1_200_000],
    ["1.5 triệu", 1_500_000],
    ["0,5tr", 500_000],
  ])("triệu: %s → %d", (text, want) => {
    expect(value(text)).toBe(want);
  });

  it("dấu phân cách theo sau đúng 3 chữ số là phân nhóm nghìn, không phải phần thập phân", () => {
    // "1.250 triệu" = một nghìn hai trăm năm mươi triệu, KHÔNG phải 1,25 triệu.
    expect(value("1.250 triệu")).toBe(1_250_000_000);
  });

  it.each([
    ["120000đ", 120_000],
    ["120000d", 120_000],
    ["120.000đ", 120_000],
    ["120.000 đ", 120_000],
    ["120,000 VND", 120_000],
    ["120.000 vnđ", 120_000],
    ["1 200 000 đồng", 1_200_000],
    ["1.200.000", 1_200_000],
  ])("đồng: %s → %d", (text, want) => {
    expect(value(text)).toBe(want);
  });

  it.each([
    ["2 triệu 300 nghìn", 2_300_000],
    ["1 tỷ 2", 1_200_000_000],
    ["1 tỷ 200 triệu", 1_200_000_000],
    ["2 triệu rưỡi", 2_500_000],
    ["2 triệu ruoi", 2_500_000],
    ["1tr rưỡi", 1_500_000],
    ["5 nghìn rưỡi", 5_500],
    ["1 triệu 200 nghìn đồng", 1_200_000],
  ])("ghép nhiều bậc: %s → %d", (text, want) => {
    expect(value(text)).toBe(want);
  });

  it("đánh dấu loại explicit", () => {
    expect(pickAmount("mua sơn 300k")?.kind).toBe("explicit");
  });
});

describe("pickAmount — tiếng lóng", () => {
  it.each([
    ["1 củ", 1_000_000],
    ["1 củ 2", 1_200_000],
    ["3 lít", 300_000],
    ["1 lít 2", 120_000],
    ["2 xị rưỡi", 250_000],
    ["ba lít", 300_000],
  ])("%s → %d", (text, want) => {
    expect(value(text)).toBe(want);
    expect(pickAmount(text)?.kind).toBe("slang");
  });

  it("số kèm đơn vị rõ ràng thắng tiếng lóng trong cùng câu", () => {
    expect(value("đổ 3 lít xăng 75k")).toBe(75_000);
    expect(value("2 củ hành 10k")).toBe(10_000);
  });
});

describe("pickAmount — số trần", () => {
  it("số trần dưới 1000 là nghìn (khớp Tạo phiếu nhanh)", () => {
    expect(value("120")).toBe(120_000);
    expect(value("mua bóng đèn 120")).toBe(120_000);
    expect(pickAmount("mua bóng đèn 120")?.kind).toBe("bare");
  });

  it("số trần từ 1000 trở lên là đồng", () => {
    expect(value("120000")).toBe(120_000);
  });

  it("'gửi xe 5000' là tiền gửi xe, không phải số xe (biển số luôn dính chữ cái)", () => {
    expect(value("gửi xe 5000")).toBe(5_000);
    expect(pickAmount("gửi xe 5000")?.warning).toBe("small_amount");
  });

  it("số trần nhỏ hơn 10.000 đồng có cảnh báo, số có đơn vị thì không", () => {
    expect(pickAmount("5000")?.warning).toBe("small_amount");
    expect(pickAmount("gửi xe 5k")?.warning).toBeNull();
  });

  it("lấy số trần CUỐI khi có nhiều số trần", () => {
    expect(value("mua 2 đèn 120")).toBe(120_000);
    expect(pickAmount("mua 2 đèn 120")?.ambiguous).toBe(true);
  });

  it("số đứng trước danh từ đếm là số lượng, không phải tiền", () => {
    expect(pickAmount("mua bóng đèn 2 cái")).toBeNull();
    expect(value("mua 2 bóng đèn 120")).toBe(120_000);
    expect(pickAmount("mua 2 bóng đèn 120")?.ambiguous).toBe(false);
  });
});

describe("pickAmount — không ăn nhầm số phòng, mã toà, ngày, giờ", () => {
  it.each([
    ["phòng 301 sửa vòi 150", 150_000],
    ["p301 150", 150_000],
    ["P.301 thay khoá 200k", 200_000],
    ["102LVT điện 450k", 450_000],
    ["rác 15KV 300k", 300_000],
    ["tiền điện tháng 9 1tr2", 1_200_000],
    ["ngày 25/9 mua sơn 300k", 300_000],
    ["lúc 9h mua nước 20k", 20_000],
    ["x2 120k", 120_000],
  ])("%s → %d", (text, want) => {
    expect(value(text)).toBe(want);
  });

  it.each([["x3"], ["ab12 sửa điện"], ["mã hd50k"]])(
    "số dính chữ phía trước là một phần của mã: %s → không có số tiền",
    (text) => {
      expect(pickAmount(text)).toBeNull();
    },
  );

  it.each([["năm 2026"], ["phòng 301"], ["p301"], ["25/9"], ["9:30"], ["ăn trưa"], [""]])(
    "%s → không có số tiền",
    (text) => {
      expect(pickAmount(text)).toBeNull();
    },
  );
});

describe("pickAmount — số nói bằng chữ (bản chữ từ giọng nói)", () => {
  it.each([
    ["một trăm hai mươi nghìn", 120_000],
    ["hai mươi mốt nghìn", 21_000],
    ["hai mươi tư nghìn", 24_000],
    ["mười lăm nghìn", 15_000],
    ["một trăm linh năm nghìn", 105_000],
    ["một trăm lẻ năm nghìn", 105_000],
    ["năm chục", 50_000],
    ["một trăm hai", 120_000],
    ["hai trăm rưỡi", 250_000],
    ["một triệu hai", 1_200_000],
    ["một triệu hai trăm", 1_200_000],
    ["một triệu hai trăm năm mươi nghìn", 1_250_000],
    ["một triệu không trăm năm mươi nghìn", 1_050_000],
    ["hai triệu rưỡi", 2_500_000],
    ["một củ hai", 1_200_000],
    ["một tỷ hai", 1_200_000_000],
    ["1 triệu hai trăm", 1_200_000],
    ["Một Trăm Hai Mươi Nghìn", 120_000],
  ])("%s → %d", (text, want) => {
    expect(value(text)).toBe(want);
  });

  it("chữ số đứng một mình không có bậc/đơn vị không phải tiền", () => {
    expect(pickAmount("hai bóng đèn")).toBeNull();
    expect(pickAmount("mua hai cái")).toBeNull();
  });
});

describe("findMoneyCandidates", () => {
  it("trả mọi số tiền theo thứ tự xuất hiện, kèm vị trí trên chuỗi đã chuẩn hoá", () => {
    const text = "Bóng đèn 60k ống nước 80K";
    const norm = normalizeForParse(text);
    const found = findMoneyCandidates(text);
    expect(found.map((c) => c.value)).toEqual([60_000, 80_000]);
    expect(found.map((c) => norm.slice(c.start, c.end))).toEqual(["60k", "80k"]);
  });

  it("nhiều số rõ ràng trong một đoạn ⇒ lấy số cuối và báo mơ hồ", () => {
    const pick = pickAmount("bóng đèn 60k ống nước 80k");
    expect(pick?.value).toBe(80_000);
    expect(pick?.ambiguous).toBe(true);
  });
});
