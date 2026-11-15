// Số liệu hiển thị cho màn CỔ ĐÔNG TỰ XEM theo sổ tổng (E3 shareholder_profit_my_ledger_v1).
// Thuần, không gọi máy chủ. Chỉ dùng tiền của chính cổ đông; tỷ lệ % và số liệu toà nằm riêng
// ở `percent_rows` / `building_totals` và màn hình chỉ vẽ khi CÓ QUYỀN (máy chủ cũng bỏ khoá khi thiếu).

import type { MyLedgerMonth, MyLedgerPayout, MyProfitLedger } from './ledgerReaders';
import { sameMoney } from './readPrimitives';
import { profitLedgerRouteState } from './route';
import type { LedgerBalanceStatus } from './sharedReaders';

/** Năm của kỳ 'YYYY-MM-01'. */
export const periodYear = (period: string): number => Number(period.slice(0, 4));
/** Tháng (1..12) của kỳ 'YYYY-MM-01'. */
export const periodMonthNumber = (period: string): number => Number(period.slice(5, 7));
/** 'YYYY-MM-01' → 'MM/YYYY'. */
export const periodLabel = (period: string): string => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

/**
 * Công ty của dòng cổ đông đang đăng nhập (`useMyShareholder` đọc `select *`, có `organization_id`
 * dù kiểu `Shareholder` cũ chưa khai). E3 hỏi đúng công ty mình là cổ đông. Thiếu ⇒ null (màn báo lỗi,
 * không đoán công ty khác).
 */
export function shareholderOrganizationId(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const value = (row as { organization_id?: unknown }).organization_id;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Các năm có số liệu (kỳ chia, phiếu, lương, số toà) và năm hiện tại — mới trước. */
export function ledgerYears(ledger: MyProfitLedger, currentYear: number): number[] {
  const years = new Set<number>([currentYear]);
  for (const m of ledger.months) years.add(periodYear(m.period_month));
  for (const s of ledger.salary) years.add(periodYear(s.period_month));
  for (const p of ledger.payouts) if (p.voucher_date) years.add(periodYear(p.voucher_date));
  for (const t of ledger.building_totals ?? []) years.add(periodYear(t.period_month));
  return [...years].filter(Number.isFinite).sort((a, b) => b - a);
}

export interface SelfBalanceView {
  status: LedgerBalanceStatus;
  /** "Còn được nhận" (≥ 0) hoặc "Đang tạm ứng" (< 0). */
  label: string;
  /** Số dương để hiện. */
  amount: number;
  /** Dòng phụ ngắn. */
  note: string;
}

/** Số dư của chính mình theo sổ tổng, nói theo phía cổ đông. */
export function selfBalanceView(ledger: MyProfitLedger): SelfBalanceView {
  if (ledger.status === 'ADVANCE') {
    return { status: 'ADVANCE', label: 'Đang tạm ứng', amount: -ledger.balance, note: 'trừ dần vào lợi nhuận các tháng sau' };
  }
  if (ledger.status === 'SETTLED') {
    return { status: 'SETTLED', label: 'Còn được nhận', amount: 0, note: 'đã nhận đủ phần được chia' };
  }
  return {
    status: 'OWED',
    label: 'Còn được nhận',
    amount: ledger.balance,
    note: ledger.paid_pending > 0 ? 'đã trừ phiếu đang chờ duyệt' : 'chưa nhận',
  };
}

/**
 * Phần lợi nhuận đã đi qua phiếu lương, trừ phần lương giữ lại để bù tạm ứng (Y − D). Cùng dấu với
 * công thức số dư: được chia − đã nhận − chờ duyệt − (Y − D) = còn được nhận. null = không có dòng lương.
 */
export function salaryNet(ledger: MyProfitLedger): number | null {
  if (ledger.salary.length === 0 && sameMoney(ledger.paid_via_salary, 0) && sameMoney(ledger.advance_recovered, 0)) return null;
  return ledger.paid_via_salary - ledger.advance_recovered;
}

/** Khoá toà: id khi có, không thì tên (dòng cũ thiếu id). */
export function buildingKeyOf(b: { building_id: string | null; building_name: string | null }): string {
  return b.building_id ?? `ten:${b.building_name ?? ''}`;
}

const nameOf = (b: { building_name: string | null }) => b.building_name?.trim() || '—';

/** Kỳ chia trong năm (và tháng nếu chọn). */
export function monthsInScope(months: readonly MyLedgerMonth[], year: number, month: number | null): MyLedgerMonth[] {
  return months.filter((m) => periodYear(m.period_month) === year && (month === null || periodMonthNumber(m.period_month) === month));
}

/** 12 phần tử: được chia mỗi tháng của năm (null = tháng chưa có kỳ chốt). */
export function monthlyAmounts(months: readonly MyLedgerMonth[], year: number): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: 12 }, () => null);
  for (const m of monthsInScope(months, year, null)) {
    const i = periodMonthNumber(m.period_month) - 1;
    if (i >= 0 && i < 12) out[i] = (out[i] ?? 0) + m.amount;
  }
  return out;
}

export interface BuildingColumn {
  key: string;
  name: string;
}

/** Toà có phần chia trong phạm vi — xếp theo tên. */
export function buildingColumns(months: readonly MyLedgerMonth[]): BuildingColumn[] {
  const seen = new Map<string, string>();
  for (const m of months) for (const b of m.buildings) if (!seen.has(buildingKeyOf(b))) seen.set(buildingKeyOf(b), nameOf(b));
  return [...seen].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

/** Được chia theo toà trong phạm vi (bỏ toà bằng 0), lớn trước. */
export function amountsByBuilding(months: readonly MyLedgerMonth[]): { key: string; name: string; value: number }[] {
  const sums = new Map<string, { name: string; value: number }>();
  for (const m of months) {
    for (const b of m.buildings) {
      const key = buildingKeyOf(b);
      const cur = sums.get(key);
      sums.set(key, { name: cur?.name ?? nameOf(b), value: (cur?.value ?? 0) + b.amount });
    }
  }
  return [...sums].map(([key, v]) => ({ key, ...v })).filter((x) => !sameMoney(x.value, 0)).sort((a, b) => b.value - a.value);
}

export interface MatrixRow {
  period: string;
  month: number;
  /** Kỳ nằm trong mốc "đã trả đủ": không tính vào số còn được nhận. */
  excluded: boolean;
  /** Theo thứ tự `columns`; null = toà không có phần chia tháng đó. */
  cells: (number | null)[];
  total: number;
}

/** Ma trận Nhà × Tháng của phạm vi đang xem. */
export function buildingMatrix(months: readonly MyLedgerMonth[], columns: readonly BuildingColumn[]): MatrixRow[] {
  const byPeriod = new Map<string, MyLedgerMonth[]>();
  for (const m of months) byPeriod.set(m.period_month, [...(byPeriod.get(m.period_month) ?? []), m]);
  return [...byPeriod.keys()].sort().map((period) => {
    const rows = byPeriod.get(period) ?? [];
    const cells = columns.map((c) => {
      const hits = rows.flatMap((r) => r.buildings).filter((b) => buildingKeyOf(b) === c.key);
      return hits.length ? hits.reduce((s, b) => s + b.amount, 0) : null;
    });
    return {
      period,
      month: periodMonthNumber(period),
      excluded: rows.some((r) => r.excluded_by_marker),
      cells,
      total: rows.reduce((s, r) => s + r.amount, 0),
    };
  });
}

/** Trạng thái phiếu nói cho cổ đông (không lộ mã trạng thái kỹ thuật). */
export function payoutStatusLabel(payout: Pick<MyLedgerPayout, 'status' | 'posting_status'>): string {
  if (payout.status === 'UNAPPROVED') return 'Chờ duyệt';
  if (payout.status !== 'APPROVED') return 'Đang xử lý';
  return payout.posting_status === 'POSTED' ? 'Đã chi' : 'Đã duyệt, chưa chi';
}

/** Phiếu mới trước (E3 trả theo thứ tự vào sổ). */
export function newestFirst<T>(rows: readonly T[]): T[] {
  return [...rows].reverse();
}

/**
 * Nút "Chi tạm ứng cho tôi": chỉ mở khi sổ tổng chạy thật (CANONICAL). Trả câu giải thích khi khoá,
 * null khi mở. Máy chủ (E5) vẫn là chốt cuối.
 */
export function selfAdvanceBlockedNote(route: unknown): string | null {
  const state = profitLedgerRouteState(route);
  if (state.canPayShareholder) return null;
  if (state.route === 'FROZEN') return 'Sổ lợi nhuận đang tạm khoá — chưa chi tạm ứng được.';
  if (state.route === 'SHADOW') return 'Chủ công ty đang đối chiếu sổ lợi nhuận — chưa mở chi tạm ứng.';
  return 'Chưa mở chi tạm ứng lợi nhuận.';
}
