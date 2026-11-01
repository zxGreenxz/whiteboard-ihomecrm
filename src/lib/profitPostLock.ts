// =============================================================================
// profitPostLock — tháng đã chốt lợi nhuận khoá cả phiếu có KỲ trong tháng đó, và khoản
// "phát sinh sau chốt" (rà 21/10, F06; chủ chốt 22/10/2026: "chặn hẳn", Báo cáo LN tháng
// đã chốt không cộng khoản sau chốt mà BÁO LÊN).
//
// Hàng rào thật ở máy chủ (migration 20261022172918: trigger khoá tháng xét cả tháng KQKD
// theo kỳ). Nguồn số: RPC public.profit_post_lock_vouchers_v1 — xếp tháng theo đúng luật
// KQKD (fa_accrual_allocations). File này chỉ:
//   - đọc gói RPC (zod — sai hình thì ném, không đoán số);
//   - tách khoản phát sinh sau chốt khỏi danh sách / tổng của Báo cáo LN và trừ đúng phần
//     đó phía engine cho thanh kiểm chứng;
//   - chữ chip / cảnh báo / nhãn tab Chốt LN;
//   - quyết định lỗi đỏ trong form phiếu TRƯỚC khi lưu (luật xếp tháng chép từ
//     fa_accrual_allocations, test so từng nhánh). Máy chủ vẫn là hàng rào.
// Hàm thuần, không gọi mạng, không React.
// =============================================================================

import { z } from 'zod';

const money = z.number().finite();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

export const postLockVoucherSchema = z.object({
  voucher_id: z.string().uuid(),
  building_id: z.string().uuid(),
  building_name: z.string().nullable(),
  /** Tháng đã chốt mà phiếu đóng góp ('YYYY-MM-01'). */
  month: isoDate,
  /** Thời điểm chốt của toà×tháng đó. */
  locked_at: z.string(),
  /** null khi phiếu có hạng mục hạn chế mà người xem không được xem (`restricted`). */
  code: z.string().nullable(),
  name: z.string().nullable(),
  restricted: z.boolean(),
  voucher_date: isoDate,
  type: z.enum(['INCOME', 'EXPENSE']),
  /** Tháng hoá đơn 'YYYY-MM' khi phiếu gắn hoá đơn (thu tiền hoá đơn tháng đã chốt). */
  invoice_month: z.string().nullable(),
  /** Kỳ hạng mục (ngày đầu nhỏ nhất – ngày cuối lớn nhất); null khi không hạng mục nào có kỳ. */
  period_from: isoDate.nullable(),
  period_to: isoDate.nullable(),
  /** Phần thu / chi THUỘC THÁNG `month` (không phải cả phiếu). */
  income: money,
  expense: money,
  created_at: z.string(),
  approved_at: z.string().nullable(),
});
export type PostLockVoucher = z.infer<typeof postLockVoucherSchema>;

export const profitPostLockSchema = z.object({
  from: isoDate,
  to: isoDate,
  /** Toà×tháng ĐÃ CHỐT trong khoảng (chỉ toà người xem được phép). */
  locked: z.array(
    z.object({
      building_id: z.string().uuid(),
      building_name: z.string().nullable(),
      month: isoDate,
      locked_at: z.string(),
    }),
  ),
  /** Phiếu đã duyệt, tạo/duyệt SAU khi chốt — số chốt không có chúng. */
  after_lock: z.array(postLockVoucherSchema),
});
export type ProfitPostLockData = z.infer<typeof profitPostLockSchema>;

const ym = (iso: string): string => iso.slice(0, 7);
const mmYyyy = (m: string): string => `${m.slice(5, 7)}/${m.slice(0, 4)}`;
const vnd = (n: number): string => `${Math.round(Math.abs(n)).toLocaleString('vi-VN')} ₫`;

/** Câu hướng dẫn chung (chip, thanh kiểm chứng, tab Chốt LN). */
export const POST_LOCK_HOW_TO_ADD = 'Muốn cộng: mở khoá tháng ở tab Chốt LN rồi chốt lại';

// ─────────────────────────────── Báo cáo LN ───────────────────────────────

/** Các khoản phát sinh sau chốt của đúng tháng `month` ('YYYY-MM' hoặc 'YYYY-MM-DD') và tập toà. */
export function postLockEntriesFor(
  data: ProfitPostLockData | null | undefined,
  month: string,
  buildingIds?: readonly string[] | null,
): PostLockVoucher[] {
  if (!data) return [];
  const m = ym(month);
  const ids = buildingIds ? new Set(buildingIds) : null;
  return data.after_lock.filter((v) => ym(v.month) === m && (ids === null || ids.has(v.building_id)));
}

const entryKey = (voucherId: string, buildingId: string | null | undefined): string => `${voucherId}|${buildingId ?? ''}`;

/** Dòng báo cáo dồn tích tối thiểu (tập con AccrualReportRow). */
export interface PostLockRowLike {
  voucherId: string;
  buildingId: string | null;
  income: number;
  expense: number;
  approvalStatus?: string | null;
}

/** Kết quả báo cáo dồn tích tối thiểu (tập con AccrualReportResult). */
export interface PostLockAccrualLike<R extends PostLockRowLike> {
  totalIncome: number;
  totalExpense: number;
  difference: number;
  rows: R[];
  pendingIncome: number;
  pendingExpense: number;
  pendingCount: number;
}

export interface PostLockSplit<R extends PostLockRowLike, A extends PostLockAccrualLike<R>> {
  /** Báo cáo tháng đã trừ khoản phát sinh sau chốt (tổng tính lại từ dòng còn lại). */
  accrual: A;
  /** Dòng bị tách ra (không cộng vào tháng đã chốt). */
  excludedRows: R[];
  /** Khoản (phiếu) của RPC mà trang đang thấy dòng — để liệt kê. */
  entries: PostLockVoucher[];
  count: number;
  income: number;
  expense: number;
}

/**
 * Tách khoản phát sinh sau chốt khỏi báo cáo một tháng: dòng của (phiếu, toà) có trong
 * `entries` (đã lọc đúng tháng) bị bỏ khỏi danh sách và tổng. Tổng / phần chờ duyệt tính
 * lại từ dòng còn lại ⇒ tổng mới = tổng cũ − phần tách ra.
 */
export function splitPostLock<R extends PostLockRowLike, A extends PostLockAccrualLike<R>>(
  accrual: A,
  entries: readonly PostLockVoucher[],
): PostLockSplit<R, A> {
  if (entries.length === 0) {
    return { accrual, excludedRows: [], entries: [], count: 0, income: 0, expense: 0 };
  }
  const keys = new Set(entries.map((e) => entryKey(e.voucher_id, e.building_id)));
  const kept: R[] = [];
  const excludedRows: R[] = [];
  for (const r of accrual.rows) {
    if (r.approvalStatus !== 'UNAPPROVED' && keys.has(entryKey(r.voucherId, r.buildingId))) excludedRows.push(r);
    else kept.push(r);
  }
  if (excludedRows.length === 0) {
    return { accrual, excludedRows: [], entries: [], count: 0, income: 0, expense: 0 };
  }
  let totalIncome = 0;
  let totalExpense = 0;
  let pendingIncome = 0;
  let pendingExpense = 0;
  const pending = new Set<string>();
  for (const r of kept) {
    totalIncome += r.income;
    totalExpense += r.expense;
    if (r.approvalStatus === 'UNAPPROVED') {
      pendingIncome += r.income;
      pendingExpense += r.expense;
      pending.add(r.voucherId);
    }
  }
  const seen = new Set(excludedRows.map((r) => entryKey(r.voucherId, r.buildingId)));
  const shown = entries.filter((e) => seen.has(entryKey(e.voucher_id, e.building_id)));
  return {
    accrual: {
      ...accrual,
      rows: kept,
      totalIncome,
      totalExpense,
      difference: totalIncome - totalExpense,
      pendingIncome,
      pendingExpense,
      pendingCount: pending.size,
    },
    excludedRows,
    entries: shown,
    count: shown.length,
    income: excludedRows.reduce((s, r) => s + r.income, 0),
    expense: excludedRows.reduce((s, r) => s + r.expense, 0),
  };
}

export interface EngineExclusions {
  count: number;
  income: number;
  expense: number;
  byBuilding: ReadonlyMap<string, { income: number; expense: number }>;
}

export const NO_ENGINE_EXCLUSIONS: EngineExclusions = { count: 0, income: 0, expense: 0, byBuilding: new Map() };

/** Phần engine (fa_*) vẫn tính nhưng trang không cộng: đúng số RPC (cùng nguồn fa_accrual_allocations). */
export function engineExclusionsOf(entries: readonly PostLockVoucher[]): EngineExclusions {
  if (entries.length === 0) return NO_ENGINE_EXCLUSIONS;
  const byBuilding = new Map<string, { income: number; expense: number }>();
  let income = 0;
  let expense = 0;
  for (const e of entries) {
    income += e.income;
    expense += e.expense;
    const cur = byBuilding.get(e.building_id) ?? { income: 0, expense: 0 };
    byBuilding.set(e.building_id, { income: cur.income + e.income, expense: cur.expense + e.expense });
  }
  return { count: entries.length, income, expense, byBuilding };
}

/** Số engine trừ phần phát sinh sau chốt — để thanh kiểm chứng không báo LỆCH giả. */
export function subtractEngineExclusions<
  F extends { income: number; expense: number; byBuilding: ReadonlyMap<string, { name: string; income: number; expense: number }> },
>(fa: F, ex: EngineExclusions): F {
  if (ex.count === 0) return fa;
  const byBuilding = new Map(fa.byBuilding);
  for (const [id, x] of ex.byBuilding) {
    const cur = byBuilding.get(id);
    if (!cur) continue;
    byBuilding.set(id, { ...cur, income: cur.income - x.income, expense: cur.expense - x.expense });
  }
  return { ...fa, income: fa.income - ex.income, expense: fa.expense - ex.expense, byBuilding };
}

/** "Phát sinh sau chốt — chưa cộng vào tháng đã chốt: N khoản · thu X · chi Y"; null khi không có. */
export function postLockChipText(
  s: { count: number; income: number; expense: number },
  fmt: (n: number) => string,
): string | null {
  if (s.count <= 0) return null;
  return `Phát sinh sau chốt — chưa cộng vào tháng đã chốt: ${s.count} khoản · thu ${fmt(s.income)} · chi ${fmt(s.expense)}`;
}

/** Câu cảnh báo cho thanh kiểm chứng (đẩy thanh lên "cần xem lại"). */
export function postLockWarnings(s: { count: number; income: number; expense: number }): string[] {
  if (s.count <= 0) return [];
  return [
    `${s.count} khoản phát sinh sau chốt (thu ${vnd(s.income)} · chi ${vnd(s.expense)}) chưa cộng vào tháng đã chốt — ${POST_LOCK_HOW_TO_ADD}.`,
  ];
}

const dm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Vì sao khoản này thuộc tháng đã chốt: "Thu tiền hoá đơn 08/2025" / "Kỳ 01/08/2025–31/08/2025". */
export function postLockReason(v: PostLockVoucher): string {
  if (v.invoice_month && /^\d{4}-\d{2}$/.test(v.invoice_month)) {
    return `${v.type === 'INCOME' ? 'Thu tiền' : 'Chi theo'} hoá đơn ${v.invoice_month.slice(5, 7)}/${v.invoice_month.slice(0, 4)}`;
  }
  if (v.period_from && v.period_to) return `Kỳ ${dm(v.period_from)}–${dm(v.period_to)}`;
  return `Ngày phiếu ${dm(v.voucher_date)}`;
}

// ─────────────────────────────── Tab Chốt LN ───────────────────────────────

export interface PostLockCell {
  count: number;
  income: number;
  expense: number;
}

/** Khoá ô toà×tháng: `${building_id}|YYYY-MM`. */
export const postLockCellKey = (buildingId: string, month: string): string => `${buildingId}|${ym(month)}`;

/** Gom theo toà×tháng cho tab Chốt LN. */
export function postLockByBuildingMonth(data: ProfitPostLockData | null | undefined): ReadonlyMap<string, PostLockCell> {
  const out = new Map<string, PostLockCell>();
  if (!data) return out;
  for (const v of data.after_lock) {
    const key = postLockCellKey(v.building_id, v.month);
    const c = out.get(key) ?? { count: 0, income: 0, expense: 0 };
    out.set(key, { count: c.count + 1, income: c.income + v.income, expense: c.expense + v.expense });
  }
  return out;
}

/** Nhãn ô toà×tháng ở tab Chốt LN; null khi ô không có gì để báo. */
export function postLockLockTabLabel(c: PostLockCell | null | undefined): string | null {
  if (!c || c.count <= 0) return null;
  return `${c.count} khoản phát sinh sau chốt (chưa cộng)`;
}

// ─────────────────────────────── form phiếu ───────────────────────────────

export interface PostLockFormItem {
  /** 'YYYY-MM-DD' hoặc rỗng/null khi hạng mục không ghi kỳ. */
  startDate: string | null | undefined;
  endDate: string | null | undefined;
  /** Dòng tính KQKD theo mặc định (không phải cọc / chuyển nội bộ). */
  countsInPnl: boolean;
}

export interface PostLockFormInput {
  /** 'YYYY-MM-DD' */
  voucherDate: string | null | undefined;
  /** 'YYYY-MM' — phiếu gắn hoá đơn ⇒ cả phiếu vào tháng hoá đơn. */
  invoiceMonth?: string | null;
  /** Phiếu gắn hoá đơn mà form không biết tháng hoá đơn ⇒ không tự xếp tháng KQKD (máy chủ quyết). */
  hasInvoice?: boolean;
  /** Công tắc KQKD của phiếu: false ⇒ không vào KQKD; true ⇒ mọi dòng vào KQKD; null ⇒ theo dòng. */
  businessResultAccounting?: boolean | null;
  items: readonly PostLockFormItem[];
}

const DAY = /^(\d{4})-(\d{2})-\d{2}/;
const monthOf = (iso: string | null | undefined): string | null => {
  const m = DAY.exec(iso ?? '');
  return m ? `${m[1]}-${m[2]}-01` : null;
};
const monthIndex = (m: string): number => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthFromIndex = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`;
const invoiceMonthOf = (s: string | null | undefined): string | null => {
  const m = /^(\d{4})-(\d{2})$/.exec(s ?? '');
  return m ? `${m[1]}-${m[2]}-01` : null;
};

/**
 * Các tháng ('YYYY-MM-01', tăng dần, không trùng) mà phiếu sẽ đóng góp vào KQKD — chép luật
 * fa_accrual_allocations: hoá đơn ⇒ tháng hoá đơn; phiếu không dòng ⇒ tháng ngày phiếu; dòng
 * có đủ kỳ ⇒ mọi tháng của kỳ (kỳ ngược ⇒ tháng bắt đầu); dòng thiếu kỳ ⇒ tháng ngày phiếu;
 * dòng không tính KQKD (cọc, nội bộ) bỏ trừ khi công tắc KQKD bật; công tắc tắt ⇒ không tháng nào.
 */
export function voucherProfitMonths(input: PostLockFormInput): string[] {
  if (input.businessResultAccounting === false) return [];
  const out = new Set<string>();
  const inv = invoiceMonthOf(input.invoiceMonth);
  const voucherMonth = monthOf(input.voucherDate);
  const force = input.businessResultAccounting === true;
  if (input.items.length === 0) {
    const m = inv ?? voucherMonth;
    if (m) out.add(m);
    return [...out];
  }
  for (const it of input.items) {
    if (!it.countsInPnl && !force) continue;
    if (inv) {
      out.add(inv);
      continue;
    }
    const s = monthOf(it.startDate);
    const e = monthOf(it.endDate);
    if (s && e) {
      const a = monthIndex(s);
      const b = monthIndex(e);
      // kỳ ngược ⇒ tháng bắt đầu; kỳ quá dài thì chỉ cần đủ để soi (tối đa 36 tháng)
      if ((it.endDate ?? '') < (it.startDate ?? '')) out.add(s);
      else for (let i = a; i <= Math.min(b, a + 35); i++) out.add(monthFromIndex(i));
    } else if (voucherMonth) {
      out.add(voucherMonth);
    }
  }
  return [...out].sort();
}

/** Mọi tháng cần biết đã chốt chưa để quyết định cho form (ngày phiếu + tháng KQKD + tháng hoá đơn). */
export function postLockFormMonths(...inputs: readonly (PostLockFormInput | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const input of inputs) {
    if (!input) continue;
    const d = monthOf(input.voucherDate);
    if (d) out.add(d);
    const inv = invoiceMonthOf(input.invoiceMonth);
    if (inv) out.add(inv);
    if (!inv && !input.hasInvoice) for (const m of voucherProfitMonths(input)) out.add(m);
  }
  return [...out].sort();
}

/** Khoảng tháng cần hỏi server cho form ('YYYY-MM-01'); null khi chưa có tháng nào / quá 36 tháng. */
export function postLockQueryRange(months: readonly string[]): { from: string; to: string } | null {
  if (months.length === 0) return null;
  const sorted = [...months].sort();
  const from = sorted[0]!;
  const to = sorted[sorted.length - 1]!;
  if (monthIndex(to) - monthIndex(from) > 35) return null;
  return { from, to };
}

/** Câu lỗi form — trùng từng chữ câu máy chủ (bỏ tiền tố [PROFIT_LOCKED]). */
export function profitPeriodLockedMessage(month: string, buildingName: string | null | undefined): string {
  return (
    `Tháng ${mmYyyy(month)} của toà ${buildingName?.trim() || '(không rõ tên)'} đã chốt lợi nhuận — ` +
    'không ghi được phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN.'
  );
}

export type PostLockFormBlock =
  | { kind: 'NONE' }
  | { kind: 'BLOCKED'; month: string; message: string };

/** Một bản của phiếu (đang nhập / đang lưu) cùng các tháng ĐÃ CHỐT ('YYYY-MM-01') của toà của nó. */
export interface PostLockFormSide {
  input: PostLockFormInput;
  lockedMonths: ReadonlySet<string>;
  buildingName?: string | null;
  /**
   * Bản này có tính KQKD theo kỳ không (máy chủ: bản mới đã duyệt / chờ duyệt; bản cũ chỉ khi
   * đã duyệt). false ⇒ chỉ xét ngày phiếu. Mặc định true.
   */
  periodCounts?: boolean;
}

/**
 * Lỗi đỏ trong form phiếu — cùng luật trigger máy chủ. Chặn khi:
 *   - ngày phiếu thuộc tháng đã chốt (khoá theo ngày phiếu — mọi loại phiếu);
 *   - phiếu KHÔNG theo hoá đơn có tháng KQKD theo kỳ rơi vào tháng đã chốt;
 *   - SỬA phiếu theo hoá đơn mà tháng hoá đơn đã chốt (cửa sửa/huỷ phía máy chủ).
 * Lập / duyệt phiếu thu tiền hoá đơn của tháng đã chốt (thu mới nợ cũ) KHÔNG bị chặn.
 * `original` = bản đang lưu khi sửa phiếu: phần cũ rời tháng đã chốt cũng bị chặn.
 */
export function postLockFormBlock(opts: {
  current: PostLockFormSide;
  original?: PostLockFormSide | null;
  isEdit?: boolean;
}): PostLockFormBlock {
  const { current, original, isEdit = false } = opts;
  const hits: { month: string; buildingName: string | null | undefined }[] = [];
  const scan = (side: PostLockFormSide) => {
    const { input: v, lockedMonths } = side;
    if (lockedMonths.size === 0) return;
    const hit = (m: string) => hits.push({ month: m, buildingName: side.buildingName });
    const d = monthOf(v.voucherDate);
    if (d && lockedMonths.has(d)) hit(d);
    if (side.periodCounts === false) return;
    const inv = invoiceMonthOf(v.invoiceMonth);
    if (inv) {
      if (isEdit && lockedMonths.has(inv)) hit(inv);
      return;
    }
    if (v.hasInvoice) return;
    for (const m of voucherProfitMonths(v)) if (lockedMonths.has(m)) hit(m);
  };
  scan(current);
  if (original) scan(original);
  if (hits.length === 0) return { kind: 'NONE' };
  const first = [...hits].sort((a, b) => a.month.localeCompare(b.month))[0]!;
  return { kind: 'BLOCKED', month: first.month, message: profitPeriodLockedMessage(first.month, first.buildingName) };
}

/** Tập tháng đã chốt ('YYYY-MM-01') của một toà từ gói RPC. */
export function lockedMonthsOf(data: ProfitPostLockData | null | undefined, buildingId: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!data || !buildingId) return out;
  for (const l of data.locked) if (l.building_id === buildingId) out.add(`${ym(l.month)}-01`);
  return out;
}

/** Tên toà theo gói RPC (khi form chưa có tên). */
export function lockedBuildingNameOf(data: ProfitPostLockData | null | undefined, buildingId: string | null | undefined): string | null {
  if (!data || !buildingId) return null;
  return data.locked.find((l) => l.building_id === buildingId)?.building_name ?? null;
}
