import { z } from "zod";
import type { RefundMode, SettlementReason } from "./reservationSettlementRpc";

export function calculateReservationSplit(depositAmount: number, refundAmount: number) {
  if (!Number.isSafeInteger(depositAmount) || depositAmount <= 0) {
    throw new Error("Tiền cọc phải là số nguyên dương");
  }
  if (!Number.isSafeInteger(refundAmount) || refundAmount < 0 || refundAmount > depositAmount) {
    throw new Error("Tiền hoàn phải là số nguyên từ 0 đến tiền cọc");
  }
  return { retainedAmount: depositAmount - refundAmount, refundAmount };
}

export interface ReservationSettlementFormValues {
  depositAmount: number;
  refundAmount: number;
  refundMode: RefundMode;
  settlementDate: string;
  reasonCode: SettlementReason;
  reasonText: string;
  refundAccountId: string | null;
}

export const reservationSettlementFormSchema = z.object({
  depositAmount: z.number().int().safe().positive(),
  refundAmount: z.number().int().safe().nonnegative(),
  refundMode: z.enum(["NONE", "NOW", "LATER"]),
  settlementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reasonCode: z.enum(["CHANGED_MIND", "NO_SHOW", "OTHER"]),
  reasonText: z.string(),
  refundAccountId: z.string().uuid().nullable(),
}).superRefine((value, ctx) => {
  if (value.refundAmount > value.depositAmount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundAmount"], message: "Tiền hoàn vượt tiền cọc" });
  }
  if (value.refundAmount === 0 && value.refundMode !== "NONE") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundMode"], message: "Không cần hoàn tiền" });
  }
  if (value.refundAmount > 0 && value.refundMode === "NONE") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundMode"], message: "Chọn hoàn ngay hoặc hoàn sau" });
  }
  if (value.refundMode === "NOW" && !value.refundAccountId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["refundAccountId"], message: "Chọn sổ quỹ đã chi" });
  }
  if (value.reasonCode === "OTHER" && !value.reasonText.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reasonText"], message: "Nhập lý do" });
  }
});

export const reservationRefundPaymentSchema = z.object({
  accountId: z.string().uuid("Chọn sổ quỹ đã chi"),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Chọn ngày chi"),
});
export type ReservationRefundPaymentValues = z.infer<typeof reservationRefundPaymentSchema>;
