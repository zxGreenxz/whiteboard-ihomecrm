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

export async function invokeReservationSettlementRpc<T>(
  rpc: ReservationSettlementRpcInvoker,
  name: ReservationSettlementRpcName,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const { data, error } = await rpc(name, args);
  if (error) throw new Error(error.message || "Không thể xử lý cọc giữ chỗ");
  return schema.parse(data);
}
