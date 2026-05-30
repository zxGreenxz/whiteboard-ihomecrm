import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { format } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
  }).format(amount);
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
