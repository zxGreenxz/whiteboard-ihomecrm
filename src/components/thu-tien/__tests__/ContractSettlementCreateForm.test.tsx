// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SettlementCreateSource } from "@/lib/contractSettlementCreate";
const m = vi.hoisted(() => ({
  source: null as SettlementCreateSource | null,
  create: vi.fn(),
  reconcile: vi.fn(),
  blocked: false,
}));
vi.mock("@/hooks/useContractSettlementCreate", () => ({
  useContractSettlementCreate: () => ({
    source: m.source,
    loading: false,
    error: null,
    phase: "idle",
    blocked: m.blocked,
    message: null,
    createFromSource: m.create,
    reconcile: m.reconcile,
  }),
}));
import { ContractSettlementCreateForm } from "../ContractSettlementCreateForm";
const org = "10000000-0000-4000-8000-000000000001",
  id = "20000000-0000-4000-8000-000000000001";
beforeEach(() => {
  m.source = {
    actorId: id,
    organizationId: org,
    kind: "termination_refund",
    sourceId: id,
    revision: "r1",
    canCreate: true,
    blockedReason: null,
    canForce: false,
    existingVoucherId: null,
    hiddenExisting: false,
    contractId: id,
    buildingId: id,
    roomId: id,
    sourceCode: "HD-1",
    sourceStatus: "APPROVED",
    sourceDate: "2026-09-21",
    today: "2026-09-21",
    name: "Hoàn cọc",
    recipientName: "Khách hồ sơ",
    recipientBank: "VCB",
    recipientAccount: "123",
    suggestedAmount: 100,
    capAmount: null,
    basis: {
      kind: "refund",
      months: null,
      ratePercent: null,
      expectedAmount: null,
      warning: null,
    },
    refund: {
      terminationId: id,
      contractId: id,
      organizationId: org,
      requestedAmount: 100,
      realHeld: 100,
      recognizedOnly: 0,
      basisStatus: "OK",
      basisFingerprint: "x",
      obligationStatus: "OK",
      warning: null,
    },
    latestObligation: null,
  };
  m.create.mockResolvedValue(undefined);
  m.blocked = false;
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function show() {
  render(
    <ContractSettlementCreateForm
      sourceRef={{
        kind: "termination_refund",
        organizationId: org,
        terminationId: id,
        obligationId: null,
        obligationVersion: null,
      }}
      onCreated={vi.fn()}
      refreshRequired={async () => {}}
    />,
  );
}
it("keeps the refund obligation amount read-only and persists reviewed recipient edits without a cashbook field", async () => {
  show();
  expect(
    (screen.getByLabelText("Số tiền theo nghĩa vụ (đ)") as HTMLInputElement)
      .readOnly,
  ).toBe(true);
  expect(screen.queryByLabelText("Ngày lập phiếu")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.change(screen.getByLabelText("Người nhận"), {
    target: { value: "Người nhận đã rà" },
  });
  fireEvent.change(screen.getByLabelText("Ngân hàng"), {
    target: { value: "ACB" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lập phiếu chờ duyệt" }));
  await waitFor(() =>
    expect(m.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        amount: 100,
        recipientName: "Người nhận đã rà",
        bank: "ACB",
        accountNumber: "123",
      }),
    ),
  );
});
it("never renders missing refund evidence as zero or allows creation", () => {
  m.source!.refund = null;
  show();
  expect(screen.getByRole("alert").textContent).toContain("Chưa đọc đủ căn cứ");
  expect(
    screen.queryByRole("button", { name: "Lập phiếu chờ duyệt" }),
  ).toBeNull();
});
it("opens an existing voucher through reconciliation without another creation", () => {
  m.source!.existingVoucherId = id;
  show();
  fireEvent.click(screen.getByRole("button", { name: "Mở phiếu hiện có" }));
  expect(m.reconcile).toHaveBeenCalledTimes(1);
  expect(m.create).not.toHaveBeenCalled();
});
it("requires permitted force confirmation and a meaningful reason for warning refunds", () => {
  m.source!.refund!.obligationStatus = "VUOT_COC_THAT";
  show();
  expect(
    (
      screen.getByRole("button", {
        name: "Lập phiếu chờ duyệt",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.queryByRole("checkbox")).toBeNull();
});
