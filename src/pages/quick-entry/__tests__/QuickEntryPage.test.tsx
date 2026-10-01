// @vitest-environment jsdom
// Trang thật: ô nhập → hook điều phối → thẻ → lưu. Chỉ giả AI, lưu, quyền/dữ liệu nền và khung bố cục.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import type { QuickEntryRefs } from "@/hooks/quick-entry/useQuickEntryRefs";

const h = vi.hoisted(() => ({
  phone: true,
  refs: null as unknown as QuickEntryRefs,
  readWithAi: vi.fn(),
  saveCompany: vi.fn(),
  savePersonal: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/copilot/copilotConfig", () => ({ makeCopilotFetch: () => vi.fn(), newTaskId: () => "qe-t", QUICK_ENTRY_BASE: "https://p.test" }));
vi.mock("@/hooks/use-mobile", () => ({ usePhoneViewport: () => h.phone }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u1" } }) }));
vi.mock("@/hooks/useVoucherSlotWarning", () => ({ useVoucherSlotWarning: () => ({ data: [] }) }));
vi.mock("@/components/layout/MainLayout", () => ({
  default: ({ title, children }: { title?: string; children: ReactNode }) => (
    <div data-testid="main-layout">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));
vi.mock("@/hooks/quick-entry/useQuickEntryRefs", () => ({
  useQuickEntryRefs: () => h.refs,
  rememberAccount: vi.fn(),
}));
vi.mock("@/hooks/quick-entry/quickEntryAi", () => ({ readWithAi: h.readWithAi, transcribeAudio: vi.fn() }));
vi.mock("@/hooks/quick-entry/useQuickEntrySave", () => ({
  useQuickEntrySave: () => ({ uploadPhoto: vi.fn(), saveCompany: h.saveCompany, savePersonal: h.savePersonal }),
}));

import QuickEntryPage from "../QuickEntryPage";

const baseRefs = (over: Partial<QuickEntryRefs> = {}): QuickEntryRefs => ({
  orgId: "org-1",
  loading: false,
  canCompany: true,
  canPersonal: true,
  buildings: [{ id: "b102", name: "Toà 102", code: "102LVT", is_virtual: false, user_id: "u", managed: true }],
  rooms: [],
  categories: [{ id: "t-son", name: "Sơn sửa", category: "Bảo Trì", type: "expense", organization_id: "org-1" }],
  cashbooks: [{ id: "acc1", label: "Quỹ 102" }],
  resolveRefs: { buildings: [{ id: "b102", name: "Toà 102", code: "102LVT" }], rooms: [], feeAccounts: [] },
  defaultAccountFor: (b) => (b ? "acc1" : null),
  ...over,
});

const page = (path = "/chi-tieu") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <QuickEntryPage />
    </MemoryRouter>,
  );

const type = async (text: string) => {
  const box = screen.getByLabelText("Nội dung khoản chi");
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
};

beforeEach(() => {
  localStorage.clear();
  h.phone = true;
  h.refs = baseRefs();
  h.readWithAi.mockReset();
  h.saveCompany.mockReset();
  h.savePersonal.mockReset();
  h.readWithAi.mockResolvedValue({
    ok: true,
    model: "9router:cx/gpt-6-luna(low)",
    value: {
      items: [{ desc: "sơn", amount_vnd: 300_000, category: "c1", confidence: 0.9 }],
      total_vnd: null,
      date: null,
      vendor: null,
      building_mention: null,
      room_mention: null,
      customer_code: null,
      period_start: null,
      period_end: null,
    },
  });
});
afterEach(cleanup);

describe("QuickEntryPage", () => {
  it("điện thoại: gõ một câu ⇒ thẻ phiếu chi đủ ô ⇒ Lưu ⇒ biên nhận mã phiếu", async () => {
    h.saveCompany.mockResolvedValue({ kind: "saved", code: "PC2610001", approvalStatus: "UNAPPROVED", ids: ["v1"], done: 1, message: "" });
    const { container } = page();
    expect(container.querySelector(".cm-app")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Báo chi nhanh" })).toBeTruthy();
    await type("102LVT sơn 300k");
    expect(screen.getByText("102LVT sơn 300k")).toBeTruthy();
    expect(screen.getByTestId("draft-total").textContent).toBe("300.000đ");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lưu phiếu chi" }));
    });
    expect(h.saveCompany).toHaveBeenCalledTimes(1);
    expect(h.saveCompany.mock.calls[0][0]).toMatchObject({ buildingId: "b102", accountId: "acc1", lines: [{ amount: 300_000, categoryId: "t-son" }] });
    expect(screen.getByTestId("saved-receipt").textContent).toContain("PC2610001 · Chờ duyệt");
  });

  it("AI lỗi tạm thời ⇒ có nút 'Thử AI lại'; bấm thì AI điền hạng mục, nút biến mất", async () => {
    h.readWithAi.mockResolvedValueOnce({ ok: false, error: { kind: "network", message: "Mất kết nối khi gọi AI.", retryable: true, allowManual: true } });
    page();
    await type("102LVT keo 20k");
    expect(screen.getByLabelText("Hạng mục dòng 1").textContent).toBe("Chọn hạng mục");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Thử AI lại" }));
    });
    expect(screen.getByLabelText("Hạng mục dòng 1").textContent).toBe("Sơn sửa");
    expect(screen.queryByRole("button", { name: "Thử AI lại" })).toBeNull();
  });

  it("?che-do=ca-nhan ⇒ ghi vào Ví cá nhân", async () => {
    h.savePersonal.mockResolvedValue({ kind: "saved", code: null, approvalStatus: null, ids: ["p1"], done: 1, message: "" });
    page("/chi-tieu?che-do=ca-nhan");
    expect(screen.getByText("Ghi vào Ví cá nhân")).toBeTruthy();
    await type("bún bò 50k");
    expect(screen.getByTestId("draft-card").getAttribute("data-mode")).toBe("personal");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lưu vào ví" }));
    });
    expect(h.savePersonal).toHaveBeenCalledTimes(1);
    expect(h.saveCompany).not.toHaveBeenCalled();
  });

  it("chỉ có quyền ví cá nhân ⇒ không có công tắc, ghi cá nhân dù URL đòi công ty", async () => {
    h.refs = baseRefs({ canCompany: false });
    page("/chi-tieu?che-do=cong-ty");
    expect(screen.queryByRole("group", { name: "Ghi vào" })).toBeNull();
    await type("bún bò 50k");
    expect(screen.getByTestId("draft-card").getAttribute("data-mode")).toBe("personal");
  });

  it("đổi chế độ được nhớ cho lần mở sau", async () => {
    const first = page();
    fireEvent.click(screen.getByRole("button", { name: "Cá nhân" }));
    expect(screen.getByText("Ghi vào Ví cá nhân")).toBeTruthy();
    first.unmount();
    page();
    expect(screen.getByText("Ghi vào Ví cá nhân")).toBeTruthy();
  });

  it("chọn mô hình đọc + mức ⇒ AI đọc bằng đúng id đó; lựa chọn được nhớ cho lần mở sau", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: { kind: "network", message: "x", retryable: true, allowManual: true } });
    const first = page();
    fireEvent.click(screen.getByRole("button", { name: /Mô hình AI/ }));
    fireEvent.change(screen.getByLabelText("Mô hình đọc chữ"), { target: { value: "cx/gpt-6.1-sol" } });
    fireEvent.change(screen.getByLabelText("Mức suy nghĩ"), { target: { value: "high" } });
    await type("102LVT keo 20k");
    expect(h.readWithAi.mock.calls.at(-1)?.[0].model).toBe("cx/gpt-6.1-sol(high)");
    first.unmount();
    page();
    expect(screen.getByRole("button", { name: /Mô hình AI/ }).textContent).toContain("GPT-6.1 Sol · cao");
  });

  it("chưa tự chọn mô hình ⇒ không gửi model: máy chủ dùng chuỗi vận hành đặt qua biến môi trường", async () => {
    h.readWithAi.mockResolvedValue({ ok: false, error: { kind: "network", message: "x", retryable: true, allowManual: true } });
    page();
    await type("102LVT keo 20k");
    expect(h.readWithAi).toHaveBeenCalled();
    expect(h.readWithAi.mock.calls.at(-1)?.[0].model).toBeUndefined();
  });

  it("không có quyền nào ⇒ báo rõ, không có ô nhập", () => {
    h.refs = baseRefs({ canCompany: false, canPersonal: false });
    page();
    expect(screen.getByRole("alert").textContent).toMatch(/chưa có quyền/);
    expect(screen.queryByLabelText("Nội dung khoản chi")).toBeNull();
  });

  it("đang tải dữ liệu nền ⇒ chưa cho nhập (tránh thẻ thiếu toà/hạng mục)", () => {
    h.refs = baseRefs({ loading: true });
    page();
    expect(screen.queryByLabelText("Nội dung khoản chi")).toBeNull();
    expect(screen.getByText(/Đang tải toà, hạng mục và sổ quỹ/)).toBeTruthy();
  });

  it("máy tính ⇒ nằm trong MainLayout, không dùng khung điện thoại", () => {
    h.phone = false;
    const { container } = page();
    expect(screen.getByTestId("main-layout")).toBeTruthy();
    expect(container.querySelector(".cm-app")).toBeNull();
    expect(screen.getByLabelText("Nội dung khoản chi")).toBeTruthy();
  });
});
