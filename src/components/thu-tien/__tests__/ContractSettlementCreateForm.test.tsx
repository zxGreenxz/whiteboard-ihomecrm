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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  vi.unstubAllGlobals();
});
function show() {
  return render(
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

it.each([
  [1.5, "Nhập số tiền nguyên lớn hơn 0."],
  [101, "Số tiền đề xuất vượt trần thưởng đã công bố."],
])(
  "validates amount %s before dispatch and shows a field error",
  async (amount, message) => {
    m.source!.kind = "sale_contract";
    m.source!.capAmount = 100;
    m.source!.refund = null;
    show();
    fireEvent.change(screen.getByLabelText("Số tiền đề xuất (đ)"), {
      target: { value: amount },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Lập phiếu từ nguồn" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(message),
    );
    expect(m.create).not.toHaveBeenCalled();
  },
);
it("rejects a missing voucher date before dispatch and preserves the recipient draft", async () => {
  m.source!.kind = "sale_contract";
  m.source!.refund = null;
  show();
  fireEvent.change(screen.getByLabelText("Người nhận"), {
    target: { value: "Đang đối chiếu" },
  });
  fireEvent.change(screen.getByLabelText("Ngày lập phiếu"), {
    target: { value: "" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Lập phiếu từ nguồn" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Ngày lập phiếu không hợp lệ.",
    ),
  );
  expect((screen.getByLabelText("Người nhận") as HTMLInputElement).value).toBe(
    "Đang đối chiếu",
  );
  expect(m.create).not.toHaveBeenCalled();
});
it("blocks forced submit of an unconfirmed warning and keeps the unknown-result lock", async () => {
  m.source!.canForce = true;
  m.source!.refund!.obligationStatus = "VUOT_COC_THAT";
  show();
  fireEvent.submit(screen.getByRole("form", { name: "Lập phiếu từ nguồn" }));
  await waitFor(() =>
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0),
  );
  expect(m.create).not.toHaveBeenCalled();
});
it("does not dispatch a programmatic submit when the shared hook is locked", async () => {
  m.blocked = true;
  show();
  fireEvent.submit(screen.getByRole("form", { name: "Lập phiếu từ nguồn" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(m.create).not.toHaveBeenCalled();
});

it("keeps existing-voucher reconciliation available when new creation is route-disabled", () => {
  m.source!.existingVoucherId = id;
  render(
    <ContractSettlementCreateForm
      sourceRef={{ kind: "termination_refund", organizationId: org, terminationId: id, obligationId: null, obligationVersion: null }}
      onCreated={() => {}}
      refreshRequired={async () => {}}
      creationDisabled
    />,
  );
  const open = screen.getByRole("button", { name: "Mở phiếu hiện có" }) as HTMLButtonElement;
  expect(open.disabled).toBe(false);
  fireEvent.click(open);
  expect(m.reconcile).toHaveBeenCalledOnce();
});

it("preserves a reviewed recipient draft when a failed request unlocks the same source", () => {
  const view = show();
  fireEvent.change(screen.getByLabelText("Người nhận"), {
    target: { value: "Giữ bản nhập" },
  });
  const rerender = () =>
    view.rerender(
      <ContractSettlementCreateForm
        sourceRef={{
          kind: "termination_refund",
          organizationId: org,
          terminationId: id,
          obligationId: null,
          obligationVersion: null,
        }}
        onCreated={() => {}}
        refreshRequired={async () => {}}
      />,
    );
  m.blocked = true;
  rerender();
  m.blocked = false;
  rerender();
  expect((screen.getByLabelText("Người nhận") as HTMLInputElement).value).toBe(
    "Giữ bản nhập",
  );
});
