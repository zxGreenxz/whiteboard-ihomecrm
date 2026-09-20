export type SettlementKind = "refund" | "commission" | "bonus";

export type SettlementSourceRef =
  | { kind: "broker"; organizationId: string; contractId: string }
  | { kind: "termination_refund"; organizationId: string; terminationId: string; obligationId: string | null; obligationVersion: number | null }
  | { kind: "reservation_refund"; organizationId: string; sourceVoucherId: string; settlementId: string | null; refundVoucherId: string | null }
  | { kind: "sale_contract"; organizationId: string; contractId: string }
  | { kind: "sale_deposit"; organizationId: string; depositVoucherId: string };

export type SettlementBasis = {
  kind: "COMMISSION" | "SALE_BONUS" | "TERMINATION_REFUND" | "RESERVATION_REFUND";
  status: "AVAILABLE" | "MISSING" | "GENERATED" | "RECOGNIZED";
  amount: number | null;
  measuredAt: string | null;
  source: string | null;
  fingerprint: string | null;
  version: number | null;
  warning: string | null;
};

export type Readiness<T> =
  | { state: "loading" }
  | { state: "error"; reason: string }
  | { state: "ready"; value: T };

export type SettlementActionKind = "RESUBMIT_REVIEW" | "REQUEST_CHANGES" | "APPROVE" | "POST" | "REVERSE" | "UNAPPROVE" | "CANCEL" | "EDIT" | "SUPPLEMENT";
export type ActionEligibility = Readiness<{ allowedActions: SettlementActionKind[]; reasonCodes: string[] }>;
export type CreateEligibility = { state: "ready"; allowed: boolean; reasonCodes: string[] } | { state: "unavailable"; reasonCodes: string[] };

export type VoucherSnapshot = {
  id: string;
  code: string;
  organizationId: string;
  buildingId: string;
  roomId: string | null;
  roomName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  tenantId: string | null;
  customerName: string | null;
  totalAmount: number;
  type: "INCOME" | "EXPENSE";
  payerName: string | null;
  receiveBankName: string | null;
  receiveBankAccount: string | null;
  accountId: string | null;
  approvalStatus: "UNAPPROVED" | "APPROVED" | "CANCELLED";
  postingStatus: "UNPOSTED" | "POSTED" | "REVERSED" | "NOT_APPLICABLE";
  postingMode: "CASHBOOK" | "NON_CASH";
  reviewState: "PENDING" | "CHANGES_REQUESTED" | "DISPUTED" | "RESOLVED";
  reviewReason: string | null;
  approvalVersion: number;
  postingVersion: number;
  reviewVersion: number;
  systemSource: string | null;
  activePostingId: string | null;
  effectiveNetPaid: number;
  postedOn: string | null;
  voucherDate: string;
  sourceEventDate: string | null;
  makerUserId: string | null;
  flowOwnership: Readiness<{ owner: string | null; verified: true }>;
  postingEvidence: Readiness<{ activePostingId: string | null; effectiveNetPaid: number; postedOn: string | null }>;
  notes: string | null;
  attachments: string[];
  actionReadiness: ActionEligibility;
};

type SourceLink =
  | { state: "verified"; sourceRef: SettlementSourceRef }
  | { state: "unverified"; reason: string };

export type SettlementSourceRow = {
  rowType: "source";
  rowKey: string;
  settlementKind: SettlementKind;
  sourceRef: SettlementSourceRef;
  organizationId: string;
  buildingId: string;
  roomId: string | null;
  roomName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  customerName: string | null;
  eventDate: string | null;
  recipient: { name: string | null; bankName: string | null; bankAccount: string | null };
  basis: SettlementBasis;
  createEligibility: CreateEligibility;
};

export type SettlementVoucherRow = {
  rowType: "voucher";
  rowKey: string;
  settlementKind: SettlementKind;
  voucherId: string;
  voucherCode: string;
  sourceLink: SourceLink;
  snapshot: { state: "ready"; value: VoucherSnapshot } | { state: "unavailable"; reason: string };
  basis: SettlementBasis;
};

export type SettlementRow = SettlementSourceRow | SettlementVoucherRow;

export type SettlementSelection =
  | { kind: "source"; sourceRef: SettlementSourceRef }
  | { kind: "voucher"; voucherId: string };

export type SettlementDisplayCode =
  | "NOT_CREATED" | "PENDING_APPROVAL" | "NEEDS_REVIEW" | "WAITING_PAYMENT"
  | "PAID" | "NON_CASH" | "REVERSED" | "CANCELLED" | "NEEDS_RECONCILIATION" | "UNAVAILABLE";

export type SettlementIssue = "MISSING_BANK" | "AMOUNT_MISMATCH" | "OLD_PERIOD" | "CHANGES_REQUESTED" | "POSTING_EVIDENCE_MISMATCH";
export type SettlementRowAction =
  | { kind: "CREATE_VOUCHER"; sourceRef: SettlementSourceRef; label: "Lập phiếu chờ duyệt" }
  | { kind: "RESUBMIT_REVIEW"; voucherId: string; label: "Chuyển chờ duyệt" };

const enumValues = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && values.includes(value as T);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown): string => { if (typeof value !== "string" || value.length === 0) throw new Error("Expected non-empty string"); return value; };
const nullableString = (value: unknown): string | null => { if (value === null) return null; return stringValue(value); };
const versionValue = (value: unknown): number => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid version"); return value as number; };
const nullableVersion = (value: unknown): number | null => value === null ? null : versionValue(value);
const vndValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?(0|[1-9]\d*)(?:\.0+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("Invalid VND amount");
};
const nullableVnd = (value: unknown): number | null => value === null ? null : vndValue(value);

const parseSourceRef = (input: unknown): SettlementSourceRef => {
  if (!isRecord(input)) throw new Error("Invalid source ref");
  const organizationId = stringValue(input.organizationId);
  switch (input.kind) {
    case "broker": return { kind: input.kind, organizationId, contractId: stringValue(input.contractId) };
    case "termination_refund": return { kind: input.kind, organizationId, terminationId: stringValue(input.terminationId), obligationId: nullableString(input.obligationId), obligationVersion: nullableVersion(input.obligationVersion) };
    case "reservation_refund": return { kind: input.kind, organizationId, sourceVoucherId: stringValue(input.sourceVoucherId), settlementId: nullableString(input.settlementId), refundVoucherId: nullableString(input.refundVoucherId) };
    case "sale_contract": return { kind: input.kind, organizationId, contractId: stringValue(input.contractId) };
    case "sale_deposit": return { kind: input.kind, organizationId, depositVoucherId: stringValue(input.depositVoucherId) };
    default: throw new Error("Unknown source kind");
  }
};

const sourceMatchesKind = (settlementKind: SettlementKind, sourceRef: SettlementSourceRef): boolean => {
  if (settlementKind === "commission") return sourceRef.kind === "broker";
  if (settlementKind === "refund") return sourceRef.kind === "termination_refund" || sourceRef.kind === "reservation_refund";
  return sourceRef.kind === "sale_contract" || sourceRef.kind === "sale_deposit";
};

const parseBasis = (input: unknown): SettlementBasis => {
  if (!isRecord(input) || !enumValues(["COMMISSION", "SALE_BONUS", "TERMINATION_REFUND", "RESERVATION_REFUND"] as const, input.kind)
    || !enumValues(["AVAILABLE", "MISSING", "GENERATED", "RECOGNIZED"] as const, input.status)) throw new Error("Invalid basis");
  return { kind: input.kind, status: input.status, amount: nullableVnd(input.amount), measuredAt: nullableString(input.measuredAt), source: nullableString(input.source), fingerprint: nullableString(input.fingerprint), version: nullableVersion(input.version), warning: nullableString(input.warning) };
};

const parseActionReadiness = (input: unknown): ActionEligibility => {
  if (!isRecord(input) || !enumValues(["loading", "error", "ready"] as const, input.state)) throw new Error("Invalid readiness");
  if (input.state === "loading") return { state: "loading" };
  if (input.state === "error") return { state: "error", reason: stringValue(input.reason) };
  if (!isRecord(input.value) || !Array.isArray(input.value.reasonCodes) || !input.value.reasonCodes.every((item) => typeof item === "string")
    || !Array.isArray(input.value.allowedActions) || !input.value.allowedActions.every((item) => enumValues(["RESUBMIT_REVIEW", "REQUEST_CHANGES", "APPROVE", "POST", "REVERSE", "UNAPPROVE", "CANCEL", "EDIT", "SUPPLEMENT"] as const, item))) throw new Error("Invalid action readiness");
  return { state: "ready", value: { allowedActions: [...input.value.allowedActions] as SettlementActionKind[], reasonCodes: [...input.value.reasonCodes] } };
};

const parseFlowOwnership = (input: unknown): VoucherSnapshot["flowOwnership"] => {
  if (!isRecord(input) || !enumValues(["loading", "error", "ready"] as const, input.state)) throw new Error("Invalid ownership readiness");
  if (input.state === "loading") return { state: "loading" };
  if (input.state === "error") return { state: "error", reason: stringValue(input.reason) };
  if (!isRecord(input.value) || input.value.verified !== true) throw new Error("Unverified ownership");
  return { state: "ready", value: { owner: nullableString(input.value.owner), verified: true } };
};

const parsePostingEvidence = (input: unknown): VoucherSnapshot["postingEvidence"] => {
  if (!isRecord(input) || !enumValues(["loading", "error", "ready"] as const, input.state)) throw new Error("Invalid posting evidence readiness");
  if (input.state === "loading") return { state: "loading" };
  if (input.state === "error") return { state: "error", reason: stringValue(input.reason) };
  if (!isRecord(input.value)) throw new Error("Invalid posting evidence");
  return { state: "ready", value: { activePostingId: nullableString(input.value.activePostingId), effectiveNetPaid: vndValue(input.value.effectiveNetPaid), postedOn: nullableString(input.value.postedOn) } };
};

const parseSnapshot = (input: unknown): VoucherSnapshot => {
  if (!isRecord(input)) throw new Error("Invalid voucher snapshot");
  if (!enumValues(["INCOME", "EXPENSE"] as const, input.type)
    || !enumValues(["UNAPPROVED", "APPROVED", "CANCELLED"] as const, input.approvalStatus)
    || !enumValues(["UNPOSTED", "POSTED", "REVERSED", "NOT_APPLICABLE"] as const, input.postingStatus)
    || !enumValues(["CASHBOOK", "NON_CASH"] as const, input.postingMode)
    || !enumValues(["PENDING", "CHANGES_REQUESTED", "DISPUTED", "RESOLVED"] as const, input.reviewState)) throw new Error("Unknown voucher state");
  const attachments = input.attachments;
  if (!Array.isArray(attachments) || !attachments.every((item) => typeof item === "string")) throw new Error("Invalid attachments");
  return {
    id: stringValue(input.id), code: stringValue(input.code), organizationId: stringValue(input.organizationId), buildingId: stringValue(input.buildingId),
    roomId: nullableString(input.roomId), roomName: nullableString(input.roomName), contractId: nullableString(input.contractId), contractNumber: nullableString(input.contractNumber), tenantId: nullableString(input.tenantId), customerName: nullableString(input.customerName), totalAmount: vndValue(input.totalAmount), type: input.type,
    payerName: nullableString(input.payerName), receiveBankName: nullableString(input.receiveBankName), receiveBankAccount: nullableString(input.receiveBankAccount), accountId: nullableString(input.accountId),
    approvalStatus: input.approvalStatus, postingStatus: input.postingStatus, postingMode: input.postingMode, reviewState: input.reviewState, reviewReason: nullableString(input.reviewReason),
    approvalVersion: versionValue(input.approvalVersion), postingVersion: versionValue(input.postingVersion), reviewVersion: versionValue(input.reviewVersion),
    systemSource: nullableString(input.systemSource), activePostingId: nullableString(input.activePostingId), effectiveNetPaid: vndValue(input.effectiveNetPaid), postedOn: nullableString(input.postedOn),
    voucherDate: stringValue(input.voucherDate), sourceEventDate: nullableString(input.sourceEventDate), makerUserId: nullableString(input.makerUserId),
    flowOwnership: parseFlowOwnership(input.flowOwnership), postingEvidence: parsePostingEvidence(input.postingEvidence),
    notes: nullableString(input.notes), attachments: [...attachments], actionReadiness: parseActionReadiness(input.actionReadiness),
  };
};

export function parseSettlementRow(input: unknown): SettlementRow {
  if (!isRecord(input) || !enumValues(["refund", "commission", "bonus"] as const, input.settlementKind)) throw new Error("Invalid settlement row");
  if (input.rowType === "source") {
    if (!isRecord(input.recipient) || !isRecord(input.createEligibility)) throw new Error("Invalid source row");
    const eligibility = input.createEligibility;
    if (eligibility.state !== "ready" && eligibility.state !== "unavailable") throw new Error("Invalid create eligibility");
    if (!Array.isArray(eligibility.reasonCodes) || !eligibility.reasonCodes.every((item) => typeof item === "string")) throw new Error("Invalid create reason codes");
    if (eligibility.state === "ready" && typeof eligibility.allowed !== "boolean") throw new Error("Invalid create eligibility");
    const sourceRef = parseSourceRef(input.sourceRef);
    const organizationId = stringValue(input.organizationId);
    if (sourceRef.organizationId !== organizationId || !sourceMatchesKind(input.settlementKind, sourceRef)) throw new Error("Inconsistent source row");
    return {
      rowType: "source", rowKey: stringValue(input.rowKey), settlementKind: input.settlementKind, sourceRef, organizationId,
      buildingId: stringValue(input.buildingId), roomId: nullableString(input.roomId), roomName: nullableString(input.roomName), contractId: nullableString(input.contractId), contractNumber: nullableString(input.contractNumber), customerName: nullableString(input.customerName), eventDate: nullableString(input.eventDate),
      recipient: { name: nullableString(input.recipient.name), bankName: nullableString(input.recipient.bankName), bankAccount: nullableString(input.recipient.bankAccount) },
      basis: parseBasis(input.basis), createEligibility: eligibility.state === "ready" ? { state: "ready", allowed: eligibility.allowed as boolean, reasonCodes: [...eligibility.reasonCodes] } : { state: "unavailable", reasonCodes: [...eligibility.reasonCodes] },
    };
  }
  if (input.rowType !== "voucher" || !isRecord(input.sourceLink) || !isRecord(input.snapshot)) throw new Error("Invalid voucher row");
  const voucherId = stringValue(input.voucherId);
  const voucherCode = stringValue(input.voucherCode);
  let sourceLink: SourceLink = input.sourceLink.state === "verified"
    ? { state: "verified", sourceRef: parseSourceRef(input.sourceLink.sourceRef) }
    : input.sourceLink.state === "unverified" ? { state: "unverified", reason: stringValue(input.sourceLink.reason) } : (() => { throw new Error("Invalid source link"); })();
  let snapshot: SettlementVoucherRow["snapshot"];
  if (input.snapshot.state === "unavailable") snapshot = { state: "unavailable", reason: stringValue(input.snapshot.reason) };
  else if (input.snapshot.state === "ready") {
    try {
      const value = parseSnapshot(input.snapshot.value);
      const sourceOrganizationId = sourceLink.state === "verified" ? sourceLink.sourceRef.organizationId : value.organizationId;
      snapshot = value.id === voucherId && value.code === voucherCode && value.organizationId === sourceOrganizationId
        ? { state: "ready", value } : { state: "unavailable", reason: "INVALID_VOUCHER_SNAPSHOT" };
    } catch { snapshot = { state: "unavailable", reason: "INVALID_VOUCHER_SNAPSHOT" }; }
  } else throw new Error("Invalid snapshot readiness");
  if (sourceLink.state === "verified" && !sourceMatchesKind(input.settlementKind, sourceLink.sourceRef)) sourceLink = { state: "unverified", reason: "INCONSISTENT_SOURCE_LINK" };
  return { rowType: "voucher", rowKey: stringValue(input.rowKey), settlementKind: input.settlementKind, voucherId, voucherCode, sourceLink, snapshot, basis: parseBasis(input.basis) };
}

export function getSettlementDisplayState(row: SettlementRow): { code: SettlementDisplayCode; label: string } {
  if (row.rowType === "source") return { code: "NOT_CREATED", label: "Chưa lập phiếu" };
  if (row.snapshot.state === "unavailable") return { code: "UNAVAILABLE", label: "Chưa đọc được" };
  const value = row.snapshot.value;
  if (value.approvalStatus === "CANCELLED") return { code: "CANCELLED", label: "Đã huỷ" };
  if (value.approvalStatus === "UNAPPROVED") {
    if (value.postingStatus !== "UNPOSTED" || value.activePostingId !== null) return { code: "NEEDS_RECONCILIATION", label: "Cần đối chiếu" };
    if (value.reviewState === "CHANGES_REQUESTED") return { code: "NEEDS_REVIEW", label: "Cần rà soát" };
    if (value.reviewState === "PENDING") return { code: "PENDING_APPROVAL", label: "Chờ duyệt" };
    return { code: "NEEDS_RECONCILIATION", label: "Cần đối chiếu" };
  }
  if (value.reviewState === "CHANGES_REQUESTED" || value.reviewState === "DISPUTED") return { code: "NEEDS_RECONCILIATION", label: "Cần đối chiếu" };
  if (value.postingStatus === "REVERSED") return { code: "REVERSED", label: "Đã hoàn tác" };
  if (value.postingMode === "NON_CASH" && value.postingStatus === "NOT_APPLICABLE") return { code: "NON_CASH", label: "Không ghi quỹ" };
  if (value.postingMode === "CASHBOOK" && value.postingStatus === "UNPOSTED" && value.activePostingId === null) return { code: "WAITING_PAYMENT", label: "Chờ chi" };
  if (value.postingMode === "CASHBOOK" && value.postingStatus === "POSTED" && value.activePostingId !== null
    && value.postingEvidence.state === "ready"
    && value.postingEvidence.value.activePostingId === value.activePostingId
    && value.postingEvidence.value.effectiveNetPaid === value.effectiveNetPaid
    && value.postingEvidence.value.postedOn === value.postedOn
    && value.postedOn !== null) return { code: "PAID", label: "Đã chi" };
  return { code: "NEEDS_RECONCILIATION", label: "Cần đối chiếu" };
}

export function getSettlementReviewBadge(row: SettlementRow): { code: VoucherSnapshot["reviewState"]; label: string } | null {
  if (row.rowType !== "voucher" || row.snapshot.state !== "ready") return null;
  const state = row.snapshot.value.reviewState;
  const labels: Record<VoucherSnapshot["reviewState"], string> = {
    PENDING: "Chờ duyệt",
    CHANGES_REQUESTED: "Cần rà soát",
    DISPUTED: "Đang tranh chấp",
    RESOLVED: "Đã giải quyết",
  };
  return { code: state, label: labels[state] };
}

export function getSettlementRowActions(row: SettlementRow): SettlementRowAction[] {
  if (row.rowType === "source") {
    return row.createEligibility.state === "ready" && row.createEligibility.allowed
      ? [{ kind: "CREATE_VOUCHER", sourceRef: row.sourceRef, label: "Lập phiếu chờ duyệt" }]
      : [];
  }
  if (row.snapshot.state !== "ready") return [];
  const voucher = row.snapshot.value;
  const eligibility = voucher.actionReadiness;
  if (eligibility.state !== "ready") return [];
  return voucher.approvalStatus === "UNAPPROVED" && voucher.reviewState === "CHANGES_REQUESTED"
    && eligibility.value.allowedActions.includes("RESUBMIT_REVIEW")
    ? [{ kind: "RESUBMIT_REVIEW", voucherId: row.voucherId, label: "Chuyển chờ duyệt" }]
    : [];
}

export function detectSettlementIssues(row: SettlementRow, period: string): SettlementIssue[] {
  const issues: SettlementIssue[] = [];
  const voucher = row.rowType === "voucher" && row.snapshot.state === "ready" ? row.snapshot.value : null;
  const amount = voucher?.totalAmount ?? row.basis.amount;
  if (voucher && row.basis.amount !== null && amount !== row.basis.amount) issues.push("AMOUNT_MISMATCH");
  if (voucher?.reviewState === "CHANGES_REQUESTED") issues.push("CHANGES_REQUESTED");
  const state = getSettlementDisplayState(row).code;
  if (state !== "PAID" && state !== "CANCELLED" && (voucher?.receiveBankAccount ?? (row.rowType === "source" ? row.recipient.bankAccount : null)) === null) issues.push("MISSING_BANK");
  const eventDate = row.rowType === "source" ? row.eventDate : voucher?.sourceEventDate ?? voucher?.voucherDate ?? null;
  if (state !== "PAID" && state !== "CANCELLED" && eventDate !== null && eventDate.slice(0, 7) < period) issues.push("OLD_PERIOD");
  if (state === "NEEDS_RECONCILIATION" && voucher?.postingStatus === "POSTED") issues.push("POSTING_EVIDENCE_MISMATCH");
  return issues;
}

export type SettlementTotals = {
  sourceCount: number; sourceAmount: number | null; unknownBasisCount: number; pendingAmount: number; approvedUnpostedAmount: number;
  effectiveNetPaid: number; nonCashAmount: number; reversedAmount: number; cancelledAmount: number; displayedVoucherAmount: number;
};

export function calculateSettlementTotals(rows: readonly SettlementRow[]): SettlementTotals {
  const totals: SettlementTotals = { sourceCount: 0, sourceAmount: 0, unknownBasisCount: 0, pendingAmount: 0, approvedUnpostedAmount: 0, effectiveNetPaid: 0, nonCashAmount: 0, reversedAmount: 0, cancelledAmount: 0, displayedVoucherAmount: 0 };
  for (const row of rows) {
    if (row.rowType === "source") {
      totals.sourceCount += 1;
      if (row.basis.amount === null) totals.unknownBasisCount += 1;
      else totals.sourceAmount = (totals.sourceAmount ?? 0) + row.basis.amount;
      continue;
    }
    if (row.snapshot.state !== "ready") continue;
    const amount = row.snapshot.value.totalAmount;
    totals.displayedVoucherAmount += amount;
    switch (getSettlementDisplayState(row).code) {
      case "PENDING_APPROVAL": case "NEEDS_REVIEW": totals.pendingAmount += amount; break;
      case "WAITING_PAYMENT": totals.approvedUnpostedAmount += amount; break;
      case "PAID": totals.effectiveNetPaid += row.snapshot.value.effectiveNetPaid; break;
      case "NON_CASH": totals.nonCashAmount += amount; break;
      case "REVERSED": totals.reversedAmount += amount; break;
      case "CANCELLED": totals.cancelledAmount += amount; break;
    }
  }
  if (totals.sourceCount > 0 && totals.unknownBasisCount === totals.sourceCount) totals.sourceAmount = null;
  return totals;
}

export type SettlementFilters = { period: string; buildingId?: string; kinds?: SettlementKind[]; states?: SettlementDisplayCode[]; issues?: SettlementIssue[]; search?: string };

export function filterSettlementRows(rows: readonly SettlementRow[], filters: SettlementFilters): SettlementRow[] {
  const query = filters.search?.trim().toLocaleLowerCase("vi") ?? "";
  return rows.filter((row) => {
    const buildingId = row.rowType === "source" ? row.buildingId : row.snapshot.state === "ready" ? row.snapshot.value.buildingId : null;
    if (filters.buildingId && buildingId !== filters.buildingId) return false;
    if (filters.kinds?.length && !filters.kinds.includes(row.settlementKind)) return false;
    if (filters.states?.length && !filters.states.includes(getSettlementDisplayState(row).code)) return false;
    if (filters.issues?.length && !filters.issues.every((issue) => detectSettlementIssues(row, filters.period).includes(issue))) return false;
    if (query) {
      const identity = row.rowType === "source"
        ? `${row.rowKey} ${row.contractId ?? ""} ${row.contractNumber ?? ""} ${row.roomId ?? ""} ${row.roomName ?? ""} ${row.customerName ?? ""} ${row.recipient.name ?? ""}`
        : row.snapshot.state === "ready"
          ? `${row.rowKey} ${row.voucherId} ${row.voucherCode} ${row.snapshot.value.contractId ?? ""} ${row.snapshot.value.contractNumber ?? ""} ${row.snapshot.value.roomId ?? ""} ${row.snapshot.value.roomName ?? ""} ${row.snapshot.value.customerName ?? ""} ${row.snapshot.value.payerName ?? ""}`
          : `${row.rowKey} ${row.voucherId} ${row.voucherCode}`;
      if (!identity.toLocaleLowerCase("vi").includes(query)) return false;
    }
    return true;
  });
}
