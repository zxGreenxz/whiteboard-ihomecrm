// =============================================
// Hoá đơn cọc + tháng đầu — sinh items mặc định.
//
// Bao gồm:
//   - RENT: tháng đầu (tự chia tỉ lệ theo số ngày start→end / daysInStartMonth)
//   - DISCOUNT: khuyến mãi tháng đầu (nếu có discounts)
//   - SERVICE: dịch vụ tính cố định (theo tháng/phòng/người).
//     Bỏ qua dịch vụ tính theo đồng hồ (đợi chốt chỉ số).
//
// LƯU Ý: Tiền cọc KHÔNG còn nằm trong hoá đơn (trước đây là item OTHER
// "Tiền cọc"). Cọc lọt vào hoá đơn rồi thu → bị tính nhầm vào KQKD. Nay cọc
// được thu bằng PHIẾU THU CỌC riêng (hạng mục "Tiền cọc", is_deposit).
// =============================================

export type FirstInvoiceItemType = "RENT" | "SERVICE" | "DISCOUNT" | "OTHER";

export interface FirstInvoiceItem {
  /** Local id để React render — không lưu DB. */
  id: string;
  type: FirstInvoiceItemType;
  description: string;
  unit_price: number;
  quantity: number;
  service_id?: string | null;
  from_date?: string | null;
  to_date?: string | null;
}

export interface FirstInvoiceBuilderInput {
  rent_price: number;
  total_deposit: number;
  deposit_paid: number;
  start_billing_date?: string; // YYYY-MM-DD
  end_billing_date?: string;   // YYYY-MM-DD
  discount_months?: number;
  discount_amount_per_month?: number;
  services: Array<{
    service_id: string;
    name: string;
    unit_price: number;
    /** Số lượng (vd theo người: 2 khách → 2). User chỉnh trên bảng dịch vụ. */
    quantity?: number;
    pricing_type?: string | null;
  }>;
}

const METERED_PRICING = new Set([
  "DON_GIA_CO_DINH_DONG_HO",
  "DON_GIA_BIEN_DONG",
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Số ngày tính tiền từ start→end (inclusive cả 2 đầu) — chia tỉ lệ tháng đầu. */
export function getProratedDays(startISO?: string, endISO?: string): number {
  if (!startISO || !endISO) return 0;
  const s = new Date(startISO + "T00:00:00");
  const e = new Date(endISO + "T00:00:00");
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
  if (e < s) return 0;
  return Math.round((e.getTime() - s.getTime()) / MS_PER_DAY) + 1;
}

/** Số ngày trong tháng của start_billing_date. */
function daysInMonthOf(iso: string): number {
  const d = new Date(iso + "T00:00:00");
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** Tỉ lệ tiền thuê tháng đầu = rent × (days / daysInStartMonth). */
export function calculateProratedRent(
  rent: number,
  startISO?: string,
  endISO?: string,
): number {
  if (!rent || !startISO) return rent || 0;
  if (!endISO) return rent;
  const days = getProratedDays(startISO, endISO);
  if (days <= 0) return rent;
  const daysInMonth = daysInMonthOf(startISO);
  if (!daysInMonth) return rent;
  return Math.round((rent / daysInMonth) * days);
}

let _seq = 0;
function nextId(prefix: string) {
  _seq += 1;
  return `${prefix}-${Date.now()}-${_seq}`;
}

export function buildFirstInvoiceItems(
  input: FirstInvoiceBuilderInput,
): FirstInvoiceItem[] {
  const items: FirstInvoiceItem[] = [];

  // RENT — tháng đầu (chia tỉ lệ theo số ngày start→end).
  const proratedRent = calculateProratedRent(
    input.rent_price,
    input.start_billing_date,
    input.end_billing_date,
  );
  if (proratedRent > 0) {
    const days = getProratedDays(input.start_billing_date, input.end_billing_date);
    const desc =
      days > 0 && input.end_billing_date
        ? `Tiền thuê tháng đầu (${days} ngày)`
        : "Tiền thuê tháng đầu";
    items.push({
      id: nextId("rent"),
      type: "RENT",
      description: desc,
      unit_price: proratedRent,
      quantity: 1,
      from_date: input.start_billing_date ?? null,
      to_date: input.end_billing_date ?? null,
    });
  }

  // NOTE: Khuyến mãi KHÔNG còn nằm trong items nữa — tách ra discount_amount
  // riêng (xem buildFirstInvoiceDiscount). Lý do: để mỗi HĐ tháng có 1 dòng
  // "Giảm trừ" thống nhất, có notes/tooltip rõ ràng "tháng X/Y × Z đ", và áp
  // tự động cho cả HĐ tháng 2..N (qua getContractDiscountSlot).

  // SERVICE — dịch vụ cố định: prorate theo cùng tỉ lệ ngày như tiền thuê
  // (dịch vụ đồng hồ bỏ qua, sẽ chốt khi ghi chỉ số).
  const proratedDays = getProratedDays(
    input.start_billing_date,
    input.end_billing_date,
  );
  const startDaysInMonth = input.start_billing_date
    ? daysInMonthOf(input.start_billing_date)
    : 0;
  const shouldProrate =
    proratedDays > 0 && startDaysInMonth > 0 && proratedDays !== startDaysInMonth;
  for (const s of input.services) {
    if (METERED_PRICING.has(s.pricing_type ?? "")) continue;
    if (!s.unit_price || s.unit_price <= 0) continue;
    const proratedPrice = shouldProrate
      ? Math.round((s.unit_price / startDaysInMonth) * proratedDays)
      : s.unit_price;
    const description = shouldProrate
      ? `${s.name} (${proratedDays} ngày)`
      : s.name;
    const qty = s.quantity && s.quantity > 0 ? s.quantity : 1;
    items.push({
      id: nextId("svc"),
      type: "SERVICE",
      description,
      unit_price: proratedPrice,
      quantity: qty,
      service_id: s.service_id,
    });
  }

  // NOTE: Tiền cọc KHÔNG còn nằm trong hoá đơn (đường rò rỉ cũ → cọc lọt vào
  // KQKD khi thu hoá đơn). Cọc còn thiếu lúc ký được thu bằng PHIẾU THU CỌC
  // riêng (hạng mục "Tiền cọc", is_deposit) — xem ContractFormDialog.
  return items;
}

/**
 * Tính giảm trừ "Khuyến mãi tháng đầu" cho HĐ cọc + tháng đầu (slot 1/Y).
 * Trả về `{ amount, notes }` để dialog hiển thị và mutation set vào
 * `invoices.discount_amount` + `invoices.discount_notes`.
 *
 * Khi HĐ tháng đầu PAID, slotIndex của HĐ kế tiếp = 2 (count HĐ đã active).
 */
export function buildFirstInvoiceDiscount(
  input: FirstInvoiceBuilderInput,
): { amount: number; notes: string } {
  const months = Math.max(0, Math.floor(input.discount_months ?? 0));
  const perMonth = Math.max(0, input.discount_amount_per_month ?? 0);
  if (months <= 0 || perMonth <= 0) return { amount: 0, notes: '' };
  return {
    amount: perMonth,
    notes: `Khuyến mãi HĐ — tháng 1/${months} × ${perMonth.toLocaleString('vi-VN')}đ`,
  };
}

// =============================================
// Kỳ thanh toán (billing_month) của HOÁ ĐƠN THÁNG ĐẦU
//
// Doanh thu hoá đơn được ghi nhận TRỌN vào billing_month (xem useAccrualReport).
// Với hoá đơn tháng đầu, kỳ suy từ khoảng [from, to] mà quản lý chọn:
//   - "Tháng dương lịch được phủ TRỌN muộn nhất" trong [from, to].
//   - Nếu không tháng nào phủ trọn → tháng của `from`.
// Ví dụ: 20/5–31/5 → T5 · 20/5–5/6 → T5 · 28/5–30/6 → T6 · 28/5–5/7 → T6.
//
// Thuần (pure), so sánh CHUỖI ngày ISO 'YYYY-MM-DD' (so lexicographic đúng thứ
// tự) — KHÔNG `new Date('yyyy-MM-dd')` để tránh lệch GMT+7 (theo accrualAllocation).
// =============================================

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' | 'YYYY-MM' → { y, m } (m 1..12), hoặc null nếu không hợp lệ. */
function parseYearMonth(d?: string | null): { y: number; m: number } | null {
  if (!d) return null;
  const parts = d.slice(0, 7).split('-');
  if (parts.length < 2) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  return { y, m };
}

/** Ngày CUỐI tháng (y, m) dạng 'YYYY-MM-DD'. getDate an toàn timezone (local midnight). */
function lastDayISO(y: number, m: number): string {
  const last = new Date(y, m, 0).getDate(); // m tính từ 1 → ngày cuối tháng m
  return `${y}-${pad2(m)}-${pad2(last)}`;
}

/** Ngày ĐẦU tháng (y, m) dạng 'YYYY-MM-DD'. */
function firstDayISO(y: number, m: number): string {
  return `${y}-${pad2(m)}-01`;
}

/**
 * Kỳ thanh toán ('YYYY-MM') cho hoá đơn tháng đầu, suy từ [from, to].
 * `from` rỗng/không hợp lệ → '' (caller tự xử). `to` rỗng → tháng của `from`.
 */
export function computeFirstBillingMonth(
  from?: string | null,
  to?: string | null,
): string {
  const f = parseYearMonth(from);
  if (!f) return (from ?? '').slice(0, 7);
  const fromKey = `${f.y}-${pad2(f.m)}`;
  if (!to) return fromKey;

  const fromDate = from!.slice(0, 10);
  const toDate = to.slice(0, 10);
  if (toDate < fromDate) return fromKey; // data bẩn (to < from)

  // Quét các tháng từ tháng của `from` trở lên; giữ tháng phủ TRỌN muộn nhất.
  let result = fromKey;
  let y = f.y;
  let m = f.m;
  for (let i = 0; i < 24; i++) {
    if (lastDayISO(y, m) > toDate) break; // tháng này chưa kết thúc trong kỳ
    if (firstDayISO(y, m) >= fromDate) result = `${y}-${pad2(m)}`; // phủ trọn
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return result;
}

/**
 * Chặn kỳ đầu thiếu tháng: `to` phải ≥ ngày cuối tháng của `from`
 * (vd 20/5–30/5 lỗi vì tháng 5 chưa được chọn đủ tới 31/5).
 * Thiếu from/to → hợp lệ (không ràng buộc khi chưa chọn kỳ tuỳ chỉnh).
 */
export function validateFirstBillingPeriod(
  from?: string | null,
  to?: string | null,
): { ok: boolean; message?: string } {
  if (!from || !to) return { ok: true };
  const f = parseYearMonth(from);
  if (!f) return { ok: true };
  const fromDate = from.slice(0, 10);
  const toDate = to.slice(0, 10);
  if (toDate < fromDate) {
    return { ok: false, message: 'Đến ngày phải sau hoặc bằng ngày bắt đầu tính tiền.' };
  }
  const endOfStartMonth = lastDayISO(f.y, f.m);
  if (toDate < endOfStartMonth) {
    const dmy = endOfStartMonth.split('-').reverse().join('/');
    return {
      ok: false,
      message: `Tháng đầu tiên phải tính đủ đến hết tháng — chọn "Đến ngày" tối thiểu ${dmy}.`,
    };
  }
  return { ok: true };
}
