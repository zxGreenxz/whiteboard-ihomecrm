// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationSettlementDialog } from "../ReservationSettlementDialog";
import { ReservationRefundDialog } from "../ReservationRefundDialog";

const state = vi.hoisted(() => ({
  canRefundNow: true,
  canSettle: true,
  blockers: [] as string[],
  previewError: null as Error | null,
  settleCalls: [] as unknown[],
  payCalls: [] as unknown[],
  payResult: "PAID" as "PAID" | "PENDING",
  closeCalls: [] as boolean[],
}));

vi.mock("@/hooks/useReservationSettlement", () => ({
  useReservationSettlementPreview: () => ({
    data: state.previewError ? undefined : {
      voucherId: "00000000-0000-4000-8000-000000000001",
      depositAmount: 3_000_000,
      fingerprint: "basis:v1",
      canSettle: state.canSettle,
      canRefundNow: state.canRefundNow,
      blockers: state.blockers,
      roomBlockers: [],
      voucherCode: "PT-DEMO-01",
      payerName: "Khách Demo",
      roomName: "101",
      buildingName: "Tòa DEMO",
      voucherDate: "2026-09-01",
    },
    isLoading: false,
    error: state.previewError,
  }),
  useSettleReservationDeposit: () => ({
    isPending: false,
    mutate: (input: unknown) => state.settleCalls.push(input),
  }),
  usePayReservationRefund: () => ({
    isPending: false,
    mutate: (input: unknown, callbacks: { onSuccess: (result: unknown) => void }) => {
      state.payCalls.push(input);
      callbacks.onSuccess({ refundState: state.payResult, refundRemaining: state.payResult === "PAID" ? 0 : 1_000_000 });
    },
  }),
}));

vi.mock("@/hooks/useMyPermissions", () => ({
  useMyPermissions: () => ({ data: { deposits: { refund: true }, income_expenses: { approve: true } } }),
}));
vi.mock("@/hooks/income-expenses/financeV2Mutations", () => ({
  useCustodianCashbooksV2: () => ({ data: [{ id: "00000000-0000-4000-8000-000000000010", name: "Sổ DEMO" }] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ data: { id: "00000000-0000-4000-8000-000000000099" } }) }));
const proof = "https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/object/public/income-expense-attachments/00000000-0000-4000-8000-000000000099/proof.png";
vi.mock("@/components/income-expenses/AttachmentUpload", () => ({ default: ({ onChange, onUploadingChange }: { onChange: (urls: string[]) => void; onUploadingChange: (busy: boolean) => void }) => <div><button onClick={() => onChange([proof])}>Thêm ảnh thử</button><button onClick={() => onUploadingChange(true)}>Đang tải ảnh thử</button></div> }));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value() {} });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { value() { return false; } });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value() {} });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value() {} });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

beforeEach(() => {
  state.canRefundNow = true; state.canSettle = true; state.blockers = []; state.previewError = null;
  state.settleCalls = []; state.payCalls = []; state.payResult = "PAID"; state.closeCalls = [];
});
afterEach(cleanup);

describe("ReservationSettlementDialog (mock RPC transport, real UI)", () => {
  it("includes transfer evidence for NOW, excludes it after switching to LATER", async () => {
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Hoàn lại khách"), { target: { value: "1000000" } });
    fireEvent.change(screen.getByLabelText("Sổ quỹ đã chi"), { target: { value: "00000000-0000-4000-8000-000000000010" } });
    fireEvent.click(screen.getByText("Thêm ảnh thử"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Xác nhận đã trả tiền cho khách" }));
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận xử lý" }));
    await waitFor(() => expect(state.settleCalls[0]).toMatchObject({ refundAttachments: [proof] }));
    fireEvent.change(screen.getByLabelText("Cách hoàn"), { target: { value: "LATER" } });
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận xử lý" }));
    await waitFor(() => expect(state.settleCalls[1]).toMatchObject({ refundAttachments: [] }));
  });

  it("waits for uploads before accepting a refund", () => {
    render(<ReservationRefundDialog settlementId="00000000-0000-4000-8000-000000000002" amount={100} open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Sổ quỹ đã chi"), { target: { value: "00000000-0000-4000-8000-000000000010" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Xác nhận đã trả toàn bộ tiền hoàn" }));
    fireEvent.click(screen.getByText("Đang tải ảnh thử"));
    expect(screen.getByRole("button", { name: "Ghi nhận hoàn tiền" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Sổ quỹ đã chi").closest("fieldset")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Ngày chi").closest("fieldset")).toHaveProperty("disabled", true);
  });

  it("locks mode and amount while transfer proof uploads so the uploader cannot be remounted", () => {
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Hoàn lại khách"), { target: { value: "1000000" } });
    fireEvent.click(screen.getByText("Đang tải ảnh thử"));
    expect(screen.getByLabelText("Cách hoàn").closest("fieldset")).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Hoàn lại khách").closest("fieldset")).toHaveProperty("disabled", true);
  });
  it("submits the full retained deposit with NONE and no cashbook", async () => {
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={(v) => state.closeCalls.push(v)} />);
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận xử lý" }));
    await waitFor(() => expect(state.settleCalls[0]).toMatchObject({ refundAmount: 0, refundMode: "NONE", refundAccountId: null }));
  });

  it("supports a partial deferred refund without an actual-payment confirmation", async () => {
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Hoàn lại khách"), { target: { value: "1000000" } });
    fireEvent.change(screen.getByLabelText("Cách hoàn"), { target: { value: "LATER" } });
    fireEvent.click(screen.getByRole("button", { name: "Xác nhận xử lý" }));
    await waitFor(() => expect(state.settleCalls[0]).toMatchObject({ refundAmount: 1_000_000, refundMode: "LATER", refundAccountId: null }));
  });

  it("requires a custodian cashbook and actual-payment checkbox for NOW", async () => {
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Hoàn lại khách"), { target: { value: "1000000" } });
    const submit = screen.getByRole("button", { name: "Xác nhận xử lý" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Sổ quỹ đã chi"), { target: { value: "00000000-0000-4000-8000-000000000010" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Xác nhận đã trả tiền cho khách" }));
    expect(submit).toHaveProperty("disabled", false);
    fireEvent.click(submit);
    await waitFor(() => expect(state.settleCalls[0]).toMatchObject({ refundMode: "NOW", refundAccountId: "00000000-0000-4000-8000-000000000010" }));
  });

  it("blocks invalid amounts and server/permission blockers", () => {
    state.canSettle = false; state.blockers = ["NOT_RECEIVED"];
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={() => {}} />);
    expect(screen.getByText("Phiếu chưa có bằng chứng tiền đã vào quỹ.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Hoàn lại khách"), { target: { value: "3000001" } });
    expect(screen.getByRole("button", { name: "Xác nhận xử lý" })).toHaveProperty("disabled", true);
  });

  it("does not render a fake zero when preview fails", () => {
    state.previewError = new Error("Không thể tải");
    render(<ReservationSettlementDialog voucherId="00000000-0000-4000-8000-000000000001" open onOpenChange={() => {}} />);
    expect(screen.getByText(/Không tải được số tiền đã đối chiếu/)).toBeTruthy();
    expect(screen.queryByText(/Cọc thực nhận:/)).toBeNull();
  });
});

describe("ReservationRefundDialog (mock RPC transport, real UI)", () => {
  it("pays a pending refund only after selecting a custodian book and confirming payment", async () => {
    render(<ReservationRefundDialog settlementId="00000000-0000-4000-8000-000000000002" amount={1_000_000} open onOpenChange={(v) => state.closeCalls.push(v)} />);
    fireEvent.change(screen.getByLabelText("Sổ quỹ đã chi"), { target: { value: "00000000-0000-4000-8000-000000000010" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Xác nhận đã trả toàn bộ tiền hoàn" }));
    fireEvent.click(screen.getByText("Thêm ảnh thử"));
    fireEvent.click(screen.getByRole("button", { name: "Ghi nhận hoàn tiền" }));
    await waitFor(() => expect(state.payCalls).toHaveLength(1));
    expect(state.payCalls[0]).toMatchObject({ refundAttachments: [proof] });
    expect(state.closeCalls).toContain(false);
  });

  it("keeps the dialog open when replay returns PENDING", () => {
    state.payResult = "PENDING";
    render(<ReservationRefundDialog settlementId="00000000-0000-4000-8000-000000000002" amount={1_000_000} open onOpenChange={(v) => state.closeCalls.push(v)} />);
    fireEvent.change(screen.getByLabelText("Sổ quỹ đã chi"), { target: { value: "00000000-0000-4000-8000-000000000010" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Xác nhận đã trả toàn bộ tiền hoàn" }));
    fireEvent.click(screen.getByRole("button", { name: "Ghi nhận hoàn tiền" }));
    expect(state.closeCalls).not.toContain(false);
  });
});
