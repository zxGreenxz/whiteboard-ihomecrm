// =============================================
// Hoá đơn cọc + tháng đầu — sinh items mặc định.
//
// Bao gồm:
//   - RENT: kỳ đầu (chia tỉ lệ riêng theo số ngày của từng tháng dương lịch)
//   - DISCOUNT: khuyến mãi tháng đầu (nếu có discounts)
//   - SERVICE: dịch vụ tính cố định (theo tháng/phòng/người).
//     Bỏ qua dịch vụ tính theo đồng hồ (đợi chốt chỉ số).
//   - OTHER: cọc còn thiếu (total_deposit − deposit_paid) GỘP vào hoá đơn —
//     là KHOẢN PHẢI THU của HĐ. Khi thu, useRecordPaymentRPC tách phần cọc
//     thành phiếu is_deposit (NGOÀI KQKD) để nhìn rõ ở Thu chi (không phải
//     phiếu thu lẻ ngoài HĐ). Bỏ qua nếu include_deposit=false (mode Nợ cọc).
// =============================================

export type FirstInvoiceItemType = "RENT" | "SERVICE" | "DISCOUNT" | "OTHER";
export type FirstInvoiceAccountingClass = "REVENUE" | "DEPOSIT";

export interface FirstInvoiceItem {
  /** Local id để React render — không lưu DB. */
  id: string;
  type: FirstInvoiceItemType;
  accounting_class: FirstInvoiceAccountingClass;
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
  /** Có gộp cọc còn thiếu vào hoá đơn tháng đầu không. Mặc định TRUE (mode
   *  "Đóng đủ"): cọc còn thiếu = item OTHER "Tiền cọc" trong HĐ, thu cùng hoá
   *  đơn rồi tách phiếu is_deposit khi thanh toán (useRecordPaymentRPC). FALSE
   *  (mode "Nợ cọc"): cọc thiếu KHÔNG vào HĐ, chỉ theo dõi nợ + nhắc. */
  include_deposit?: boolean;
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

interface ParsedISODate {
  y: number;
  m: number;
  d: number;
  iso: string;
}

function parseISODate(value?: string | null): ParsedISODate | null {
  if (!value) return null;
  const iso = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== m - 1 ||
    utc.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d, iso };
}

export function normalizeDateOnly(value?: string | null): string | null {
  return parseISODate(value)?.iso ?? null;
}

export function normalizeFirstBillingPeriod(
  startBillingDate?: string | null,
  endBillingDate?: string | null,
  contractStartDate?: string | null,
): { start_date: string | null; end_date: string | null } {
  const startDate =
    normalizeDateOnly(startBillingDate) ?? normalizeDateOnly(contractStartDate);
  const endDate = normalizeDateOnly(endBillingDate) ?? startDate;
  return { start_date: startDate, end_date: endDate };
}

/** Số ngày tính tiền từ start→end (inclusive cả 2 đầu). */
export function getProratedDays(startISO?: string, endISO?: string): number {
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end || end.iso < start.iso) return 0;
  const startMs = Date.UTC(start.y, start.m - 1, start.d);
  const endMs = Date.UTC(end.y, end.m - 1, end.d);
  return Math.round((endMs - startMs) / MS_PER_DAY) + 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Prorate a monthly amount month-by-month. Each calendar month uses its own
 * denominator, so a period crossing February/March is not divided by the
 * number of days in the first month only.
 */
export function calculateProratedRent(
  rent: number,
  startISO?: string,
  endISO?: string,
): number {
  if (!rent) return rent || 0;
  const start = parseISODate(startISO);
  const end = parseISODate(endISO);
  if (!start || !end || end.iso < start.iso) return rent;

  const startMonthIndex = start.y * 12 + (start.m - 1);
  const endMonthIndex = end.y * 12 + (end.m - 1);
  let total = 0;

  for (let monthIndex = startMonthIndex; monthIndex <= endMonthIndex; monthIndex += 1) {
    const year = Math.floor(monthIndex / 12);
    const month = (monthIndex % 12) + 1;
    const monthDays = daysInMonth(year, month);
    const firstCoveredDay = monthIndex === startMonthIndex ? start.d : 1;
    const lastCoveredDay = monthIndex === endMonthIndex ? end.d : monthDays;
    total += rent * ((lastCoveredDay - firstCoveredDay + 1) / monthDays);
  }

  return Math.round(total);
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

  // RENT — kỳ đầu (chia tỉ lệ riêng theo từng tháng dương lịch).
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
      accounting_class: "REVENUE",
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

  // SERVICE — dịch vụ cố định: prorate theo cùng cách từng tháng như tiền thuê
  // (dịch vụ đồng hồ bỏ qua, sẽ chốt khi ghi chỉ số).
  const proratedDays = getProratedDays(
    input.start_billing_date,
    input.end_billing_date,
  );
  for (const s of input.services) {
    if (METERED_PRICING.has(s.pricing_type ?? "")) continue;
    if (!s.unit_price || s.unit_price <= 0) continue;
    const proratedPrice = calculateProratedRent(
      s.unit_price,
      input.start_billing_date,
      input.end_billing_date,
    );
    const shouldProrate = proratedDays > 0 && proratedPrice !== s.unit_price;
    const description = shouldProrate
      ? `${s.name} (${proratedDays} ngày)`
      : s.name;
    const qty = s.quantity && s.quantity > 0 ? s.quantity : 1;
    items.push({
      id: nextId("svc"),
      type: "SERVICE",
      accounting_class: "REVENUE",
      description,
      unit_price: proratedPrice,
      quantity: qty,
      service_id: s.service_id,
      from_date: input.start_billing_date ?? null,
      to_date: input.end_billing_date ?? null,
    });
  }

  // OTHER — cọc còn thiếu GỘP vào hoá đơn tháng đầu (= khoản phải thu của HĐ).
  // Cọc nằm TRONG hoá đơn (item "Tiền cọc"); khi thu hoá đơn, useRecordPaymentRPC
  // tách phần cọc thành phiếu thu hạng mục "Tiền cọc" (is_deposit, NGOÀI KQKD) —
  // chỉ là cơ chế tách phiếu để nhìn rõ ở Thu chi, KHÔNG phải phiếu thu lẻ ngoài
  // HĐ. Mode "Nợ cọc" (include_deposit=false) thì KHÔNG gộp, chỉ theo dõi nợ.
  if (input.include_deposit !== false) {
    const depositRemaining = Math.max(
      0,
      (input.total_deposit ?? 0) - (input.deposit_paid ?? 0),
    );
    if (depositRemaining > 0) {
      items.push({
        id: nextId("deposit"),
        type: "OTHER",
        accounting_class: "DEPOSIT",
        description: "Tiền cọc",
        unit_price: depositRemaining,
        quantity: 1,
      });
    }
  }

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
  items: readonly FirstInvoiceItem[],
): { amount: number; notes: string } {
  const months = Math.max(0, Math.floor(input.discount_months ?? 0));
  const perMonth = Math.max(0, input.discount_amount_per_month ?? 0);
  if (months <= 0 || perMonth <= 0) return { amount: 0, notes: '' };
  const revenueSubtotal = items
    .filter((item) => item.accounting_class === "REVENUE")
    .reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
  const amount = Math.min(perMonth, Math.max(0, revenueSubtotal));
  if (amount <= 0) return { amount: 0, notes: '' };
  return {
    amount,
    notes: `Khuyến mãi HĐ — tháng 1/${months} × ${amount.toLocaleString('vi-VN')}đ`,
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
  const toMonth = parseYearMonth(to);
  if (!toMonth) return fromKey;
  const startMonthIndex = f.y * 12 + (f.m - 1);
  const endMonthIndex = toMonth.y * 12 + (toMonth.m - 1);
  for (let monthIndex = startMonthIndex; monthIndex <= endMonthIndex; monthIndex += 1) {
    const y = Math.floor(monthIndex / 12);
    const m = (monthIndex % 12) + 1;
    if (lastDayISO(y, m) > toDate) break; // tháng này chưa kết thúc trong kỳ
    if (firstDayISO(y, m) >= fromDate) result = `${y}-${pad2(m)}`; // phủ trọn
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
