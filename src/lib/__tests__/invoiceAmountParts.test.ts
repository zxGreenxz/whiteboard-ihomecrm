import { describe, expect, it } from "vitest";
import {
  categorySharesOf,
  invoiceAmountPartsRowsSchema,
  invoiceAdjustmentsText,
  invoicePartColumnAmount,
  invoicePartialNote,
  signedShortVnd,
  type InvoiceAmountParts,
} from "@/lib/invoiceAmountParts";

// Phần tách do server trả (migration 20261025165112) — ở đây chỉ kiểm phần web: nhãn, ghi chú, cộng hạng mục.
const phan = (p: Partial<InvoiceAmountParts> = {}): InvoiceAmountParts => ({
  rent: 5_500_000, electric: 1_727_700, water: 300_000, service: 200_000, other: 0,
  discount: -200_000, debt: 0, rounding: -700, invoice_amount: 7_527_000, partial: false, ...p,
});

describe("invoiceAmountParts", () => {
  it("cột PDV gộp phí dịch vụ + khoản khác; các cột khác lấy nguyên", () => {
    const p = phan({ service: 300_000, other: 100_000 });
    expect(invoicePartColumnAmount(p, "service")).toBe(400_000);
    expect(invoicePartColumnAmount(p, "rent")).toBe(5_500_000);
    expect(invoicePartColumnAmount(p, "electric")).toBe(1_727_700);
  });

  it("dưới tổng tiền: giảm trừ / nợ cũ chỉ số gọn có dấu, làm tròn KHÔNG ghi (chủ nhắn 26/10/2026)", () => {
    expect(invoiceAdjustmentsText(phan())).toBe("−200k");
    expect(invoiceAdjustmentsText(phan({ discount: 0, debt: 17_000 }))).toBe("+17k");
    expect(invoiceAdjustmentsText(phan({ discount: -200_700, debt: 17_000 }))).toBe("−200,7k · +17k");
    expect(invoiceAdjustmentsText(phan({ discount: 0, rounding: -800 }))).toBe("");
    expect(signedShortVnd(-1_250_000)).toBe("−1,3tr");
    expect(signedShortVnd(500)).toBe("+500đ");
  });

  it("chia tỷ lệ: nói rõ thu một phần hay thu nhiều hơn hoá đơn; trả đủ thì không ghi", () => {
    expect(invoicePartialNote(phan(), 7_527_000)).toBe("");
    expect(invoicePartialNote(phan({ partial: true, invoice_amount: 6_300_000 }), 3_000_000))
      .toBe("thu một phần (hoá đơn 6.300.000) — chia theo tỷ lệ");
    expect(invoicePartialNote(phan({ partial: true, invoice_amount: 6_300_000 }), 6_500_000))
      .toBe("thu nhiều hơn hoá đơn (6.300.000) — chia theo tỷ lệ");
  });

  it("theo hạng mục: dòng có phần tách cộng theo phần của hoá đơn, dòng khác theo hạng mục; bỏ dòng ghi chú; tổng không đổi", () => {
    const parts = new Map([["a", phan()]]);
    const rows = [
      { key: "a", name: "Thu tiền hoá đơn", amount: 7_527_000 },
      { key: "b", name: "Phí giữ xe", amount: 3_500_000 },
      { key: "c", name: "—", amount: 50_000 },
      { key: "d", name: "Tiền phòng", amount: 1_000 },
      { key: "ghi-chu", name: "Phòng trống", amount: 0, isNote: true },
    ];
    const cats = categorySharesOf(rows, parts);
    const tim = (n: string) => cats.find((c) => c.name === n)?.amount;
    expect(tim("Tiền phòng")).toBe(5_501_000);
    expect(tim("Tiền điện")).toBe(1_727_700);
    expect(tim("Giảm trừ hoá đơn")).toBe(-200_000);
    expect(tim("Làm tròn hoá đơn")).toBe(-700);
    expect(tim("Phí giữ xe")).toBe(3_500_000);
    expect(tim("Khác")).toBe(50_000);
    expect(tim("Thu tiền hoá đơn")).toBeUndefined();
    // phần bằng 0 (khoản khác, nợ cũ) không thành hạng mục
    expect(tim("Thu khác")).toBeUndefined();
    expect(tim("Nợ cũ")).toBeUndefined();
    expect(cats.reduce((s, c) => s + c.amount, 0)).toBe(7_527_000 + 3_500_000 + 50_000 + 1_000);
    // chưa có phần tách ⇒ theo hạng mục của dòng
    expect(categorySharesOf(rows).find((c) => c.name === "Thu tiền hoá đơn")?.amount).toBe(7_527_000);
  });

  it("gói RPC sai hình (thiếu trường) thì zod ném, không đoán số", () => {
    expect(() => invoiceAmountPartsRowsSchema.parse([{ key: "a", rent: 1 }])).toThrow();
  });
});
