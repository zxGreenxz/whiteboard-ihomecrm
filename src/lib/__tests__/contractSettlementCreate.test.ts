import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContractSettlementVoucher,
  type SettlementCreatePorts,
  type SettlementCreateRequest,
  type SettlementCreateSource,
} from "../contractSettlementCreate";
import type { IncomeExpenseActionSnapshot } from "../incomeExpenseActionSnapshot";
const org = "10000000-0000-4000-8000-000000000001",
  actor = "20000000-0000-4000-8000-000000000001",
  source = "30000000-0000-4000-8000-000000000001",
  voucherId = "40000000-0000-4000-8000-000000000001",
  obligationId = "50000000-0000-4000-8000-000000000001";
let current: SettlementCreateSource,
  request: SettlementCreateRequest,
  ports: SettlementCreatePorts;
let voucher: IncomeExpenseActionSnapshot;
beforeEach(() => {
  current = {
    actorId: actor,
    organizationId: org,
    kind: "broker",
    sourceId: source,
    revision: "reviewed",
    canCreate: true,
    blockedReason: null,
    canForce: false,
    existingVoucherId: null,
    hiddenExisting: false,
    contractId: source,
    buildingId: source,
    roomId: source,
    sourceCode: "HD-source",
    sourceStatus: "ACTIVE",
    sourceDate: "2026-09-21",
    today: "2026-09-21",
    name: "Nguồn thật",
    recipientName: null,
    recipientBank: null,
    recipientAccount: null,
    suggestedAmount: 100,
    capAmount: null,
    basis: {
      kind: "commission",
      months: 12,
      ratePercent: 50,
      expectedAmount: 100,
      warning: null,
    },
    refund: null,
    latestObligation: null,
  };
  request = {
    actorId: actor,
    sourceRef: { kind: "broker", organizationId: org, contractId: source },
    expectedRevision: "reviewed",
    draft: {
      amount: 100,
      voucherDate: "2026-09-21",
      payerName: "Môi giới A",
      recipientName: "Người nhận A",
      bank: "VCB",
      accountNumber: "123",
      itemDescription: "Hoa hồng theo hợp đồng",
      attachments: [],
      force: false,
      forceReason: "",
      forceConfirmed: false,
    },
  };
  voucher = {
    id: voucherId,
    organizationId: org,
    contractId: source,
    type: "EXPENSE",
    totalAmount: 100,
    accountId: null,
    approvalStatus: "UNAPPROVED",
    reviewState: "PENDING",
    postingStatus: "UNPOSTED",
    activePostingId: null,
    code: "PC-original",
    systemSource: "contract.commission",
  } as IncomeExpenseActionSnapshot;
  ports = {
    readSource: vi.fn().mockImplementation(async () => ({ ...current })),
    readVoucher: vi.fn().mockImplementation(async () => voucher),
    createCommission: vi.fn().mockImplementation(async () => {
      current.existingVoucherId = voucherId;
      return { id: voucherId, code: voucher.code };
    }),
    createDeposit: vi.fn().mockImplementation(async () => {
      current.existingVoucherId = voucherId;
      return {
        voucherId,
        code: voucher.code,
        amount: 100,
        depositVoucherId: source,
      };
    }),
    previewRefund: vi.fn(),
    recordObligation: vi.fn(),
    readObligation: vi.fn(),
    createRefund: vi.fn().mockImplementation(async () => {
      current.existingVoucherId = voucherId;
      return { voucherId, code: voucher.code, amount: 100 };
    }),
  };
});
describe("source creation boundary", () => {
  const refund = () => {
    request.sourceRef = {
      kind: "termination_refund",
      organizationId: org,
      terminationId: source,
      obligationId: null,
      obligationVersion: null,
    };
    current.kind = "termination_refund";
    current.sourceStatus = "APPROVED";
    voucher.systemSource = "termination.refund";
    voucher.payerName = "Người nhận A";
    voucher.receiveBankName = "VCB";
    voucher.receiveBankAccount = "123";
    current.refund = {
      terminationId: source,
      contractId: source,
      organizationId: org,
      requestedAmount: 100,
      realHeld: 100,
      recognizedOnly: 0,
      basisStatus: "OK",
      basisFingerprint: "actual-basis",
      obligationStatus: "OK",
      warning: null,
    };
    vi.mocked(ports.previewRefund).mockImplementation(async () => ({
      ...current.refund!,
    }));
    vi.mocked(ports.recordObligation).mockResolvedValue({
      obligationId,
      version: 7,
      terminationId: source,
      obligationStatus: "OK",
    });
    vi.mocked(ports.readObligation).mockImplementation(async () => ({
      id: obligationId,
      version: 7,
      ...current.refund!,
    }));
  };
  it("keeps refund preview → record → create and passes NULL account with the supported recipient overload", async () => {
    refund();
    expect(await createContractSettlementVoucher(request, ports)).toEqual({
      outcome: "created",
      voucherId,
    });
    expect(ports.previewRefund).toHaveBeenCalledExactlyOnceWith(source);
    expect(ports.recordObligation).toHaveBeenCalledExactlyOnceWith(source);
    expect(ports.createRefund).toHaveBeenCalledExactlyOnceWith({
      p_obligation_id: obligationId,
      p_account_id: null,
      p_force: false,
      p_force_reason: null,
      p_recipient_name: "Người nhận A",
      p_recipient_bank: "VCB",
      p_recipient_account: "123",
    });
    expect(
      vi.mocked(ports.previewRefund).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(ports.recordObligation).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(ports.recordObligation).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(ports.createRefund).mock.invocationCallOrder[0]);
  });
  it.each(["permission", "confirmation", "reason"])(
    "refuses warning force without %s",
    async (missing) => {
      refund();
      current.refund!.obligationStatus = "VUOT_COC_THAT";
      current.canForce = true;
      request.draft.force = true;
      request.draft.forceConfirmed = true;
      request.draft.forceReason = "Lý do đã đối chiếu";
      if (missing === "permission") current.canForce = false;
      if (missing === "confirmation") request.draft.forceConfirmed = false;
      if (missing === "reason") request.draft.forceReason = "ngắn";
      await expect(
        createContractSettlementVoucher(request, ports),
      ).rejects.toMatchObject({ kind: "blocked" });
      expect(ports.recordObligation).not.toHaveBeenCalled();
      expect(ports.createRefund).not.toHaveBeenCalled();
    },
  );
  it("preserves owner force reason while still creating without account", async () => {
    refund();
    current.refund!.obligationStatus = "VUOT_COC_THAT";
    current.canForce = true;
    request.draft.force = true;
    request.draft.forceConfirmed = true;
    request.draft.forceReason = "Lý do đã đối chiếu";
    await createContractSettlementVoucher(request, ports);
    expect(ports.createRefund).toHaveBeenCalledWith({
      p_obligation_id: obligationId,
      p_account_id: null,
      p_force: true,
      p_force_reason: "Lý do đã đối chiếu",
      p_recipient_name: "Người nhận A",
      p_recipient_bank: "VCB",
      p_recipient_account: "123",
    });
  });
  it("halts when the recorded obligation differs from the reviewed basis", async () => {
    refund();
    vi.mocked(ports.readObligation).mockResolvedValue({
      id: obligationId,
      version: 7,
      ...current.refund!,
      requestedAmount: 999,
    });
    await expect(
      createContractSettlementVoucher(request, ports),
    ).rejects.toMatchObject({ kind: "conflict" });
    expect(ports.createRefund).not.toHaveBeenCalled();
  });
  it.each(["DRAFT", "PENDING_APPROVAL", "CANCELLED"])(
    "does not create a refund from %s termination",
    async (state) => {
      refund();
      current.sourceStatus = state;
      await expect(
        createContractSettlementVoucher(request, ports),
      ).rejects.toMatchObject({ kind: "blocked" });
      expect(ports.recordObligation).not.toHaveBeenCalled();
    },
  );
  it.each(["broker", "sale_contract"] as const)(
    "passes explicit account NULL and all supported recipient fields for %s",
    async (kind) => {
      request.sourceRef = { kind, organizationId: org, contractId: source };
      current.kind = kind;
      const result = await createContractSettlementVoucher(request, ports);
      expect(result).toEqual({ outcome: "created", voucherId });
      expect(ports.createCommission).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          p_contract_id: source,
          p_kind: kind === "broker" ? "broker" : "sale",
          p_account_id: null,
          p_amount: 100,
          p_recipient_name: "Người nhận A",
          p_recipient_bank: "VCB",
          p_recipient_account: "123",
          p_voucher_date: "2026-09-21",
        }),
      );
    },
  );
  it("uses the actual deposit ID and explicit NULL account", async () => {
    request.sourceRef = {
      kind: "sale_deposit",
      organizationId: org,
      depositVoucherId: source,
    };
    current.kind = "sale_deposit";
    current.contractId = null;
    voucher.contractId = null;
    expect(await createContractSettlementVoucher(request, ports)).toEqual({
      outcome: "created",
      voucherId,
    });
    expect(ports.createDeposit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        p_deposit_voucher_id: source,
        p_account_id: null,
        p_recipient: "Người nhận A",
        p_account_number: "123",
        p_bank: "VCB",
      }),
    );
    expect(ports.createCommission).not.toHaveBeenCalled();
  });
  it("returns an existing approved voucher truthfully without creation or amount rewriting", async () => {
    current.existingVoucherId = voucherId;
    voucher.approvalStatus = "APPROVED";
    voucher.totalAmount = 333;
    expect(await createContractSettlementVoucher(request, ports)).toEqual({
      outcome: "existing",
      voucherId,
    });
    expect(ports.createCommission).not.toHaveBeenCalled();
  });
  it.each(["scope", "revision", "permission", "hidden"])(
    "blocks %s drift before any write",
    async (field) => {
      if (field === "scope") current.organizationId = source;
      if (field === "revision") current.revision = "changed";
      if (field === "permission") current.canCreate = false;
      if (field === "hidden") current.hiddenExisting = true;
      await expect(
        createContractSettlementVoucher(request, ports),
      ).rejects.toThrow();
      expect(ports.createCommission).not.toHaveBeenCalled();
    },
  );
  it.each(["account", "approval", "posting", "amount", "source"])(
    "rejects an anomalous newly created %s without compensating writes",
    async (field) => {
      if (field === "account") voucher.accountId = source;
      if (field === "approval") voucher.approvalStatus = "APPROVED";
      if (field === "posting") voucher.activePostingId = source;
      if (field === "amount") voucher.totalAmount = 999;
      if (field === "source") current.existingVoucherId = null;
      if (field === "source")
        vi.mocked(ports.createCommission).mockResolvedValue({
          id: voucherId,
          code: voucher.code,
        });
      await expect(
        createContractSettlementVoucher(request, ports),
      ).rejects.toMatchObject({ kind: "unconfirmed" });
    },
  );
  it("recovers a duplicate or timeout by the exact source claim, not a second create", async () => {
    vi.mocked(ports.createCommission).mockImplementation(async () => {
      current.existingVoucherId = voucherId;
      throw new TypeError("network timeout");
    });
    expect(await createContractSettlementVoucher(request, ports)).toEqual({
      outcome: "existing",
      voucherId,
    });
    expect(ports.createCommission).toHaveBeenCalledTimes(1);
  });
  it("keeps a timeout without a verified claim unknown", async () => {
    vi.mocked(ports.createCommission).mockRejectedValue(
      new TypeError("timeout"),
    );
    await expect(
      createContractSettlementVoucher(request, ports),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
    expect(ports.createCommission).toHaveBeenCalledTimes(1);
  });
  it("keeps a post-create voucher read failure unconfirmed and never retries creation", async () => {
    vi.mocked(ports.readVoucher).mockRejectedValue(new TypeError("timeout"));
    await expect(
      createContractSettlementVoucher(request, ports),
    ).rejects.toMatchObject({ kind: "unconfirmed" });
    expect(ports.createCommission).toHaveBeenCalledTimes(1);
  });
  it("rejects a calendar rollover date before creation", async () => {
    request.draft.voucherDate = "2026-02-31";
    await expect(
      createContractSettlementVoucher(request, ports),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(ports.createCommission).not.toHaveBeenCalled();
  });
});
