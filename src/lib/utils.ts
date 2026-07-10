import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Formatter singleton hoist ở module-scope: KHÔNG tạo mới Intl.NumberFormat mỗi
// lần gọi (đắt + rác GC khi render bảng tiền hàng nghìn dòng). Dùng lại 2 instance.
const VND_FMT = new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});
const VND_FMT_PLAIN = new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 0,
});

/**
 * Chuẩn hoá số tiền: bắt NaN, Infinity, -Infinity, null, undefined và chuỗi
 * không-phải-số → 0. Dùng chung cho formatCurrency/formatVND để tránh "NaN ₫".
 */
function toFiniteVND(amount: number | null | undefined): number {
  const n = Number(amount);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tiền VND kiểu ký hiệu ₫ chuẩn Intl: "1.500.000 ₫". Dùng cho báo cáo tài chính.
 * (Trước đây ~30 file tự định nghĩa lại y hệt — gom về đây.)
 * NaN/undefined/Infinity → "0 ₫". Số lẻ làm tròn về nguyên (1234.56 → "1.235 ₫").
 */
export function formatCurrency(amount: number | null | undefined): string {
  return VND_FMT.format(toFiniteVND(amount));
}

/**
 * Tiền VND kiểu chữ "đ" thường có dấu cách: "1.500.000 đ". Dùng cho phiếu thu/chi,
 * hoá đơn in, sổ quỹ — nơi UI dùng "đ" thay vì ký hiệu ₫. null/NaN → "0 đ".
 * (Trước đây nhiều file tự định nghĩa `${n.toLocaleString("vi-VN")} đ` — gom về đây.)
 */
export function formatVND(amount: number | null | undefined): string {
  return `${VND_FMT_PLAIN.format(toFiniteVND(amount))} đ`;
}

export function formatDate(date: string | Date, formatStr: string = "dd/MM/yyyy"): string {
  return format(new Date(date), formatStr);
}

/**
 * Chuẩn hoá chuỗi để so khớp tìm kiếm không phân biệt hoa/thường và dấu tiếng Việt.
 * "Quận Tân Bình" → "quan tan binh". Dùng cho ô lọc searchable, autocomplete...
 */
export function normalizeVietnamese(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFD")
    // strip combining diacritical marks (U+0300–U+036F)
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}
