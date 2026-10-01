// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({ createIE: vi.fn(), createPersonal: vi.fn(), upload: vi.fn() }));
vi.mock("@/hooks/income-expenses/mutations", () => ({ useCreateIncomeExpense: () => ({ mutateAsync: h.createIE }) }));
vi.mock("@/hooks/usePersonalTransactions", () => ({ useCreatePersonalTransaction: () => ({ mutateAsync: h.createPersonal }) }));
vi.mock("@/lib/storage", () => ({ uploadFileDetailed: h.upload }));
vi.mock("@/lib/authSession", () => ({ getSessionUser: async () => ({ id: "u1" }) }));

import { useQuickEntrySave } from "../useQuickEntrySave";
import type { QuickDraft } from "@/lib/quickEntry/draft";

const ID = "0f1e2d3c-4b5a-4987-8765-43210fedcba9";
const company: QuickDraft = {
  id: ID,
  mode: "company",
  date: "2026-10-01",
  name: "Mua bóng đèn",
  vendor: null,
  buildingId: "b102",
  roomId: null,
  accountId: "acc1",
  attachmentUrls: ["https://cdn.test/a.jpg"],
  lines: [{ description: "bóng đèn", amount: 120_000, categoryId: "t1", personalCategory: null, periodStart: null, periodEnd: null }],
};
const personal: QuickDraft = {
  ...company,
  mode: "personal",
  buildingId: null,
  accountId: null,
  attachmentUrls: [],
  name: "Đi chợ",
  lines: [
    { description: "rau", amount: 20_000, categoryId: null, personalCategory: "Ăn uống", periodStart: null, periodEnd: null },
    { description: "dầu gội", amount: 85_000, categoryId: null, personalCategory: "Cá nhân", periodStart: null, periodEnd: null },
  ],
};

beforeEach(() => {
  h.createIE.mockReset();
  h.createPersonal.mockReset();
  h.upload.mockReset();
});

const save = () => renderHook(() => useQuickEntrySave()).result.current;

describe("useQuickEntrySave — công ty", () => {
  it("gửi đúng hình phiếu với khoá chống trùng của thẻ; trả mã + trạng thái máy chủ quyết", async () => {
    h.createIE.mockResolvedValueOnce({ id: "v1", code: "PC2610001", approval_status: "UNAPPROVED" });
    const out = await save().saveCompany(company);
    expect(h.createIE.mock.calls[0][0]).toMatchObject({ idempotency_key: `qe-${ID}`, building_id: "b102", account_id: "acc1" });
    expect(out).toMatchObject({ kind: "saved", code: "PC2610001", approvalStatus: "UNAPPROVED", ids: ["v1"], done: 1 });
  });

  it("rớt mạng ⇒ 'unknown' (thẻ phải khoá, chỉ thử lại y nguyên)", async () => {
    h.createIE.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await save().saveCompany(company)).toMatchObject({ kind: "unknown", done: 0 });
  });

  it("23505 cùng khoá ⇒ 'maybe_saved' (có thể đã lưu ở lần trước)", async () => {
    h.createIE.mockRejectedValueOnce({ code: "23505", message: "duplicate key" });
    expect((await save().saveCompany(company)).kind).toBe("maybe_saved");
  });

  it("máy chủ từ chối (thiếu quyền) ⇒ 'rejected' kèm lời báo", async () => {
    h.createIE.mockRejectedValueOnce({ code: "42501", message: "Không có quyền tạo phiếu trên toà này" });
    const out = await save().saveCompany(company);
    expect(out.kind).toBe("rejected");
    expect(out.message.length).toBeGreaterThan(5);
  });
});

describe("useQuickEntrySave — cá nhân", () => {
  it("ghi từng khoản theo danh mục, trả các id", async () => {
    h.createPersonal.mockResolvedValueOnce({ id: "p1" }).mockResolvedValueOnce({ id: "p2" });
    const out = await save().savePersonal(personal);
    expect(h.createPersonal).toHaveBeenCalledTimes(2);
    expect(h.createPersonal.mock.calls[0][0]).toMatchObject({ type: "EXPENSE", amount: 20_000, category: "Ăn uống" });
    expect(out).toMatchObject({ kind: "saved", ids: ["p1", "p2"] });
  });

  it("khoản thứ hai rớt mạng ⇒ 'unknown' và giữ id khoản đã lưu", async () => {
    h.createPersonal.mockResolvedValueOnce({ id: "p1" }).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const out = await save().savePersonal(personal);
    expect(out).toMatchObject({ kind: "unknown", ids: ["p1"], done: 1 });
  });

  it("gửi lại sau khi khoản thứ hai rớt mạng ⇒ KHÔNG ghi lại khoản đầu đã lưu (ví không có khoá chống trùng)", async () => {
    h.createPersonal.mockResolvedValueOnce({ id: "p1" }).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const first = await save().savePersonal(personal);
    h.createPersonal.mockReset();
    h.createPersonal.mockResolvedValueOnce({ id: "p2" });
    const retry = await save().savePersonal(personal, first.done);
    expect(h.createPersonal).toHaveBeenCalledTimes(1);
    expect(h.createPersonal.mock.calls[0][0]).toMatchObject({ amount: 85_000, category: "Cá nhân" });
    expect(retry).toMatchObject({ kind: "saved", ids: ["p2"], done: 2 });
  });

  it("máy chủ từ chối khoản đầu ⇒ 'rejected', done = 0", async () => {
    h.createPersonal.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "42501" }));
    const out = await save().savePersonal(personal);
    expect(out).toMatchObject({ kind: "rejected", ids: [], done: 0 });
    expect(h.createPersonal).toHaveBeenCalledTimes(1);
  });
});

describe("useQuickEntrySave — ảnh chứng từ", () => {
  it("tải vào kho chứng từ phiếu, đường dẫn trong thư mục của chính người dùng, gắn id thẻ", async () => {
    h.upload.mockResolvedValueOnce({ url: "https://cdn.test/u1/x.jpg", path: "u1/x.jpg", type: "image/jpeg", size: 1 });
    const url = await save().uploadPhoto(new File(["x"], "bill.jpg", { type: "image/jpeg" }), ID);
    expect(url).toBe("https://cdn.test/u1/x.jpg");
    const [bucket, path] = h.upload.mock.calls[0];
    expect(bucket).toBe("income-expense-attachments");
    expect(path).toMatch(new RegExp(`^u1/\\d+-qe-${ID}\\.jpg$`));
  });

  it("ảnh chụp màn hình PNG/WebP ⇒ đuôi đường dẫn theo đúng loại ảnh (nén không lợi thì giữ file gốc)", async () => {
    h.upload.mockResolvedValue({ url: "https://cdn.test/u1/x", path: "u1/x", type: "image/png", size: 1 });
    await save().uploadPhoto(new File(["x"], "Screenshot.png", { type: "image/png" }), ID);
    await save().uploadPhoto(new File(["x"], "shopee", { type: "image/webp" }), ID);
    expect(h.upload.mock.calls[0][1]).toMatch(/\.png$/);
    expect(h.upload.mock.calls[1][1]).toMatch(/\.webp$/);
  });
});
