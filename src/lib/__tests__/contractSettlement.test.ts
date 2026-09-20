import { describe, expect, it } from "vitest";

import {
  calculateSettlementTotals,
  detectSettlementIssues,
  filterSettlementRows,
  getSettlementDisplayState,
  getSettlementReviewBadge,
  getSettlementRowActions,
  parseSettlementRow,
  type SettlementRow,
} from "../contractSettlement";

const source = {
  kind: "broker" as const,
  organizationId: "org-1",
  contractId: "contract-1",
};

const basis = {
  kind: "COMMISSION" as const,
  status: "AVAILABLE" as const,
  amount: 2_500_000,
  measuredAt: "2026-09-20T00:00:00Z",
  source: "commission_tier",
  fingerprint: "basis-v1",
  version: 3,
  warning: null,
};

const sourceRow: SettlementRow = {
  rowType: "source",
  rowKey: "broker:contract-1",
  settlementKind: "commission",
  sourceRef: source,
  organizationId: "org-1",
  buildingId: "building-1",
  roomId: "room-1",
  contractId: "contract-1",
  eventDate: "2026-09-01",
  recipient: { name: "Môi giới A", bankName: null, bankAccount: null },
  basis,
  createEligibility: { state: "ready", allowed: true, reasonCodes: [] },
};

const rawVoucher = (overrides: Record<string, unknown> = {}) => ({
  rowType: "voucher",
  rowKey: "voucher:voucher-1",
  settlementKind: "commission",
  voucherId: "voucher-1",
  voucherCode: "PC-001",
  sourceLink: { state: "verified", sourceRef: source },
  snapshot: {
    state: "ready",
    value: {
      id: "voucher-1",
      code: "PC-001",
      organizationId: "org-1",
      buildingId: "building-1",
      roomId: "room-1",
      contractId: "contract-1",
      tenantId: null,
      totalAmount: "2500000",
      type: "EXPENSE",
      payerName: "Môi giới A",
      receiveBankName: null,
      receiveBankAccount: null,
      accountId: null,
      approvalStatus: "UNAPPROVED",
      postingStatus: "UNPOSTED",
      postingMode: "CASHBOOK",
      reviewState: "PENDING",
      reviewReason: null,
      approvalVersion: 2,
      postingVersion: 4,
      reviewVersion: 6,
      systemSource: "contract.broker_commission",
      activePostingId: null,
      effectiveNetPaid: "0",
      postedOn: null,
      voucherDate: "2026-09-02",
      sourceEventDate: "2026-09-01",
      makerUserId: "maker-1",
      flowOwnership: { state: "ready", value: { owner: "contract-settlement", verified: true } },
      postingEvidence: { state: "ready", value: { activePostingId: null, effectiveNetPaid: "0", postedOn: null } },
      notes: null,
      attachments: [],
      actionReadiness: { state: "ready", value: { allowedActions: ["RESUBMIT_REVIEW"], reasonCodes: [] } },
      ...overrides,
    },
  },
  basis,
});

describe("parseSettlementRow", () => {
  it("keeps a source-only row and its create action distinct from voucher identity", () => {
    const row = parseSettlementRow(sourceRow);
    expect(row).toEqual(sourceRow);
    expect(getSettlementDisplayState(row)).toEqual({ code: "NOT_CREATED", label: "Chưa lập phiếu" });
    expect(row.rowType === "source" && row.createEligibility.state === "ready" && row.createEligibility.allowed).toBe(true);
  });

  it("parses voucher-only and mixed rows without treating contractId as voucherId", () => {
    const voucherOnly = parseSettlementRow({
      ...rawVoucher(),
      sourceLink: { state: "unverified", reason: "LEGACY_WITHOUT_SOURCE_LINK" },
    });
    const mixed = parseSettlementRow(rawVoucher());

    expect(voucherOnly.rowType).toBe("voucher");
    expect(voucherOnly.rowType === "voucher" && voucherOnly.voucherId).toBe("voucher-1");
    expect(mixed.rowType === "voucher" && mixed.sourceLink.state).toBe("verified");
    expect(mixed.rowType === "voucher" && mixed.voucherId).not.toBe("contract-1");
  });

  it("retains known voucher identity when detail is unavailable", () => {
    const row = parseSettlementRow({
      ...rawVoucher(),
      snapshot: { state: "unavailable", reason: "DETAIL_DENIED" },
    });
    expect(row).toMatchObject({ rowType: "voucher", voucherId: "voucher-1", voucherCode: "PC-001" });
    expect(getSettlementDisplayState(row)).toEqual({ code: "UNAVAILABLE", label: "Chưa đọc được" });
  });

  it.each([
    ["unknown approval state", { approvalStatus: "DRAFT" }],
    ["unknown review state", { reviewState: "REVIEWING" }],
    ["unknown posting mode", { postingMode: "LEDGER" }],
    ["unknown posting state", { postingStatus: "SETTLED" }],
    ["missing version", { reviewVersion: null }],
    ["unsafe VND", { totalAmount: "9007199254740992" }],
    ["fractional VND", { totalAmount: "12.5" }],
  ])("fails closed on %s while preserving voucher identity", (_name, invalid) => {
    const row = parseSettlementRow(rawVoucher(invalid));
    expect(row).toMatchObject({
      rowType: "voucher",
      voucherId: "voucher-1",
      snapshot: { state: "unavailable", reason: "INVALID_VOUCHER_SNAPSHOT" },
    });
  });
});

describe("display state, review badge and issues", () => {
  it("separates CHANGES_REQUESTED from approval/posting display state", () => {
    const changes = parseSettlementRow(rawVoucher({ reviewState: "CHANGES_REQUESTED" }));
    const pending = parseSettlementRow(rawVoucher({ reviewState: "PENDING" }));
    expect(getSettlementDisplayState(changes)).toEqual({ code: "NEEDS_REVIEW", label: "Cần rà soát" });
    expect(getSettlementDisplayState(pending)).toEqual({ code: "PENDING_APPROVAL", label: "Chờ duyệt" });
    expect(getSettlementReviewBadge(changes)).toEqual({ code: "CHANGES_REQUESTED", label: "Cần rà soát" });
    expect(getSettlementReviewBadge(pending)).toEqual({ code: "PENDING", label: "Chờ duyệt" });
  });

  it("offers resubmit only for the existing CHANGES_REQUESTED voucher", () => {
    const changes = parseSettlementRow(rawVoucher({ reviewState: "CHANGES_REQUESTED" }));
    const actions = getSettlementRowActions(changes);
    expect(actions).toEqual([{ kind: "RESUBMIT_REVIEW", voucherId: "voucher-1", label: "Chuyển chờ duyệt" }]);
    expect(actions.map((action) => action.kind)).not.toEqual(expect.arrayContaining(["CREATE_VOUCHER", "APPROVE", "POST"]));
    expect(changes.rowType === "voucher" && changes.snapshot.state === "ready" && changes.snapshot.value).toMatchObject({
      id: "voucher-1",
      code: "PC-001",
      totalAmount: 2_500_000,
      systemSource: "contract.broker_commission",
    });
  });

  it("offers a separate create action only for an eligible source", () => {
    expect(getSettlementRowActions(sourceRow)).toEqual([{ kind: "CREATE_VOUCHER", sourceRef: source, label: "Lập phiếu chờ duyệt" }]);
  });

  it("does not infer resubmit permission merely from loaded action facts", () => {
    const row = parseSettlementRow(rawVoucher({
      reviewState: "CHANGES_REQUESTED",
      actionReadiness: { state: "ready", value: { allowedActions: [], reasonCodes: ["MAKER_ONLY"] } },
    }));
    expect(getSettlementRowActions(row)).toEqual([]);
  });

  it("keeps basis mismatch after resubmission and never changes voucher amount", () => {
    const row = parseSettlementRow({
      ...rawVoucher({ reviewState: "PENDING", totalAmount: "2400000" }),
      basis,
    });
    expect(detectSettlementIssues(row, "2026-09")).toContain("AMOUNT_MISMATCH");
    expect(row.rowType === "voucher" && row.snapshot.state === "ready" && row.snapshot.value.totalAmount).toBe(2_400_000);
  });

  it("does not call an absent basis a mismatch", () => {
    const row = parseSettlementRow({
      ...rawVoucher(),
      basis: { ...basis, status: "MISSING", amount: null, warning: "MISSING_RENT" },
    });
    expect(detectSettlementIssues(row, "2026-09")).not.toContain("AMOUNT_MISMATCH");
  });
});

describe("display and totals use posting evidence", () => {
  it.each([
    ["approved unposted", { approvalStatus: "APPROVED", postingStatus: "UNPOSTED" }, "WAITING_PAYMENT"],
    ["non-cash", { approvalStatus: "APPROVED", postingMode: "NON_CASH", postingStatus: "NOT_APPLICABLE" }, "NON_CASH"],
    ["reversed", { approvalStatus: "APPROVED", postingStatus: "REVERSED" }, "REVERSED"],
    ["cancelled", { approvalStatus: "CANCELLED" }, "CANCELLED"],
  ])("classifies %s independently", (_name, state, expected) => {
    expect(getSettlementDisplayState(parseSettlementRow(rawVoucher(state))).code).toBe(expected);
  });

  it("does not count POSTED without matching active posting as paid", () => {
    const row = parseSettlementRow(rawVoucher({
      approvalStatus: "APPROVED",
      postingStatus: "POSTED",
      activePostingId: null,
      effectiveNetPaid: "2500000",
    }));
    expect(getSettlementDisplayState(row).code).toBe("NEEDS_RECONCILIATION");
    expect(calculateSettlementTotals([row]).effectiveNetPaid).toBe(0);
  });

  it("requires verified posting evidence matching the active posting before showing paid", () => {
    const row = parseSettlementRow(rawVoucher({
      approvalStatus: "APPROVED",
      postingStatus: "POSTED",
      activePostingId: "posting-1",
      effectiveNetPaid: "2500000",
      postedOn: "2026-09-03",
      postingEvidence: { state: "ready", value: { activePostingId: "posting-other", effectiveNetPaid: "2500000", postedOn: "2026-09-03" } },
    }));
    expect(getSettlementDisplayState(row).code).toBe("NEEDS_RECONCILIATION");
  });

  it("treats UNAPPROVED carrying posting state as inconsistent", () => {
    const row = parseSettlementRow(rawVoucher({
      postingStatus: "POSTED",
      activePostingId: "posting-1",
      effectiveNetPaid: "2500000",
      postedOn: "2026-09-03",
      postingEvidence: { state: "ready", value: { activePostingId: "posting-1", effectiveNetPaid: "2500000", postedOn: "2026-09-03" } },
    }));
    expect(getSettlementDisplayState(row).code).toBe("NEEDS_RECONCILIATION");
  });

  it("uses source/voucher business date for old-period issue instead of posting date", () => {
    const row = parseSettlementRow(rawVoucher({
      approvalStatus: "APPROVED",
      voucherDate: "2026-08-31",
      sourceEventDate: null,
      postedOn: null,
    }));
    expect(detectSettlementIssues(row, "2026-09")).toContain("OLD_PERIOD");
  });

  it("keeps GENERATED refund negative and separates every money group", () => {
    const generatedRefund = parseSettlementRow({
      ...sourceRow,
      rowKey: "termination:term-1",
      settlementKind: "refund",
      sourceRef: { kind: "termination_refund", organizationId: "org-1", terminationId: "term-1", obligationId: null, obligationVersion: null },
      basis: { ...basis, kind: "TERMINATION_REFUND", status: "GENERATED", amount: -1_000_000 },
    });
    const pending = parseSettlementRow(rawVoucher({ totalAmount: "2400000" }));
    const waiting = parseSettlementRow(rawVoucher({ approvalStatus: "APPROVED", totalAmount: "2300000" }));
    const paid = parseSettlementRow(rawVoucher({ approvalStatus: "APPROVED", postingStatus: "POSTED", activePostingId: "posting-1", effectiveNetPaid: "2200000", postedOn: "2026-09-03", totalAmount: "2200000", postingEvidence: { state: "ready", value: { activePostingId: "posting-1", effectiveNetPaid: "2200000", postedOn: "2026-09-03" } } }));
    const nonCash = parseSettlementRow(rawVoucher({ approvalStatus: "APPROVED", postingMode: "NON_CASH", postingStatus: "NOT_APPLICABLE", totalAmount: "2100000" }));
    const reversed = parseSettlementRow(rawVoucher({ approvalStatus: "APPROVED", postingStatus: "REVERSED", effectiveNetPaid: "2000000", totalAmount: "2000000" }));
    const cancelled = parseSettlementRow(rawVoucher({ approvalStatus: "CANCELLED", totalAmount: "1900000" }));

    expect(calculateSettlementTotals([generatedRefund, pending, waiting, paid, nonCash, reversed, cancelled])).toEqual({
      sourceCount: 1,
      sourceAmount: -1_000_000,
      unknownBasisCount: 0,
      pendingAmount: 2_400_000,
      approvedUnpostedAmount: 2_300_000,
      effectiveNetPaid: 2_200_000,
      nonCashAmount: 2_100_000,
      reversedAmount: 2_000_000,
      cancelledAmount: 1_900_000,
      displayedVoucherAmount: 12_900_000,
    });
  });
});

describe("filterSettlementRows", () => {
  it("combines filters with AND and grouped pending states with OR", () => {
    const rows = [
      parseSettlementRow(rawVoucher()),
      parseSettlementRow(rawVoucher({ approvalStatus: "APPROVED" })),
      { ...sourceRow, buildingId: "building-2" },
    ];
    expect(filterSettlementRows(rows, { buildingId: "building-1", states: ["PENDING_APPROVAL", "WAITING_PAYMENT"] })).toHaveLength(2);
  });
});
