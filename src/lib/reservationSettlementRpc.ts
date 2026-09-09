import { z } from "zod";

export type RefundMode = "NONE" | "NOW" | "LATER";
export type RefundState = "NOT_REQUIRED" | "PENDING" | "PAID";
export type SettlementReason = "CHANGED_MIND" | "NO_SHOW" | "OTHER";
export type SettlementBlock =
  | "NOT_RECEIVED"
  | "ALREADY_USED"
  | "SOURCE_CHANGED"
  | "PERMISSION_DENIED"
  | "PERIOD_LOCKED"
  | "DEPOSIT_CLASS_MISMATCH";
export type RoomBlock =
  | "OTHER_DEPOSIT"
  | "ACTIVE_CONTRACT"
  | "ROOM_UNAVAILABLE"
  | "UNRELATED_HOLD";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return value;
}, z.number().int().safe().nonnegative());
const count = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return value;
}, z.number().int().safe().nonnegative());
const roomBlockSchema = z.enum([
  "OTHER_DEPOSIT",
  "ACTIVE_CONTRACT",
  "ROOM_UNAVAILABLE",
  "UNRELATED_HOLD",
]);

export const reservationSettlementPreviewSchema = z.object({
  voucherId: uuid,
  depositAmount: money.refine((value) => value > 0),
  fingerprint: z.string().min(1),
  canSettle: z.boolean(),
  canRefundNow: z.boolean(),
  blockers: z.array(z.enum([
    "NOT_RECEIVED",
    "ALREADY_USED",
    "SOURCE_CHANGED",
    "PERMISSION_DENIED",
    "PERIOD_LOCKED",
    "DEPOSIT_CLASS_MISMATCH",
  ])),
  roomBlockers: z.array(roomBlockSchema),
  voucherCode: z.string().nullable(),
  payerName: z.string().nullable(),
  roomName: z.string().nullable(),
  buildingName: z.string().nullable(),
  voucherDate: isoDate,
});

export const reservationSettlementSchema = z.object({
  id: uuid,
  sourceVoucherId: uuid,
  depositAmount: money.refine((value) => value > 0),
  retainedAmount: money,
  refundAmount: money,
  refundedAmount: money,
  refundRemaining: money,
  refundState: z.enum(["NOT_REQUIRED", "PENDING", "PAID"]),
  roomReleased: z.boolean(),
  roomBlockers: z.array(roomBlockSchema),
  revenueVoucherId: uuid.nullable(),
  offsetVoucherId: uuid.nullable(),
  refundVoucherId: uuid.nullable(),
}).superRefine((value, ctx) => {
  if (value.depositAmount !== value.retainedAmount + value.refundAmount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid deposit split" });
  }
  if (value.refundAmount !== value.refundedAmount + value.refundRemaining) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid refund balance" });
  }
  const expectedState = value.refundAmount === 0
    ? "NOT_REQUIRED"
    : value.refundRemaining === 0 ? "PAID" : "PENDING";
  if (value.refundState !== expectedState) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid refund state" });
  }
});

export const reservationSettlementSummarySchema = z.object({
  retainedAmount: money,
  retainedCount: count,
  refundPendingAmount: money,
  refundPendingCount: count,
  refundPaidAmount: money,
  refundPaidCount: count,
});

export const reservationSettlementListRowSchema = reservationSettlementSchema.and(z.object({
  createdAt: z.string().datetime({ offset: true }),
  settlementDate: isoDate,
  reasonCode: z.enum(["CHANGED_MIND", "NO_SHOW", "OTHER"]),
  reasonText: z.string(),
  buildingId: uuid,
  buildingName: z.string(),
  roomId: uuid.nullable(),
  roomName: z.string().nullable(),
  payerName: z.string().nullable(),
  voucherCode: z.string().nullable(),
}));

export const reservationSettlementCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: uuid,
});

export const reservationSettlementListSchema = z.object({
  rows: z.array(reservationSettlementListRowSchema),
  nextCursor: reservationSettlementCursorSchema.nullable(),
});

export type SettlementPreview = z.infer<typeof reservationSettlementPreviewSchema>;
export type ReservationSettlement = z.infer<typeof reservationSettlementSchema>;
export type ReservationSettlementSummary = z.infer<typeof reservationSettlementSummarySchema>;
export type ReservationSettlementListRow = z.infer<typeof reservationSettlementListRowSchema>;
export type ReservationSettlementCursor = z.infer<typeof reservationSettlementCursorSchema>;

export function reservationSettlementListArgs(input?: {
  buildingIds?: string[];
  refundState?: RefundState | null;
  cursor?: ReservationSettlementCursor | null;
  sourceVoucherId?: string | null;
}) {
  return {
    p_building_ids: input?.buildingIds?.length ? input.buildingIds : null,
    p_refund_state: input?.refundState ?? null,
    p_cursor: input?.cursor ?? null,
    p_limit: 50,
    p_source_voucher_id: input?.sourceVoucherId ?? null,
  };
}

export interface SettleReservationInput {
  voucherId: string;
  refundAmount: number;
  refundMode: RefundMode;
  settlementDate: string;
  reasonCode: SettlementReason;
  reasonText: string;
  refundAccountId: string | null;
  basisFingerprint: string;
  idempotencyKey: string;
}

export interface PayReservationRefundInput {
  settlementId: string;
  accountId: string;
  paidOn: string;
  idempotencyKey: string;
}

export type ReservationSettlementRpcName =
  | "preview_reservation_settlement_v1"
  | "settle_reservation_deposit_v1"
  | "pay_reservation_refund_v1"
  | "get_reservation_settlement_summary_v1"
  | "get_reservation_settlements_v1";

export type ReservationSettlementRpcInvoker = (
  name: ReservationSettlementRpcName,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message?: string | null } | null }>;

const SETTLEMENT_ERROR_MESSAGES: ReadonlyArray<readonly [string, string]> = [
  ["PERMISSION_DENIED", "Bạn chưa đủ quyền thực hiện thao tác này."],
  ["NOT_CUSTODIAN", "Bạn không phải Người giữ sổ quỹ đã chọn."],
  ["PERIOD_LOCKED", "Ngày đã chọn nằm trong kỳ sổ quỹ đã khóa."],
  ["SOURCE_CHANGED", "Phiếu đã thay đổi. Hãy tải lại trước khi xử lý."],
  ["NOT_RECEIVED", "Phiếu chưa có bằng chứng tiền đã vào quỹ."],
  ["ALREADY_USED", "Phiếu cọc đã được dùng cho nghiệp vụ khác."],
  ["DEPOSIT_CLASS_MISMATCH", "Hạng mục cọc chưa thống nhất, cần đối chiếu trước."],
];

export function reservationSettlementErrorMessage(message?: string | null) {
  const matched = SETTLEMENT_ERROR_MESSAGES.find(([code]) => message?.includes(code));
  return matched?.[1] ?? "Không thể xử lý cọc giữ chỗ. Vui lòng thử lại.";
}

export function createReservationIdempotencyStore(prefix: string, createId: () => string = () => crypto.randomUUID()) {
  const keys = new Map<string, string>();
  const signatureOf = (payload: object) => JSON.stringify(payload);
  return {
    keyFor(payload: object) {
      const signature = signatureOf(payload);
      const current = keys.get(signature);
      if (current) return current;
      const next = `${prefix}:${createId()}`;
      keys.set(signature, next);
      return next;
    },
    retire(payload: object) {
      keys.delete(signatureOf(payload));
    },
  };
}

export async function invokeReservationSettlementRpc<S extends z.ZodTypeAny>(
  rpc: ReservationSettlementRpcInvoker,
  name: ReservationSettlementRpcName,
  args: Record<string, unknown>,
  schema: S,
): Promise<z.output<S>> {
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(reservationSettlementErrorMessage(error.message));
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error("Dữ liệu xử lý cọc chưa hợp lệ. Hãy tải lại và thử lại.");
  return parsed.data;
}
