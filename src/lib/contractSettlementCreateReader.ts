import type {
  CreatableSettlementSourceRef,
  SettlementCreateSource,
  SettlementRefundObligation,
  SettlementRefundPreview,
} from "./contractSettlementCreate";
import {
  settlementCreateSourceId,
  SettlementCreateError,
} from "./contractSettlementCreate";
const fail = (): never => {
  throw new SettlementCreateError(
    "blocked",
    "Chưa đọc được đầy đủ nguồn và căn cứ lập phiếu.",
  );
};
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown): string => (typeof v === "string" ? v : fail());
const nullableText = (v: unknown): string | null =>
  v === null ? null : text(v);
const id = (v: unknown): string => {
  const s = text(v);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    s,
  )
    ? s
    : fail();
};
const nullableId = (v: unknown): string | null => (v === null ? null : id(v));
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const num = (v: unknown): number => {
  if (
    typeof v !== "number" &&
    !(typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))
  )
    return fail();
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER
    ? n
    : fail();
};
const money = (v: unknown): number => {
  const n = num(v);
  return Number.isSafeInteger(n) ? n : fail();
};
const nullableMoney = (v: unknown): number | null =>
  v === null ? null : money(v);
const date = (v: unknown): string => {
  const s = text(v),
    day = new Date(s + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(day.valueOf()) &&
    day.toISOString().slice(0, 10) === s
    ? s
    : fail();
};
const status = (v: unknown): SettlementRefundPreview["obligationStatus"] =>
  v === "OK" || v === "VUOT_COC_THAT" || v === "CHUA_TUNG_VAO_KET" ? v : fail();
export function parseSettlementRefundPreview(
  input: unknown,
): SettlementRefundPreview {
  const x = obj(input);
  return {
    terminationId: id(x.terminationId),
    contractId: id(x.contractId),
    organizationId: id(x.organizationId),
    requestedAmount: money(x.requestedAmount),
    realHeld: money(x.realHeld),
    recognizedOnly: money(x.recognizedOnly),
    basisStatus: text(x.basisStatus),
    basisFingerprint: text(x.basisFingerprint),
    obligationStatus: status(x.obligationStatus),
    warning: nullableText(x.warning),
  };
}
/** Database row names are deliberately mapped at one boundary, not treated as preview JSON. */
export function parseSettlementRefundObligation(
  input: unknown,
): SettlementRefundObligation {
  const x = obj(input),
    version = money(x.version);
  if (version < 1) return fail();
  return {
    id: id(x.id),
    organizationId: id(x.organization_id),
    terminationId: id(x.termination_id),
    contractId: id(x.contract_id),
    version,
    requestedAmount: money(x.requested_amount),
    realHeld: money(x.real_held),
    recognizedOnly: money(x.recognized_only),
    basisFingerprint: text(x.basis_fingerprint),
    obligationStatus: status(x.obligation_status),
  };
}
export function parseSettlementCreateSource(
  input: unknown,
  ref: CreatableSettlementSourceRef,
  actorId: string,
): SettlementCreateSource {
  const x = obj(input),
    b = obj(x.basis);
  if (
    x.actorId !== actorId ||
    x.organizationId !== ref.organizationId ||
    x.kind !== ref.kind ||
    x.sourceId !== settlementCreateSourceId(ref)
  )
    return fail();
  const kind = ref.kind,
    basisKind = b.kind;
  if (basisKind!==(kind==='broker'?'commission':kind==='termination_refund'?'refund':'bonus'))
    return fail();
  const result: SettlementCreateSource = {
    actorId: id(x.actorId),
    organizationId: id(x.organizationId),
    kind,
    sourceId: id(x.sourceId),
    revision: text(x.revision),
    canCreate: bool(x.canCreate),
    blockedReason: nullableText(x.blockedReason),
    canForce: bool(x.canForce),
    existingVoucherId: nullableId(x.existingVoucherId),
    hiddenExisting: bool(x.hiddenExisting),
    contractId: nullableId(x.contractId),
    buildingId: id(x.buildingId),
    roomId: nullableId(x.roomId),
    sourceCode: nullableText(x.sourceCode),
    sourceStatus: text(x.sourceStatus),
    sourceDate: x.sourceDate === null ? null : date(x.sourceDate),
    today: date(x.today),
    name: text(x.name),
    recipientName: nullableText(x.recipientName),
    recipientBank: nullableText(x.recipientBank),
    recipientAccount: nullableText(x.recipientAccount),
    suggestedAmount: nullableMoney(x.suggestedAmount),
    capAmount: nullableMoney(x.capAmount),
    basis: {
      kind: basisKind as SettlementCreateSource["basis"]["kind"],
      months: b.months === null ? null : money(b.months),
      ratePercent: b.ratePercent === null ? null : num(b.ratePercent),
      expectedAmount: nullableMoney(b.expectedAmount),
      warning: nullableText(b.warning),
    },
    refund: x.refund === null ? null : parseSettlementRefundPreview(x.refund),
    latestObligation:
      x.latestObligation === null
        ? null
        : parseSettlementRefundObligation(x.latestObligation),
  };
  if (
    !result.revision ||
    ((kind==='broker'||kind==='sale_contract')&&result.contractId!==result.sourceId) ||
    (kind!=='termination_refund'&&(result.refund!==null||result.latestObligation!==null)) ||
    (result.latestObligation!==null&&(result.latestObligation.organizationId!==result.organizationId||result.latestObligation.terminationId!==result.sourceId||result.latestObligation.contractId!==result.contractId)) ||
    (result.hiddenExisting && result.existingVoucherId !== null) ||
    (kind === "termination_refund" &&
      (!result.refund ||
        result.refund.terminationId !== result.sourceId ||
        result.refund.organizationId !== result.organizationId ||
        result.refund.contractId !== result.contractId))
  )
    return fail();
  return result;
}
export interface SettlementSaleProposal {
  sourceRef: Extract<
    CreatableSettlementSourceRef,
    { kind: "sale_contract" | "sale_deposit" }
  >;
  code: string | null;
  name: string;
  sourceDate: string;
  buildingId: string;
  roomId: string | null;
}
export function parseSettlementSaleProposals(
  input: unknown,
  organizationId: string,
  kind: "sale_contract" | "sale_deposit",
): SettlementSaleProposal[] {
  if (!Array.isArray(input)) return fail();
  const seen = new Set<string>();
  return input.map((raw) => {
    const x = obj(raw),
      sourceId = id(x.id);
    if (x.organization_id !== organizationId || seen.has(sourceId))
      return fail();
    seen.add(sourceId);
    const room = kind === "sale_contract" ? obj(x.room) : null,
      buildingId = id(room?.building_id ?? x.building_id);
    return {
      sourceRef:
        kind === "sale_contract"
          ? { kind, organizationId, contractId: sourceId }
          : { kind, organizationId, depositVoucherId: sourceId },
      code: nullableText(kind === "sale_contract" ? x.contract_number : x.code),
      name: text(kind === "sale_contract" ? room?.name : x.name),
      sourceDate: date(
        kind === "sale_contract" ? x.signed_date : x.voucher_date,
      ),
      buildingId,
      roomId: nullableId(x.room_id),
    };
  });
}
