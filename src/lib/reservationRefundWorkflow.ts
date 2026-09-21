import { z } from "zod";
import type { SettlementSourceRef } from "./contractSettlement";
import type { IncomeExpenseActionSnapshot } from "./incomeExpenseActionSnapshot";
import {
  SettlementCreateError,
  type SettlementCreateResult,
} from "./contractSettlementCreate";

export type ReservationRefundSourceRef = Extract<
  SettlementSourceRef,
  { kind: "reservation_refund" }
>;
export interface ReservationRefundSource {
  organizationId: string;
  actorId: string;
  sourceVoucherId: string;
  settlementId: string;
  sourceCode: string | null;
  payerName: string | null;
  sourceDate: string;
  settlementDate: string;
  today: string;
  basisFingerprint: string;
  basisValid: boolean;
  depositAmount: number;
  retainedAmount: number;
  refundAmount: number;
  paid: number;
  remaining: number;
  canCreate: boolean;
  existingVoucherId: string | null;
  hiddenExisting: boolean;
  blockedReason: string | null;
  revision: string;
}
const invalid = (): never => {
  throw new SettlementCreateError(
    "blocked",
    "Chưa đọc được đầy đủ nguồn và căn cứ hoàn cọc.",
  );
};
const obj = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : invalid();
const text = (x: unknown): string => (typeof x === "string" ? x : invalid());
const nullableText = (x: unknown): string | null =>
  x === null ? null : text(x);
const id = (x: unknown): string => {
  const s = text(x);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
    s,
  )
    ? s
    : invalid();
};
const bool = (x: unknown): boolean => (typeof x === "boolean" ? x : invalid());
const money = (x: unknown): number => {
  if (
    typeof x !== "number" &&
    !(typeof x === "string" && /^\d+(?:\.0+)?$/.test(x))
  )
    return invalid();
  const n = Number(x);
  return Number.isSafeInteger(n) && n >= 0 ? n : invalid();
};
const date = (x: unknown): string => {
  const s = text(x),
    day = new Date(s + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(day.valueOf()) &&
    day.toISOString().slice(0, 10) === s
    ? s
    : invalid();
};
export function parseReservationRefundSource(
  input: unknown,
  ref: ReservationRefundSourceRef,
  actorId: string,
): ReservationRefundSource {
  const x = obj(input);
  const value: ReservationRefundSource = {
    organizationId: id(x.organizationId),
    actorId: id(x.actorId),
    sourceVoucherId: id(x.sourceVoucherId),
    settlementId: id(x.settlementId),
    sourceCode: nullableText(x.sourceCode),
    payerName: nullableText(x.payerName),
    sourceDate: date(x.sourceDate),
    settlementDate: date(x.settlementDate),
    today: date(x.today),
    basisFingerprint: text(x.basisFingerprint),
    basisValid: bool(x.basisValid),
    depositAmount: money(x.depositAmount),
    retainedAmount: money(x.retainedAmount),
    refundAmount: money(x.refundAmount),
    paid: money(x.paid),
    remaining: money(x.remaining),
    canCreate: bool(x.canCreate),
    existingVoucherId:
      x.existingVoucherId === null ? null : id(x.existingVoucherId),
    hiddenExisting: bool(x.hiddenExisting),
    blockedReason: nullableText(x.blockedReason),
    revision: text(x.revision),
  };
  if (
    value.organizationId !== ref.organizationId ||
    value.actorId !== actorId ||
    value.sourceVoucherId !== ref.sourceVoucherId ||
    (ref.settlementId !== null && value.settlementId !== ref.settlementId) ||
    value.depositAmount !== value.retainedAmount + value.refundAmount ||
    value.refundAmount !== value.paid + value.remaining ||
    !value.basisFingerprint ||
    !value.revision ||
    (value.hiddenExisting && value.existingVoucherId !== null) ||
    (value.canCreate &&
      (!value.basisValid ||
        value.hiddenExisting ||
        value.existingVoucherId !== null ||
        value.remaining <= 0))
  )
    return invalid();
  return value;
}
export const reservationRefundDraftSchema = z
  .object({
    recipientName: z.string().trim().min(1, "Nhập tên người nhận").max(500),
    bank: z.string().trim().max(200),
    accountNumber: z.string().trim().max(200),
  })
  .superRefine((x, ctx) => {
    if (Boolean(x.bank) !== Boolean(x.accountNumber))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [x.bank ? "accountNumber" : "bank"],
        message:
          "Nhập đủ ngân hàng và số tài khoản, hoặc để trống cả hai khi nhận tiền mặt",
      });
  });
export type ReservationRefundDraft = z.infer<
  typeof reservationRefundDraftSchema
>;
export interface CreateReservationRefundInput {
  organizationId: string;
  sourceVoucherId: string;
  settlementId: string;
  basisFingerprint: string;
  expectedRemaining: number;
  idempotencyKey: string;
  recipientName: string;
  bank: string;
  accountNumber: string;
}
export interface ReservationRefundPorts {
  readSource: (
    ref: ReservationRefundSourceRef,
  ) => Promise<ReservationRefundSource>;
  readVoucher: (id: string) => Promise<IncomeExpenseActionSnapshot>;
  createPending: (input: CreateReservationRefundInput) => Promise<unknown>;
}
const unknownResult = (): never => {
  throw new SettlementCreateError(
    "unconfirmed",
    "Chưa xác nhận được phiếu hoàn. Tải lại để đối chiếu yêu cầu trước khi thao tác tiếp.",
  );
};
export async function verifyReservationRefundExisting(
  source: ReservationRefundSource,
  ports: Pick<ReservationRefundPorts, "readVoucher">,
): Promise<SettlementCreateResult> {
  if (!source.existingVoucherId || source.hiddenExisting)
    return unknownResult();
  const v = await ports.readVoucher(source.existingVoucherId),
    r = v.capabilities.reservationRefund;
  if (
    v.id !== source.existingVoucherId ||
    v.organizationId !== source.organizationId ||
    v.systemSource !== "reservation.refund" ||
    v.type !== "EXPENSE" ||
    !r ||
    r.settlementId !== source.settlementId ||
    r.sourceVoucherId !== source.sourceVoucherId ||
    r.basisFingerprint !== source.basisFingerprint ||
    !r.current
  )
    return unknownResult();
  return { outcome: "existing", voucherId: v.id };
}
export async function createReservationRefundPending(
  request: {
    actorId: string;
    sourceRef: ReservationRefundSourceRef;
    expectedRevision: string;
    idempotencyKey: string;
    draft: ReservationRefundDraft;
  },
  ports: ReservationRefundPorts,
): Promise<SettlementCreateResult> {
  const draft = reservationRefundDraftSchema.parse(request.draft),
    source = await ports.readSource(request.sourceRef);
  if (
    source.actorId !== request.actorId ||
    source.organizationId !== request.sourceRef.organizationId ||
    source.sourceVoucherId !== request.sourceRef.sourceVoucherId ||
    source.hiddenExisting
  )
    throw new SettlementCreateError(
      "blocked",
      "Nguồn hoàn chưa sẵn sàng trong phạm vi hiện tại.",
    );
  if (source.existingVoucherId)
    return verifyReservationRefundExisting(source, ports);
  if (
    source.revision !== request.expectedRevision ||
    !source.canCreate ||
    !source.basisValid ||
    source.remaining <= 0
  )
    throw new SettlementCreateError(
      "blocked",
      source.blockedReason || "Nguồn hoàn đã thay đổi. Tải lại để đối chiếu.",
    );
  if (!request.idempotencyKey.trim())
    throw new SettlementCreateError("blocked", "Thiếu mã yêu cầu lập phiếu.");
  let response: unknown;
  try {
    response = await ports.createPending({
      organizationId: source.organizationId,
      sourceVoucherId: source.sourceVoucherId,
      settlementId: source.settlementId,
      basisFingerprint: source.basisFingerprint,
      expectedRemaining: source.remaining,
      idempotencyKey: request.idempotencyKey,
      recipientName: draft.recipientName,
      bank: draft.bank,
      accountNumber: draft.accountNumber,
    });
  } catch (error) {
    let latest: ReservationRefundSource;
    try {
      latest = await ports.readSource(request.sourceRef);
    } catch {
      return unknownResult();
    }
    if (latest.existingVoucherId && !latest.hiddenExisting)
      return verifyReservationRefundExisting(latest, ports);
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (
      [
        "42501",
        "P0001",
        "P0002",
        "22023",
        "23502",
        "23514",
        "23505",
        "55000",
      ].includes(code)
    )
      throw new SettlementCreateError(
        "blocked",
        error instanceof Error
          ? error.message
          : "Nguồn chưa đủ điều kiện lập phiếu.",
      );
    return unknownResult();
  }
  try {
    const result = obj(response),
      vid = id(result.voucherId);
    if (
      result.settlementId !== source.settlementId ||
      result.sourceVoucherId !== source.sourceVoucherId ||
      !["created", "existing"].includes(String(result.outcome))
    )
      return unknownResult();
    const latest = await ports.readSource(request.sourceRef);
    if (latest.existingVoucherId !== vid) return unknownResult();
    const existing = await verifyReservationRefundExisting(latest, ports);
    if (result.outcome === "existing") return existing;
    const v = await ports.readVoucher(vid);
    if (
      v.totalAmount !== source.remaining ||
      v.accountId !== null ||
      v.activePostingId !== null ||
      v.approvalStatus !== "UNAPPROVED" ||
      v.reviewState !== "PENDING" ||
      v.postingStatus !== "UNPOSTED"
    )
      return unknownResult();
    return { outcome: "created", voucherId: vid };
  } catch {
    return unknownResult();
  }
}
