// =============================================
// Thu tiền (cash collection) — pure helpers
// Suy ra trạng thái thu/format/SĐT từ InvoiceWithRelations thật.
// KHÔNG side-effect, KHÔNG fetch — chỉ thuần hàm để test dễ + tái dùng
// giữa lưới ô phòng, drawer và báo cáo.
// =============================================

import type { InvoiceWithRelations } from '@/types/invoice';

export type CollectStatus = 'paid' | 'partial' | 'unpaid';

// ── Định dạng tiền ──
/** 1.234.000 → "1.234.000đ" */
export const fmtFull = (v: number): string =>
  `${Math.round(v || 0).toLocaleString('vi-VN')}đ`;

/** 5.369.000 → "5369K" (làm tròn nghìn) */
export const fmtK = (v: number): string => `${Math.round((v || 0) / 1000)}K`;

/** ≥1e6 → "{m}tr" (1 chữ số thập phân nếu lẻ) · ≥1e3 → "{k}k" · còn lại số thô */
export const fmtShort = (v: number): string => {
  const n = Math.round(v || 0);
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : Math.round(m * 10) / 10}tr`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
};

/** "2026-06" → "Th6/2026" */
export const fmtBillingMonth = (m?: string | null): string => {
  if (!m) return '';
  const [y, mo] = m.split('-');
  if (!y || !mo) return m;
  return `Th${parseInt(mo, 10)}/${y}`;
};

// ── Số tiền còn lại + trạng thái thu ──
export const remainingOf = (inv: InvoiceWithRelations): number =>
  Number(inv.remaining_amount ?? (inv.total_amount - inv.paid_amount)) || 0;

/**
 * Map trạng thái HĐ thật → 3 trạng thái thu tiền (xem README §3):
 *  - paid    : status PAID hoặc remaining ≤ 0
 *  - partial : đã thu 1 phần (PARTIAL_PAID hoặc paid_amount > 0)
 *  - unpaid  : chưa thu đồng nào (gồm APPROVED/OVERDUE/DRAFT)
 */
export const collectStatus = (inv: InvoiceWithRelations): CollectStatus => {
  if (inv.status === 'PAID' || remainingOf(inv) <= 0) return 'paid';
  if (inv.status === 'PARTIAL_PAID' || (inv.paid_amount ?? 0) > 0) return 'partial';
  return 'unpaid';
};

/** Token Tailwind theo bảng màu thu-tiền (đỏ/vàng/xanh-lá — README §6). */
export const STATUS_META: Record<
  CollectStatus,
  { label: string; cell: string; text: string; dot: string }
> = {
  unpaid: { label: 'Chưa thu', cell: 'bg-red-50 border-red-200', text: 'text-[#d6453f]', dot: 'bg-[#d6453f]' },
  partial: { label: 'Một phần', cell: 'bg-amber-50 border-amber-200', text: 'text-[#c97a10]', dot: 'bg-[#c97a10]' },
  paid: { label: 'Đã thu', cell: 'bg-emerald-50 border-emerald-200', text: 'text-[#1f9d57]', dot: 'bg-[#1f9d57]' },
};

/** Dòng chú thích trong ô phòng: "Chưa thu" / "Thu thêm {K}" / "Thu đủ". */
export const cellSubText = (inv: InvoiceWithRelations): string => {
  const st = collectStatus(inv);
  if (st === 'paid') return 'Thu đủ';
  if (st === 'partial') return `Thu thêm ${fmtK(remainingOf(inv))}`;
  return 'Chưa thu';
};

// ── Khách đại diện (cho Zalo / Gọi) ──
export const repCustomer = (
  inv: InvoiceWithRelations,
): { name: string; phone: string | null } => {
  const cc = inv.contract?.contract_customers ?? [];
  const rep = cc.find((c) => c.is_representative) ?? cc[0];
  return { name: rep?.customer?.full_name ?? '', phone: rep?.customer?.phone ?? null };
};

/** SĐT VN → link Zalo (0xxx → 84xxx). */
export const zaloUrl = (phone: string): string => {
  const digits = (phone || '').replace(/\D/g, '');
  const normalized = digits.startsWith('0')
    ? `84${digits.slice(1)}`
    : digits.startsWith('84')
      ? digits
      : digits;
  return `https://zalo.me/${normalized}`;
};

export const telUrl = (phone: string): string => `tel:${(phone || '').replace(/\s/g, '')}`;

// ── Mốc thời gian thu (theo payments) ──
/** Ngày thu gần nhất (DATE) trong các payment; null nếu chưa thu. */
export const collectedAt = (inv: InvoiceWithRelations): string | null => {
  const ps = inv.payments ?? [];
  if (!ps.length) return null;
  return ps.reduce((max, p) => (p.payment_date > max ? p.payment_date : max), ps[0].payment_date);
};

/** Tổng tiền + có-hay-không payment rơi trong khoảng [start, end] (DATE, inclusive). */
export const paymentsInRange = (
  inv: InvoiceWithRelations,
  start: string,
  end: string,
): { sum: number; has: boolean } => {
  let sum = 0;
  let has = false;
  for (const p of inv.payments ?? []) {
    if (p.payment_date >= start && p.payment_date <= end) {
      sum += Number(p.amount) || 0;
      has = true;
    }
  }
  return { sum, has };
};

/** ID payment gần nhất (để Hoàn tác xoá phiếu thu vừa ghi); null nếu chưa có. */
export const latestPaymentId = (inv: InvoiceWithRelations): string | null => {
  const ps = inv.payments ?? [];
  if (!ps.length) return null;
  let best = ps[0];
  for (const p of ps) if (p.payment_date >= best.payment_date) best = p;
  return best.id;
};

// ── Snapshot theo ngày (tái dựng "chưa thu của ngày D" từ lịch sử payments) ──

/** Tổng tiền đã thu TÍNH ĐẾN HẾT ngày `date` (DATE, inclusive). */
export const paidUpTo = (inv: InvoiceWithRelations, date: string): number => {
  let sum = 0;
  for (const p of inv.payments ?? []) {
    if (p.payment_date <= date) sum += Number(p.amount) || 0;
  }
  return sum;
};

/**
 * HĐ đã thu xong TÍNH ĐẾN HẾT ngày `date` chưa?
 *  - Σ phiếu thu ≤ date đủ total_amount → true
 *  - HĐ hiện đã settled (PAID/remaining ≤ 0, gồm cả làm tròn <10K) và
 *    KHÔNG còn phiếu thu nào sau `date` → true (phiếu cuối đã chốt từ trước đó)
 */
export const paidAsOf = (inv: InvoiceWithRelations, date: string): boolean => {
  if (paidUpTo(inv, date) >= (Number(inv.total_amount) || 0)) return true;
  if (collectStatus(inv) !== 'paid') return false;
  return (inv.payments ?? []).every((p) => p.payment_date <= date);
};

/** Còn phải thu tính đến hết ngày `date` (0 nếu đã settle, kể cả làm tròn). */
export const remainingAsOf = (inv: InvoiceWithRelations, date: string): number =>
  paidAsOf(inv, date) ? 0 : Math.max(0, (Number(inv.total_amount) || 0) - paidUpTo(inv, date));

/** Ngày hiện tại theo GIỜ LOCAL (không dùng toISOString — UTC làm lệch ngày trước 7h sáng VN). */
export const todayISO = (): string => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
};
