import { formatVND } from "@/lib/utils";
import { CONTRACT_DEPOSIT_TOLERANCE } from "@/lib/contractCreateRpc";

/**
 * Điều chỉnh giá thuê / tiền cọc khi ký hợp đồng.
 *
 * Quy ước MẶC ĐỊNH của form HĐ:
 *   - "Tiền thuê" mặc định = giá niêm yết của phòng (rooms.rent_price).
 *   - "Tiền cọc" mặc định = TIỀN THUÊ của hợp đồng (không phải rooms.deposit_amount).
 *
 * Khi user mở khoá (nút bút chì) và ký lệch mặc định, hệ thống lưu dấu ở 2 chỗ:
 *   1. `room_price_history` — trigger DB ghi tự động (giá phòng ↔ giá HĐ).
 *   2. `contracts.notes` — chèn 1 dòng gắn thẻ để LỌC / ĐỐI CHIẾU sau này
 *      (module này lo phần đó).
 *
 * Dòng ghi chú phải IDEMPOTENT: sửa HĐ nhiều lần chỉ còn đúng 1 dòng thẻ,
 * không chồng chất.
 */

/** Thẻ nhận diện dòng ghi chú tự sinh — dùng để lọc & để strip khi ghi lại. */
export const DEPOSIT_ADJUSTMENT_TAG = "[Điều chỉnh cọc]";

export type DepositAdjustmentDirection = "INCREASE" | "DECREASE" | "NONE";

export interface DepositAdjustment {
  direction: DepositAdjustmentDirection;
  /** Chênh lệch TUYỆT ĐỐI so với tiền thuê (0 khi không điều chỉnh). */
  diff: number;
  rentPrice: number;
  totalDeposit: number;
}

const toFinite = (value: number | null | undefined): number =>
  Number.isFinite(value) ? (value as number) : 0;

/**
 * So tiền cọc với mặc định (= tiền thuê). Dùng chung cho hint dưới ô nhập và
 * cho dòng ghi chú, để 2 chỗ không bao giờ lệch nhau.
 */
export function describeDepositAdjustment(
  rentPrice: number | null | undefined,
  totalDeposit: number | null | undefined,
): DepositAdjustment {
  const rent = toFinite(rentPrice);
  const deposit = toFinite(totalDeposit);
  const delta = deposit - rent;

  if (Math.abs(delta) < CONTRACT_DEPOSIT_TOLERANCE) {
    return { direction: "NONE", diff: 0, rentPrice: rent, totalDeposit: deposit };
  }

  return {
    direction: delta > 0 ? "INCREASE" : "DECREASE",
    diff: Math.abs(delta),
    rentPrice: rent,
    totalDeposit: deposit,
  };
}

/** Câu cảnh báo hiện NGAY DƯỚI ô "Tiền cọc" khi cọc lệch tiền thuê. */
export function depositAdjustmentHint(
  adjustment: DepositAdjustment,
): string | null {
  if (adjustment.direction === "NONE") return null;
  const verb = adjustment.direction === "DECREASE" ? "GIẢM" : "TĂNG";
  return (
    `Bạn đang ${verb} số tiền cọc khách phải đóng ${formatVND(adjustment.diff)} ` +
    `so với tiền thuê ${formatVND(adjustment.rentPrice)} ` +
    `(cọc ${formatVND(adjustment.totalDeposit)}).`
  );
}

/** Dòng ghi chú gắn thẻ lưu vào `contracts.notes`; null khi cọc = tiền thuê. */
export function buildDepositAdjustmentNote(
  rentPrice: number | null | undefined,
  totalDeposit: number | null | undefined,
): string | null {
  const adjustment = describeDepositAdjustment(rentPrice, totalDeposit);
  if (adjustment.direction === "NONE") return null;
  const verb = adjustment.direction === "DECREASE" ? "giảm" : "tăng";
  return (
    `${DEPOSIT_ADJUSTMENT_TAG} ${verb} ${formatVND(adjustment.diff)} ` +
    `so với tiền thuê — cọc ${formatVND(adjustment.totalDeposit)} / ` +
    `thuê ${formatVND(adjustment.rentPrice)}`
  );
}

/** Bỏ mọi dòng thẻ cũ (kể cả nhiều dòng do dữ liệu cũ) khỏi ghi chú. */
export function stripDepositAdjustmentNote(
  notes: string | null | undefined,
): string {
  if (!notes) return "";
  return notes
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(DEPOSIT_ADJUSTMENT_TAG))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Ghi chú cuối cùng gửi lên DB: giữ nguyên phần user tự viết, thay dòng thẻ cũ
 * bằng dòng thẻ mới (hoặc bỏ hẳn khi cọc trở lại = tiền thuê).
 * Trả `null` khi rỗng — cột `contracts.notes` nullable.
 */
export function applyDepositAdjustmentNote(
  notes: string | null | undefined,
  rentPrice: number | null | undefined,
  totalDeposit: number | null | undefined,
): string | null {
  const base = stripDepositAdjustmentNote(notes);
  const tagLine = buildDepositAdjustmentNote(rentPrice, totalDeposit);
  if (!tagLine) return base || null;
  return base ? `${base}\n${tagLine}` : tagLine;
}
