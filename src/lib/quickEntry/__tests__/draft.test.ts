import { describe, it, expect } from "vitest";
import { validateDraft, type QuickDraft } from "../draft";

const company = (over: Partial<QuickDraft> = {}): QuickDraft => ({
  id: "0f1e2d3c-4b5a-4987-8765-43210fedcba9",
  mode: "company",
  date: "2026-10-01",
  name: "Mua bóng đèn",
  vendor: null,
  buildingId: "b102",
  roomId: null,
  accountId: "acc1",
  attachmentUrls: [],
  lines: [{ description: "2 × bóng đèn LED", amount: 120_000, categoryId: "t3", personalCategory: null, periodStart: null, periodEnd: null }],
  ...over,
});

const personal = (over: Partial<QuickDraft> = {}): QuickDraft => ({
  ...company(),
  mode: "personal",
  buildingId: null,
  accountId: null,
  lines: [{ description: "Bún bò", amount: 50_000, categoryId: null, personalCategory: "Ăn uống", periodStart: null, periodEnd: null }],
  ...over,
});

const issues = (d: QuickDraft) => {
  const r = validateDraft(d);
  return r.ok ? {} : r.issues;
};

describe("validateDraft — khoản công ty", () => {
  it("thẻ đủ thông tin ⇒ hợp lệ", () => {
    expect(validateDraft(company())).toEqual({ ok: true });
  });

  it("thiếu toà / sổ quỹ / hạng mục ⇒ báo đúng ô", () => {
    expect(Object.keys(issues(company({ buildingId: null })))).toEqual(["buildingId"]);
    expect(Object.keys(issues(company({ accountId: null })))).toEqual(["accountId"]);
    const noCategory = company({ lines: [{ ...company().lines[0], categoryId: null }] });
    expect(Object.keys(issues(noCategory))).toEqual(["lines.0.categoryId"]);
  });

  it("số tiền phải là số nguyên dương", () => {
    const zero = company({ lines: [{ ...company().lines[0], amount: 0 }] });
    const frac = company({ lines: [{ ...company().lines[0], amount: 1500.5 }] });
    expect(Object.keys(issues(zero))).toEqual(["lines.0.amount"]);
    expect(Object.keys(issues(frac))).toEqual(["lines.0.amount"]);
  });

  it("kỳ áp dụng: đầu kỳ không được sau cuối kỳ", () => {
    const bad = company({ lines: [{ ...company().lines[0], periodStart: "2026-09-30", periodEnd: "2026-09-01" }] });
    expect(Object.keys(issues(bad))).toEqual(["lines.0.periodEnd"]);
  });

  it("ảnh chứng từ phải là URL https, tối đa 20", () => {
    expect(Object.keys(issues(company({ attachmentUrls: ["blob:abc"] })))).toEqual(["attachmentUrls.0"]);
    const many = Array.from({ length: 21 }, (_, i) => `https://x.test/${i}.jpg`);
    expect(Object.keys(issues(company({ attachmentUrls: many })))).toEqual(["attachmentUrls"]);
  });

  it("ngày phiếu phải là ngày thật", () => {
    expect(Object.keys(issues(company({ date: "2026-02-30" })))).toEqual(["date"]);
  });

  it("không có dòng nào ⇒ báo ở lines", () => {
    expect(Object.keys(issues(company({ lines: [] })))).toEqual(["lines"]);
  });

  it("quá 200 dòng (trần writer) ⇒ báo ở lines", () => {
    const lines = Array.from({ length: 201 }, () => company().lines[0]);
    expect(Object.keys(issues(company({ lines })))).toEqual(["lines"]);
  });

  it("tên/mô tả dài KHÔNG chặn (convert tự cắt)", () => {
    const long = company({ name: "x".repeat(800), lines: [{ ...company().lines[0], description: "y".repeat(1500) }] });
    expect(validateDraft(long)).toEqual({ ok: true });
  });

  it("thông báo bằng tiếng Việt", () => {
    expect(issues(company({ buildingId: null })).buildingId).toBe("Chọn toà nhà cho khoản chi.");
  });
});

describe("validateDraft — khoản cá nhân", () => {
  it("không cần toà, sổ quỹ, hạng mục công ty", () => {
    expect(validateDraft(personal())).toEqual({ ok: true });
  });

  it("khoản cá nhân KHÔNG được mang ảnh (không lưu ảnh cá nhân)", () => {
    expect(Object.keys(issues(personal({ attachmentUrls: ["https://x.test/a.jpg"] })))).toEqual(["attachmentUrls"]);
  });
});
