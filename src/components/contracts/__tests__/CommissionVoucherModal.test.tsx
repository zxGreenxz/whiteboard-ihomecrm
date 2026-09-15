// @vitest-environment jsdom
//
// Modal "Tạo phiếu chi hoa hồng" — bug 15/09/2026: tạo HĐ xong modal mở, đang
// gõ thì ~1–2,5 giây sau form tự xoá sạch, có lần kẹt luôn ở dòng "Đang tải
// thông tin hợp đồng...".
//
// Chuỗi thật: create_contract_v2 ghi ≥5 bảng trong publication realtime ⇒ hub
// debounce 800 ms (trần 2,4 s) rồi invalidate hàng loạt key, trong đó có
// ["commission-prefill"] khai nhầm ở descriptor income_expenses ⇒ prefill
// refetch ⇒ trả về OBJECT MỚI ⇒ effect `[open, prefill]` reset MỌI ô người dùng
// đang gõ. Nếu cú refetch đó lỗi thì hook cũ trả null trong trạng thái success
// và modal kẹt ở dòng "Đang tải".
//
// Hai bài đầu khoá đúng hai hệ quả đó ở tầng giao diện.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CommissionPrefillData } from "@/hooks/useCommissionVoucher";

const state = vi.hoisted(() => ({
  prefill: undefined as unknown,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
  create: vi.fn(),
  accounts: [] as unknown[],
}));

vi.mock("@/hooks/useCommissionVoucher", () => ({
  useCommissionPrefill: () => ({
    data: state.prefill,
    isPending: state.isPending,
    isLoading: state.isPending,
    isError: state.isError,
    error: state.isError ? new Error("Không đọc được hợp đồng") : null,
    refetch: state.refetch,
  }),
  useCreateCommissionVoucher: () => ({ mutateAsync: state.create, isPending: false }),
  useExistingCommissionVouchers: () => ({ data: [] }),
}));
vi.mock("@/hooks/useSaleBonus", () => ({ useSaleBonusStatus: () => ({ data: null }) }));
vi.mock("@/hooks/useAccounts", () => ({ useAccounts: () => ({ data: state.accounts }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "u1" } }) }));
vi.mock("@/components/income-expenses/BankSelect", () => ({ default: () => null }));
vi.mock("@/components/income-expenses/AttachmentUpload", () => ({ default: () => null }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { CommissionVoucherModal } from "../CommissionVoucherModal";

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

/** Mỗi lần gọi trả về một OBJECT MỚI, giá trị y hệt — đúng thứ refetch tạo ra. */
const prefillMoi = (): CommissionPrefillData => ({
  contract_id: "c1",
  contract_number: "HD-001",
  signed_date: "2026-09-15",
  start_date: "2026-09-15",
  end_date: "2027-09-14",
  rent_price: 5_000_000,
  months: 12,
  matched_tier: { min_months: 6, max_months: 12, rate_percent: 50 } as CommissionPrefillData["matched_tier"],
  building_id: "b1",
  building_name: "Toà A",
  room_id: "r1",
  room_name: "P101",
  tenant_id: "k1",
  tenant_name: "Khách A",
});

const oTenMG = () => screen.getByPlaceholderText("Tên công ty / cá nhân môi giới") as HTMLInputElement;

beforeEach(() => {
  state.prefill = prefillMoi();
  state.isPending = false;
  state.isError = false;
  state.refetch.mockReset();
  state.create.mockReset();
  state.accounts = [{ id: "acc-toa-a", name: "Toà A", is_default: false }, { id: "acc-khac", name: "Sổ khác", is_default: true }];
});
afterEach(cleanup);

it("refetch prefill (object mới) KHÔNG xoá ô người dùng đang gõ", () => {
  const { rerender } = render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  fireEvent.change(oTenMG(), { target: { value: "MG Bình Minh" } });
  expect(oTenMG().value).toBe("MG Bình Minh");

  // Hub realtime đánh thức prefill: cùng dữ liệu, KHÁC identity.
  state.prefill = prefillMoi();
  rerender(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  expect(oTenMG().value).toBe("MG Bình Minh");
});

it("prefill lỗi thì báo lỗi và cho tải lại, không kẹt ở dòng 'Đang tải'", () => {
  state.prefill = undefined;
  state.isError = true;
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  expect(screen.queryByText(/Đang tải thông tin hợp đồng/)).toBeNull();
  expect(screen.getByText(/Không tải được thông tin hợp đồng/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Tải lại" }));
  expect(state.refetch).toHaveBeenCalledTimes(1);
});

it("đang tải thì hiện dòng chờ và vẫn bỏ qua được", () => {
  state.prefill = undefined;
  state.isPending = true;
  const close = vi.fn();
  render(<CommissionVoucherModal open contractId="c1" onOpenChange={close} />);

  expect(screen.getByText(/Đang tải thông tin hợp đồng/)).toBeTruthy();
  const boQua = screen.getByRole("button", { name: "Bỏ qua" }) as HTMLButtonElement;
  expect(boQua.disabled).toBe(false);
  fireEvent.click(boQua);
  expect(close).toHaveBeenCalledWith(false);
});

it("sổ quỹ mặc định lấy từ danh sách sổ quỹ của modal, kể cả khi sổ về sau prefill", () => {
  state.accounts = [];
  const { rerender } = render(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  // Sổ quỹ về sau prefill — vẫn phải chọn được sổ cùng tên toà.
  state.accounts = [{ id: "acc-toa-a", name: "toà a", is_default: false }];
  rerender(<CommissionVoucherModal open contractId="c1" onOpenChange={() => {}} />);

  expect(screen.getByText("Mặc định: sổ quỹ cùng tên với tòa nhà.")).toBeTruthy();
});
