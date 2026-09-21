// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({
  source: null as unknown,
  create: vi.fn(),
  reconcile: vi.fn(),
  blocked: false,
  message: null as string | null,
}));
vi.mock("@/hooks/useReservationRefundCreate", () => ({
  useReservationRefundCreate: () => ({
    source: m.source,
    createFromSource: m.create,
    reconcile: m.reconcile,
    blocked: m.blocked,
    message: m.message,
    error: null,
    loading: false,
  }),
}));
import { ReservationRefundCreateForm } from "../ReservationRefundCreateForm";
const props = {
  sourceRef: {
    kind: "reservation_refund" as const,
    organizationId: "org",
    sourceVoucherId: "source",
    settlementId: "s",
    refundVoucherId: null,
  },
  onCreated: vi.fn(),
  refreshRequired: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  m.blocked = false;
  m.message = null;
  m.source = {
    revision: "r",
    sourceCode: "GC1",
    payerName: "Nguoi nhan",
    depositAmount: 100,
    retainedAmount: 20,
    refundAmount: 80,
    paid: 0,
    remaining: 80,
    basisValid: true,
    canCreate: true,
    existingVoucherId: null,
    blockedReason: null,
  };
  m.create.mockResolvedValue({});
});
afterEach(cleanup);
it("shows verified full remaining, validates recipient bank pair, and sends no editable amount", async () => {
  render(<ReservationRefundCreateForm {...props} />);
  expect(screen.getByText(/80/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Ngân hàng"), {
    target: { value: "VCB" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lập phiếu chờ duyệt" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("Nhập đủ"),
  );
  expect(m.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Số tài khoản"), {
    target: { value: "00123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lập phiếu chờ duyệt" }));
  await waitFor(() =>
    expect(m.create).toHaveBeenCalledWith({
      recipientName: "Nguoi nhan",
      bank: "VCB",
      accountNumber: "00123",
    }),
  );
});
it("keeps an unknown request locked and provides read-only reconciliation", () => {
  m.blocked = true;
  m.message = "Chưa xác nhận";
  render(<ReservationRefundCreateForm {...props} />);
  expect(
    (
      screen.getByRole("button", {
        name: "Lập phiếu chờ duyệt",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Tải lại để đối chiếu" }));
  expect(m.reconcile).toHaveBeenCalledOnce();
  expect(m.create).not.toHaveBeenCalled();
});
it("opens existing voucher without creating or resubmitting", () => {
  m.source = {
    ...(m.source as object),
    existingVoucherId: "v",
    canCreate: false,
  };
  render(<ReservationRefundCreateForm {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Mở phiếu đã có" }));
  expect(m.reconcile).toHaveBeenCalledOnce();
  expect(m.create).not.toHaveBeenCalled();
});
it("does not fabricate zero or offer a write while source is missing", () => {
  m.source = null;
  render(<ReservationRefundCreateForm {...props} />);
  expect(
    screen.queryByRole("button", { name: "Lập phiếu chờ duyệt" }),
  ).toBeNull();
  expect(m.create).not.toHaveBeenCalled();
});
