// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";

const slot = vi.hoisted(() => ({ data: [] as Array<{ code: string; totalAmount: number }> }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/hooks/useVoucherSlotWarning", () => ({ useVoucherSlotWarning: () => ({ data: slot.data }) }));

import { DraftCard } from "../DraftCard";
import type { CardStatus } from "@/lib/quickEntry/cardStatus";
import type { DraftState } from "@/lib/quickEntry/compose";
import type { QuickDraft } from "@/lib/quickEntry/draft";
import { PERSONAL_CATEGORIES } from "@/lib/personalCategories";

const today = "2026-10-01";
const buildings = [
  { id: "b102", name: "Toà 102", code: "102LVT", is_virtual: false, user_id: "u", managed: true },
  { id: "b405", name: "Toà 405", code: "405PVB", is_virtual: false, user_id: "u", managed: true },
];
const rooms = [{ id: "r301", name: "301", code: null, building_id: "b102", floor: 3 }];
const categories = [{ id: "t-vt", name: "Vật tư", category: "Bảo Trì", type: "expense" as const }];
const cashbooks = [{ id: "acc1", label: "Quỹ tiền mặt 102" }];

const state = (over: Partial<QuickDraft> = {}, extra: Partial<DraftState> = {}): DraftState => ({
  draft: {
    id: "d1",
    mode: "company",
    date: today,
    name: "sơn",
    vendor: null,
    buildingId: "b102",
    roomId: null,
    accountId: "acc1",
    attachmentUrls: [],
    lines: [{ description: "sơn", amount: 300_000, categoryId: "t-vt", personalCategory: null, periodStart: null, periodEnd: null }],
    ...over,
  },
  touched: [],
  locked: [],
  flags: [],
  buildingCandidates: [],
  source: "text",
  sourceText: "sơn 300k",
  ...extra,
});

function Harness(p: {
  initial: DraftState;
  status?: CardStatus;
  photoUrl?: string;
  cashbookList?: typeof cashbooks;
  buildingList?: typeof buildings;
  onSave?: () => void;
  onDiscard?: () => void;
  spy?: (s: DraftState) => void;
}) {
  const [s, setS] = useState(p.initial);
  return (
    <MemoryRouter>
      <DraftCard
        state={s}
        status={p.status ?? { kind: "draft" }}
        today={today}
        buildings={p.buildingList ?? buildings}
        rooms={rooms}
        categories={categories}
        cashbooks={p.cashbookList ?? cashbooks}
        personalCategories={PERSONAL_CATEGORIES}
        photoUrl={p.photoUrl}
        defaultAccountFor={(b) => (b ? `acc-${b}` : null)}
        onChange={(n) => {
          p.spy?.(n);
          setS(n);
        }}
        onSave={p.onSave ?? vi.fn()}
        onDiscard={p.onDiscard ?? vi.fn()}
      />
    </MemoryRouter>
  );
}

const lastOf = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[spy.mock.calls.length - 1][0] as DraftState;
/** Ô bị khoá qua <fieldset disabled> cha — thuộc tính `disabled` của chính ô không phản ánh điều này. */
const fieldsetLocked = (label: string) => screen.getByLabelText(label).closest("fieldset")?.disabled ?? false;

afterEach(() => {
  cleanup();
  slot.data = [];
});

describe("DraftCard — lưu", () => {
  it("thẻ đủ ô ⇒ bấm Lưu phiếu chi gọi onSave", () => {
    const onSave = vi.fn();
    render(<Harness initial={state()} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Lưu phiếu chi" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("thiếu hạng mục ⇒ không lưu được và nhắc chọn hạng mục", () => {
    const base = state();
    render(<Harness initial={state({ lines: [{ ...base.draft.lines[0], categoryId: null }] })} />);
    expect(screen.getByRole("button", { name: "Lưu phiếu chi" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Chọn hạng mục chi\./)).toBeTruthy();
  });

  it("người dùng không được giao sổ quỹ nào ⇒ nói rõ lý do, không bảo 'chọn sổ' khi không có gì để chọn", () => {
    render(<Harness initial={state({ accountId: null })} cashbookList={[]} />);
    expect(screen.getByTestId("no-cashbook").textContent).toMatch(/chưa được giao sổ quỹ/);
    expect(screen.queryByText(/Chọn sổ quỹ chi tiền\./)).toBeNull();
    expect(screen.getByRole("button", { name: "Lưu phiếu chi" })).toHaveProperty("disabled", true);
  });

  it("có sổ nhưng chưa chọn ⇒ vẫn nhắc chọn sổ, không có lời 'chưa được giao'", () => {
    render(<Harness initial={state({ accountId: null })} />);
    expect(screen.getByText(/Chọn sổ quỹ chi tiền\./)).toBeTruthy();
    expect(screen.queryByTestId("no-cashbook")).toBeNull();
  });

  it("toà có tên trùng mã ⇒ hiện một lần, không lặp '102LVT — 102LVT'", () => {
    const same = [{ ...buildings[0], name: "102LVT" }];
    render(<Harness initial={state()} buildingList={same} />);
    expect(screen.getByLabelText("Toà").textContent).toBe("102LVT");
  });

  it("chưa có tiền ⇒ cờ 'Chưa có số tiền', không nhắc thêm câu số tiền lần hai", () => {
    const base = state();
    render(<Harness initial={state({ lines: [{ ...base.draft.lines[0], amount: 0 }] })} />);
    expect(screen.getByText(/Chưa có số tiền/)).toBeTruthy();
    expect(screen.queryByText(/Số tiền phải là số đồng nguyên dương/)).toBeNull();
  });
});

describe("DraftCard — sửa", () => {
  it("sửa mô tả ⇒ tên phiếu đổi theo và ô được đánh dấu đã sửa (AI không đè)", () => {
    const spy = vi.fn();
    render(<Harness initial={state()} spy={spy} />);
    fireEvent.change(screen.getByLabelText("Mô tả dòng 1"), { target: { value: "sơn nước" } });
    const s = lastOf(spy);
    expect(s.draft.name).toBe("sơn nước");
    expect(s.touched).toContain("lines.0.description");
  });

  it("tự sửa tiền ⇒ cờ 'dưới 10.000đ' tắt", () => {
    const base = state();
    const spy = vi.fn();
    render(<Harness initial={state({ lines: [{ ...base.draft.lines[0], amount: 5_000 }] }, { flags: ["small_amount"] })} spy={spy} />);
    expect(screen.getByText(/dưới 10\.000đ/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Số tiền dòng 1"), { target: { value: "50.000" } });
    expect(lastOf(spy).draft.lines[0].amount).toBe(50_000);
    expect(screen.queryByText(/dưới 10\.000đ/)).toBeNull();
  });

  it("chip 'Hôm qua' ⇒ lùi đúng một ngày theo hôm nay", () => {
    const spy = vi.fn();
    render(<Harness initial={state()} spy={spy} />);
    fireEvent.click(screen.getByRole("button", { name: "Hôm qua" }));
    expect(lastOf(spy).draft.date).toBe("2026-09-30");
  });

  it("câu nhắc nhiều toà ⇒ chip chọn toà; chọn xong gán sổ mặc định của toà đó", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={state({ buildingId: null, accountId: null }, { buildingCandidates: ["b102", "b405"], flags: ["building_choice"] })}
        spy={spy}
      />,
    );
    expect(screen.getByText(/Câu nhắc nhiều toà/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "405PVB" }));
    expect(lastOf(spy).draft).toMatchObject({ buildingId: "b405", accountId: "acc-b405", roomId: null });
    expect(screen.queryByText(/Câu nhắc nhiều toà/)).toBeNull();
  });

  it("đã tự chọn sổ ⇒ đổi toà KHÔNG đổi sổ", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={state({ buildingId: null, accountId: "acc-rieng" }, { buildingCandidates: ["b102", "b405"], touched: ["accountId"] })}
        spy={spy}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "102LVT" }));
    expect(lastOf(spy).draft).toMatchObject({ buildingId: "b102", accountId: "acc-rieng" });
  });
});

describe("DraftCard — trạng thái máy chủ", () => {
  it("chưa rõ đã lưu ⇒ khoá ô, không còn nút Lưu, chỉ cho Gửi lại y nguyên", () => {
    const onSave = vi.fn();
    render(<Harness initial={state()} status={{ kind: "unknown", message: "Chưa rõ đã lưu chưa" }} onSave={onSave} />);
    expect(fieldsetLocked("Mô tả dòng 1")).toBe(true);
    expect(fieldsetLocked("Số tiền dòng 1")).toBe(true);
    expect(fieldsetLocked("Toà")).toBe(true);
    expect(screen.queryByRole("button", { name: "Lưu phiếu chi" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Gửi lại y nguyên/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("chưa rõ đã lưu ⇒ vẫn bỏ được thẻ (thẻ bị từ chối lặp lại không kẹt suốt 48 giờ)", () => {
    const onDiscard = vi.fn();
    render(<Harness initial={state()} status={{ kind: "unknown", message: "Đã ghi 1/2 khoản" }} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole("button", { name: "Bỏ thẻ" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("có thể đã lưu (23505) ⇒ không có nút gửi lại, chỉ kiểm tra hoặc bỏ thẻ", () => {
    const onDiscard = vi.fn();
    render(<Harness initial={state()} status={{ kind: "maybe_saved", message: "Có thể đã lưu" }} onDiscard={onDiscard} />);
    expect(screen.queryByRole("button", { name: /Gửi lại/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Kiểm tra trong Thu chi" }).getAttribute("href")).toBe("/income-expense");
    fireEvent.click(screen.getByRole("button", { name: "Bỏ thẻ" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("đã lưu ⇒ biên nhận mã phiếu và trạng thái duyệt do máy chủ quyết", () => {
    const { unmount } = render(
      <Harness initial={state()} status={{ kind: "saved", code: "PC2610001", approvalStatus: "UNAPPROVED" }} />,
    );
    expect(screen.getByTestId("saved-receipt").textContent).toContain("Đã lưu PC2610001 · Chờ duyệt");
    unmount();
    render(<Harness initial={state()} status={{ kind: "saved", code: "PC2610002", approvalStatus: "APPROVED" }} />);
    expect(screen.getByTestId("saved-receipt").textContent).toContain("Đã lưu PC2610002 · Đã duyệt");
  });

  it("bị từ chối ⇒ hiện lời máy chủ, vẫn sửa và lưu lại được", () => {
    render(<Harness initial={state()} status={{ kind: "rejected", message: "Sổ quỹ đã khoá kỳ" }} />);
    expect(screen.getByRole("alert").textContent).toContain("Sổ quỹ đã khoá kỳ");
    expect(fieldsetLocked("Mô tả dòng 1")).toBe(false);
    expect(screen.getByRole("button", { name: "Lưu phiếu chi" })).toHaveProperty("disabled", false);
  });

  it("kỳ này toà đã có phiếu cùng hạng mục ⇒ cảnh báo kèm mã phiếu (không chặn)", () => {
    slot.data = [{ code: "PC2609001", totalAmount: 300_000 }];
    render(<Harness initial={state()} />);
    expect(screen.getByTestId("slot-warning").textContent).toContain("PC2609001");
    expect(screen.getByRole("button", { name: "Lưu phiếu chi" })).toHaveProperty("disabled", false);
  });
});

describe("DraftCard — cá nhân", () => {
  it("không có toà/sổ quỹ; ảnh chỉ để AI đọc, không lưu", () => {
    const s = state({
      mode: "personal",
      buildingId: null,
      accountId: null,
      lines: [{ description: "bún bò", amount: 50_000, categoryId: null, personalCategory: "Ăn uống", periodStart: null, periodEnd: null }],
    });
    render(<Harness initial={s} photoUrl="blob:anh" />);
    expect(screen.queryByLabelText("Toà")).toBeNull();
    expect(screen.queryByLabelText("Sổ quỹ")).toBeNull();
    expect(screen.getByText("Ảnh chỉ để AI đọc — không lưu.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lưu vào ví" })).toHaveProperty("disabled", false);
  });
});
