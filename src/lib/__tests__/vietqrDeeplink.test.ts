import { describe, it, expect } from "vitest";
import {
  matchRecipientBankCode,
  buildVietQRDeeplink,
  sanitizeTransferText,
  extractRecipientFromNotes,
  RECIPIENT_BANKS,
  VIETQR_BANK_APPS,
} from "@/lib/vietqrDeeplink";

describe("matchRecipientBankCode", () => {
  // Các giá trị receive_bank_name THẬT từ DB production
  it("khớp tên bank gõ tự do thực tế trong DB", () => {
    expect(matchRecipientBankCode("VIETTINBANK")).toBe("icb");
    expect(matchRecipientBankCode("Viettin Bank")).toBe("icb");
    expect(matchRecipientBankCode("Vietcombank")).toBe("vcb");
    expect(matchRecipientBankCode("MB Bank")).toBe("mb");
    expect(matchRecipientBankCode("NGAN HANG QUAN DOI MBBANK")).toBe("mb");
    expect(
      matchRecipientBankCode("Ngân hàng BIDV chi nhánh Trường Sơn")
    ).toBe("bidv");
    expect(matchRecipientBankCode("Ngân Hàng VIB")).toBe("vib");
  });

  it("alias ngắn chỉ khớp nguyên token — không ăn nhầm substring", () => {
    // "sacombank" chứa "mb"/"acb" dạng substring nhưng phải ra Sacombank
    expect(matchRecipientBankCode("Sacombank")).toBe("stb");
    expect(matchRecipientBankCode("scb")).toBe("scb");
    expect(matchRecipientBankCode("ACB")).toBe("acb");
  });

  it("không nhận diện được → null", () => {
    expect(matchRecipientBankCode("ngân hàng gì đó")).toBeNull();
    expect(matchRecipientBankCode("")).toBeNull();
    expect(matchRecipientBankCode(null)).toBeNull();
    expect(matchRecipientBankCode(undefined)).toBeNull();
  });

  it("Timo by Ban Viet Bank ra Timo (không phải Bản Việt)", () => {
    expect(matchRecipientBankCode("Timo by Ban Viet Bank")).toBe("timo");
  });
});

describe("buildVietQRDeeplink", () => {
  it("đúng format dl.vietqr.io/pay với đủ tham số", () => {
    const url = buildVietQRDeeplink({
      appId: "vcb",
      bankCode: "icb",
      accountNumber: "60535688",
      amount: 1800000,
      note: "PC2606003 Hoa hồng môi giới",
      recipientName: "ĐẶNG LỮ ÁI QUYÊN",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://dl.vietqr.io/pay");
    expect(parsed.searchParams.get("app")).toBe("vcb");
    expect(parsed.searchParams.get("ba")).toBe("60535688@icb");
    expect(parsed.searchParams.get("am")).toBe("1800000");
    expect(parsed.searchParams.get("tn")).toBe("pc2606003 hoa hong moi gioi");
    expect(parsed.searchParams.get("bn")).toBe("dang lu ai quyen");
  });

  it("STK có khoảng trắng/gạch được làm sạch; bỏ am/tn khi không có", () => {
    const url = buildVietQRDeeplink({
      appId: "mb",
      bankCode: "vcb",
      accountNumber: "1343 064-469",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("ba")).toBe("1343064469@vcb");
    expect(parsed.searchParams.get("am")).toBeNull();
    expect(parsed.searchParams.get("tn")).toBeNull();
  });
});

describe("sanitizeTransferText", () => {
  it("bỏ dấu + ký tự đặc biệt, cắt 70 ký tự", () => {
    expect(sanitizeTransferText("Hoa hồng môi giới HĐ HD-2026-00004")).toBe(
      "hoa hong moi gioi hd hd-2026-00004"
    );
    expect(sanitizeTransferText("a".repeat(100)).length).toBe(70);
  });
});

describe("extractRecipientFromNotes", () => {
  it("tách tên từ ghi chú phiếu hoa hồng", () => {
    expect(extractRecipientFromNotes("Người nhận: ĐẶNG LỮ ÁI QUYÊN")).toBe(
      "ĐẶNG LỮ ÁI QUYÊN"
    );
    expect(extractRecipientFromNotes("ghi chú khác")).toBeNull();
    expect(extractRecipientFromNotes(null)).toBeNull();
  });
});

describe("data sanity", () => {
  it("appId và bank code không trùng lặp", () => {
    const appIds = VIETQR_BANK_APPS.map((a) => a.appId);
    expect(new Set(appIds).size).toBe(appIds.length);
    const codes = RECIPIENT_BANKS.map((b) => b.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("mỗi bank tự khớp shortName của chính nó", () => {
    for (const bank of RECIPIENT_BANKS) {
      const matched = matchRecipientBankCode(bank.shortName);
      expect(matched, `shortName "${bank.shortName}"`).toBe(bank.code);
    }
  });
});
