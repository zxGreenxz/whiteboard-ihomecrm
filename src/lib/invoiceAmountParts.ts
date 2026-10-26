// =============================================================================
// invoiceAmountParts — tiền thu theo hoá đơn tách thành Tiền phòng / Điện / Nước / PDV (chủ chốt 25/10/2026).
//
// Server chia (public.invoice_item_column_v1 + public.invoice_amount_split_v1, migration 20261025165112): bốn
// cột đúng số trên hoá đơn, giảm trừ / nợ cũ / làm tròn tách riêng; phiếu thu khác phần doanh thu của hoá đơn
// (trả hai lần, trả thiếu) ⇒ mọi phần nhân cùng tỷ lệ. Quyết toán vận hành nhận sẵn trong gói (voucher.parts),
// Báo cáo LN gọi public.invoice_amount_parts_v1. File này chỉ đọc + đặt nhãn — không chia tiền ở đây.
// =============================================================================

import { z } from 'zod';

const money = z.number().finite();

export const invoiceAmountPartsSchema = z.object({
  rent: money,
  electric: money,
  water: money,
  /** Phí dịch vụ (dịch vụ không phải điện / nước). */
  service: money,
  /** Dòng hoá đơn không phải phòng / điện / nước / dịch vụ (chìa khoá, rác, phạt…). */
  other: money,
  /** Giảm trừ của hoá đơn (≤ 0). */
  discount: money,
  /** Nợ cũ cộng vào hoá đơn (≥ 0). */
  debt: money,
  /** Làm tròn của hoá đơn (+ phần lẻ khi chia tỷ lệ) — chủ chốt: không hiện ở dòng. */
  rounding: money,
  /** Phần doanh thu phải thu của hoá đơn (tổng − cọc / khoản không phải doanh thu). */
  invoice_amount: money,
  /** Số tiền phiếu khác phần doanh thu của hoá đơn ⇒ các phần là chia theo tỷ lệ. */
  partial: z.boolean(),
});
export type InvoiceAmountParts = z.infer<typeof invoiceAmountPartsSchema>;

/** Kết quả public.invoice_amount_parts_v1 — chỉ có dòng của hoá đơn người gọi đọc được. */
export const invoiceAmountPartsRowsSchema = z.array(invoiceAmountPartsSchema.extend({ key: z.string() }));

/**
 * Bốn cột tiền của bảng Khoản thu (thiết kế "Quyet toan van hanh v2"). Chủ chốt: khoản khác trên hoá đơn GỘP
 * vào cột PDV; khối "Theo hạng mục" vẫn tách riêng (INVOICE_PART_CATEGORIES).
 */
export const INVOICE_PART_COLUMNS = [
  { key: 'rent', label: 'Tiền phòng' },
  { key: 'electric', label: 'Điện' },
  { key: 'water', label: 'Nước' },
  { key: 'service', label: 'PDV' },
] as const;
export type InvoicePartColumn = typeof INVOICE_PART_COLUMNS[number]['key'];

/** Số của một cột: cột PDV = phí dịch vụ + khoản khác (cộng hai số server trả để hiển thị). */
export function invoicePartColumnAmount(p: InvoiceAmountParts, col: InvoicePartColumn): number {
  return col === 'service' ? p.service + p.other : p[col];
}

type CategoryKey = 'rent' | 'electric' | 'water' | 'service' | 'other' | 'discount' | 'debt' | 'rounding';

/**
 * Tên hạng mục của từng phần — TRÙNG ĐÚNG tên server dùng trong categories của quyết toán (test PGlite so) để
 * Báo cáo LN và quyết toán gộp cùng tên.
 */
export const INVOICE_PART_CATEGORIES: Readonly<Record<CategoryKey, string>> = {
  rent: 'Tiền phòng',
  electric: 'Tiền điện',
  water: 'Tiền nước',
  service: 'Phí dịch vụ',
  other: 'Thu khác',
  discount: 'Giảm trừ hoá đơn',
  debt: 'Nợ cũ',
  rounding: 'Làm tròn hoá đơn',
};

const NUM = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const signed = (v: number) => `${v < 0 ? '−' : '+'}${NUM.format(Math.abs(v))}`;

/**
 * Ghi chú dưới dòng: giảm trừ / nợ cũ của hoá đơn và phiếu chia theo tỷ lệ. Làm tròn KHÔNG ghi (chủ chốt
 * 25/10/2026 "làm tròn thì bỏ qua").
 */
export function invoicePartsNote(p: InvoiceAmountParts, amount: number): string {
  const out: string[] = [];
  if (p.discount !== 0) out.push(`Giảm trừ ${signed(p.discount)}`);
  if (p.debt !== 0) out.push(`Nợ cũ ${signed(p.debt)}`);
  if (p.partial) {
    out.push(amount < p.invoice_amount
      ? `thu một phần (hoá đơn ${NUM.format(p.invoice_amount)}) — chia theo tỷ lệ`
      : `thu nhiều hơn hoá đơn (${NUM.format(p.invoice_amount)}) — chia theo tỷ lệ`);
  }
  return out.join(' · ');
}

/** Một dòng đưa vào "Theo hạng mục": key để tra phần tách; dòng ghi chú bỏ qua. */
export type CategoryShareInput = { key: string; name: string; amount: number; isNote?: boolean };

/**
 * "Theo hạng mục" của Báo cáo LN (chỉ để hiển thị tỷ trọng): dòng có phần tách cộng theo phần của hoá đơn (tên
 * INVOICE_PART_CATEGORIES — trùng quyết toán vận hành), dòng khác theo hạng mục của nó; tên trống ⇒ "Khác".
 */
export function categorySharesOf(
  rows: readonly CategoryShareInput[],
  parts?: ReadonlyMap<string, InvoiceAmountParts>,
): { name: string; amount: number }[] {
  const m = new Map<string, number>();
  const add = (name: string, v: number) => {
    if (v !== 0) m.set(name, (m.get(name) ?? 0) + v);
  };
  for (const r of rows) {
    if (r.isNote) continue;
    const p = parts?.get(r.key);
    if (p) {
      for (const k of Object.keys(INVOICE_PART_CATEGORIES) as CategoryKey[]) add(INVOICE_PART_CATEGORIES[k], p[k]);
    } else add(r.name && r.name !== '—' ? r.name : 'Khác', r.amount);
  }
  return Array.from(m, ([name, amount]) => ({ name, amount }));
}
