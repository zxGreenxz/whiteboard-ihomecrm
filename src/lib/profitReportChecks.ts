// =============================================================================
// profitReportChecks.ts — BỘ DÒ dùng chung của Báo cáo Lợi Nhuận (desktop + mobile).
//
// Mục đích: trang không được "ẩn/mất" chi phí hay doanh thu mà không ai thấy. Hàm
// thuần (không gọi mạng, không React) — trang truyền dữ liệu đã tải vào, nhận về
// danh sách cảnh báo để hiện chip + phần mở rộng (ProfitReportChecks.tsx).
//
// 1. CHI CỐ ĐỊNH theo TOÀ × KHOẢN (F13, rà 21/10): quét MỌI toà trong phạm vi —
//    không chỉ khi lọc đúng 1 toà như bộ dò cũ — và so SỐ TIỀN với mức đã khai ở
//    "Phí cố định theo toà" (building_fee_accounts.default_amount, mức MỖI KỲ):
//      MISSING            — tháng này chưa có đồng nào;
//      SHORT              — có nhưng < 70% mức (vd 70/132tr);
//      POSSIBLE_DUPLICATE — > 130% mức (phiếu tự lập + phiếu lập tay cùng kỳ), hoặc
//                           chưa khai mức mà có ≥2 phiếu cùng số tiền;
//      OK                 — còn lại (kể cả có phiếu mà chưa khai mức).
//    Số "đã có" = phần chi PHÂN BỔ VÀO THÁNG của các dòng `useAccrualMonthReport`
//    (phiếu đã duyệt + chờ duyệt, đúng như tổng trang đang cộng), bỏ dòng ngoài KQKD.
//
//    Khớp dòng ↔ khoản: MIRROR SQL `app_private.landlord_missing_fixed_v1` /
//    `public.fee_type_matches` — hạng mục đã gắn khoá `income_expense_types.
//    fee_category` là nguồn đúng; khớp theo TÊN (feeTypeMatches) chỉ khi công ty
//    CHƯA gắn khoá nào cho khoản đó (tránh "Mua tủ lạnh" nhóm Điện bị coi là đã trả
//    tiền điện). Dòng không có hạng mục ("Không có hạng mục") được dò thêm theo tên
//    phiếu như expenseRankOf — cũng chỉ khi khoản đó chưa gắn khoá.
//
//    "Không áp dụng": nguồn duy nhất là `buildings.hidden_fixed_expenses` (cột
//    building_fee_accounts.not_applicable đã bỏ dùng — get_fee_config_matrix_v1
//    trả `not_applicable` đọc từ chính mảng này). Thang máy chỉ đòi khi toà bật
//    has_elevator. Bỏ qua toà ảo, toà INACTIVE và — với Tiền nhà — các toà trong
//    `skipRentBuildingIds` (toà vận hành cho chủ nhà: iHome không trả tiền nhà).
//
// 2. PHIẾU CHỜ DUYỆT ĐÃ LÂU (F17): phiếu UNAPPROVED đang nằm trong tổng tháng mà
//    ngày phiếu cũ hơn N ngày (mặc định 30) so với hôm nay.
//
// 3. TÓM TẮT GHI CHÚ PHÒNG (F14/F45/F46): đếm từ kết quả useVacantRoomNotes —
//    phòng trống (mọi ghi chú 'vacant', kể cả phòng có dòng thanh lý/bỏ cọc),
//    phòng chưa có hoá đơn / có hoá đơn chưa thu, HĐ kết thúc chưa thanh lý.
//
// Số tiền ở đây là dữ liệu chạy lúc xem; file không chứa số liệu thật nào.
// =============================================================================

import type { AccrualReportRow } from '@/hooks/useAccrualReport';
import type { VacantRoomNote } from '@/hooks/reports/types';
import { feeTypeMatches } from '@/lib/feeCategories';

/** 9 khoản chi cố định theo toà — CÙNG khoá/thứ tự với FEE_KINDS (useFeeConfigMatrix),
 *  FIXED_EXPENSE_CATEGORIES và GRID_SERVER_KEYS (test đối chiếu ở profitReportChecks.test.ts). */
export const FIXED_FEE_KINDS = [
  { key: 'tien_nha', label: 'Tiền nhà' },
  { key: 'dien', label: 'Tiền điện' },
  { key: 'nuoc', label: 'Tiền nước' },
  { key: 'internet', label: 'Internet' },
  { key: 'quan_ly', label: 'Quản lý' },
  { key: 've_sinh', label: 'Vệ sinh' },
  { key: 'cong_an', label: 'Công an' },
  { key: 'rac', label: 'Rác' },
  { key: 'thang_may', label: 'Thang máy' },
] as const;

export type FixedFeeKey = (typeof FIXED_FEE_KINDS)[number]['key'];

const FIXED_FEE_KEYS: readonly FixedFeeKey[] = FIXED_FEE_KINDS.map((k) => k.key);
const FIXED_FEE_LABEL: Readonly<Record<FixedFeeKey, string>> = Object.fromEntries(
  FIXED_FEE_KINDS.map((k) => [k.key, k.label]),
) as Record<FixedFeeKey, string>;

export const isFixedFeeKey = (v: unknown): v is FixedFeeKey =>
  typeof v === 'string' && (FIXED_FEE_KEYS as readonly string[]).includes(v);

/** Ngưỡng mặc định (đợt rà 21/10): < 70% mức = thiếu số, > 130% mức = có thể trùng. */
export const DEFAULT_SHORT_RATIO = 0.7;
export const DEFAULT_OVER_RATIO = 1.3;
/** Phiếu chờ duyệt có ngày phiếu cũ hơn số ngày này (so với hôm nay) là "chờ lâu". */
export const DEFAULT_STALE_PENDING_DAYS = 30;

// ───────────────────────────── đầu vào ─────────────────────────────

/** Các trường của một dòng `useAccrualMonthReport` mà bộ dò đọc. */
export type ProfitCheckRow = Pick<
  AccrualReportRow,
  | 'voucherId'
  | 'voucherName'
  | 'buildingId'
  | 'buildingName'
  | 'voucherDate'
  | 'typeId'
  | 'typeName'
  | 'category'
  | 'income'
  | 'expense'
  | 'countsInBusinessResult'
  | 'approvalStatus'
>;

/** Toà (từ useBuildings({ includeVirtual: true }) — dùng nguyên object). */
export interface ProfitCheckBuilding {
  id: string;
  name?: string | null;
  is_virtual?: boolean | null;
  has_elevator?: boolean | null;
  /** Khoản "không áp dụng" của toà — NGUỒN DUY NHẤT của cờ không áp dụng. */
  hidden_fixed_expenses?: readonly string[] | null;
  /** 'ACTIVE' | 'INACTIVE' — toà ngừng hoạt động không bị đòi chi cố định. */
  status?: string | null;
}

/** Một ô cấu hình phí (FeeConfigCell của useFeeConfigMatrix là đủ trường). */
export interface ProfitCheckFeeRate {
  buildingId: string;
  feeCategory: string;
  /** Mức MỖI KỲ (tháng); null/≤0 = chưa khai mức ⇒ chỉ kiểm có/không. */
  defaultAmount: number | null;
  /** get_fee_config_matrix_v1 đọc từ buildings.hidden_fixed_expenses. */
  notApplicable?: boolean;
}

/** Hạng mục chi (useIncomeExpenseTypes('expense')) — chỉ cần id + khoá phí. */
export interface ProfitCheckExpenseType {
  id: string;
  fee_category?: string | null;
}

export interface ProfitReportChecksOptions {
  shortRatio?: number;
  overRatio?: number;
  stalePendingDays?: number;
}

export interface ProfitReportChecksInput {
  /** accrual.rows của useAccrualMonthReport (chế độ dồn tích). */
  rows: readonly ProfitCheckRow[];
  buildings: readonly ProfitCheckBuilding[];
  /** useFeeConfigMatrix().data — thiếu thì mọi khoản coi như chưa khai mức. */
  feeRates?: readonly ProfitCheckFeeRate[] | null;
  /** useIncomeExpenseTypes('expense').data — thiếu thì khớp theo tên cho mọi khoản. */
  expenseTypes?: readonly ProfitCheckExpenseType[] | null;
  /** Toà đang lọc trên trang; rỗng/null = mọi toà trong `buildings`. */
  scopeBuildingIds?: readonly string[] | null;
  /** Toà KHÔNG phải trả tiền nhà (toà vận hành cho chủ nhà) ⇒ không báo thiếu Tiền nhà. */
  skipRentBuildingIds?: Iterable<string> | null;
  /** Hôm nay 'YYYY-MM-DD' (truyền vào để hàm thuần, test được). */
  today: string;
  options?: ProfitReportChecksOptions;
}

// ───────────────────────────── đầu ra ─────────────────────────────

export type FixedFeeStatus = 'MISSING' | 'SHORT' | 'POSSIBLE_DUPLICATE' | 'OK';

export interface FixedFeeVoucher {
  voucherId: string;
  voucherName: string;
  voucherDate: string | null;
  /** Phần chi của phiếu phân bổ vào tháng đang xem. */
  amount: number;
  pending: boolean;
}

export interface FixedFeeCell {
  buildingId: string;
  buildingName: string;
  key: FixedFeeKey;
  label: string;
  status: FixedFeeStatus;
  /** Mức mỗi kỳ đã khai (> 0); null = chưa khai mức. */
  expected: number | null;
  /** Đã có trong tháng (đã duyệt + chờ duyệt). */
  actual: number;
  /** Phần của `actual` còn chờ duyệt. */
  pendingAmount: number;
  /** MISSING/SHORT có mức: số còn thiếu; POSSIBLE_DUPLICATE có mức: số vượt; còn lại 0. */
  gap: number;
  /** actual / expected (null khi chưa khai mức). */
  ratio: number | null;
  /** Lý do nghi trùng — chỉ có khi status = POSSIBLE_DUPLICATE. */
  duplicateReason?: 'OVER_RATE' | 'SAME_AMOUNT';
  vouchers: FixedFeeVoucher[];
}

export interface FixedFeeChecks {
  /** Mọi ô đã kiểm (kể cả OK), theo toà rồi thứ tự khoản. */
  cells: FixedFeeCell[];
  /** Ô có vấn đề (≠ OK), cùng thứ tự. */
  issues: FixedFeeCell[];
  checkedBuildingCount: number;
  /** Toà có ≥1 khoản MISSING hoặc SHORT. */
  missingBuildingCount: number;
  /** Toà có ≥1 khoản POSSIBLE_DUPLICATE. */
  duplicateBuildingCount: number;
  missingCount: number;
  shortCount: number;
  duplicateCount: number;
  /** MISSING mà toà chưa khai mức cho khoản đó (không ước được số tiền). */
  unpricedMissingCount: number;
  /** Σ gap của MISSING + SHORT có mức ≈ chi phí đang thiếu ⇒ lợi nhuận có thể cao hơn thật. */
  missingAmount: number;
  /** Σ gap của POSSIBLE_DUPLICATE có mức ≈ chi phí có thể bị cộng trùng. */
  excessAmount: number;
}

export interface StalePendingVoucher {
  voucherId: string;
  voucherName: string;
  buildingId: string | null;
  buildingName: string | null;
  voucherDate: string;
  ageDays: number;
  /** Phần thu / chi của phiếu đang nằm trong tổng tháng. */
  income: number;
  expense: number;
}

export interface StalePendingChecks {
  thresholdDays: number;
  /** Cũ nhất trước. */
  vouchers: StalePendingVoucher[];
  count: number;
  income: number;
  expense: number;
}

export interface ProfitReportChecksResult {
  fixedFees: FixedFeeChecks;
  stalePending: StalePendingChecks;
  /** true khi có bất kỳ cảnh báo nào (để trang không hiện "khớp" màu xanh). */
  hasWarnings: boolean;
}

// ───────────────────────────── khớp khoản ─────────────────────────────

export interface FeeKeyContext {
  /** typeId → fee_category của hạng mục (null = hạng mục chưa gắn khoá). */
  feeCategoryByTypeId: ReadonlyMap<string, string | null>;
  /** Khoản mà công ty ĐÃ gắn cho ít nhất một hạng mục ⇒ tắt khớp theo tên. */
  mappedKeys: ReadonlySet<string>;
}

export const buildFeeKeyContext = (
  expenseTypes: readonly ProfitCheckExpenseType[] | null | undefined,
): FeeKeyContext => {
  const feeCategoryByTypeId = new Map<string, string | null>();
  const mappedKeys = new Set<string>();
  for (const t of expenseTypes ?? []) {
    const fc = t.fee_category ?? null;
    feeCategoryByTypeId.set(t.id, fc);
    if (fc) mappedKeys.add(fc);
  }
  return { feeCategoryByTypeId, mappedKeys };
};

/**
 * Khoản chi cố định của một dòng, hoặc null nếu không thuộc khoản nào.
 * Hạng mục đã gắn khoá ⇒ đúng khoá đó (khớp tên bị bỏ qua). Hạng mục chưa gắn khoá
 * (hoặc không có trong danh sách) ⇒ khớp theo tên, nhưng chỉ cho khoản mà công ty
 * chưa gắn khoá. Khớp nhiều khoản ⇒ lấy khoản đứng trước (thứ tự FIXED_FEE_KINDS).
 */
export const resolveFixedFeeKey = (
  row: Pick<ProfitCheckRow, 'typeId' | 'typeName' | 'category' | 'voucherName'>,
  ctx: FeeKeyContext,
): FixedFeeKey | null => {
  const fc = row.typeId != null ? ctx.feeCategoryByTypeId.get(row.typeId) ?? null : null;
  if (fc != null) return isFixedFeeKey(fc) ? fc : null;
  for (const key of FIXED_FEE_KEYS) {
    if (ctx.mappedKeys.has(key)) continue;
    if (feeTypeMatches(key, row.category, row.typeName)) return key;
    // Phiếu không có hạng mục: tên phiếu là nguồn duy nhất (vd "Tiền nhà (tự động lập)").
    if (row.typeId == null && feeTypeMatches(key, null, row.voucherName)) return key;
  }
  return null;
};

/**
 * Xếp loại một ô toà × khoản. `vouchers` chỉ dùng cho luật "cùng số tiền" khi chưa
 * khai mức. Ngưỡng so sánh nghiêm ngặt: đúng 70% hay đúng 130% vẫn là OK.
 */
export const classifyFixedFee = (
  actual: number,
  expected: number | null,
  vouchers: readonly Pick<FixedFeeVoucher, 'voucherId' | 'amount'>[],
  opts: { shortRatio?: number; overRatio?: number } = {},
): { status: FixedFeeStatus; gap: number; duplicateReason?: 'OVER_RATE' | 'SAME_AMOUNT' } => {
  const shortRatio = opts.shortRatio ?? DEFAULT_SHORT_RATIO;
  const overRatio = opts.overRatio ?? DEFAULT_OVER_RATIO;
  const rate = expected != null && expected > 0 ? expected : null;
  if (!(actual > 0)) return { status: 'MISSING', gap: rate ?? 0 };
  if (rate != null) {
    if (actual < rate * shortRatio) return { status: 'SHORT', gap: rate - actual };
    if (actual > rate * overRatio) {
      return { status: 'POSSIBLE_DUPLICATE', gap: actual - rate, duplicateReason: 'OVER_RATE' };
    }
    return { status: 'OK', gap: 0 };
  }
  // Chưa khai mức: ≥2 phiếu KHÁC NHAU cùng số tiền (làm tròn đồng) ⇒ nghi trùng.
  const byAmount = new Map<number, Set<string>>();
  for (const v of vouchers) {
    if (!(v.amount > 0)) continue;
    const k = Math.round(v.amount);
    const set = byAmount.get(k) ?? new Set<string>();
    set.add(v.voucherId);
    byAmount.set(k, set);
  }
  for (const ids of byAmount.values()) {
    if (ids.size >= 2) return { status: 'POSSIBLE_DUPLICATE', gap: 0, duplicateReason: 'SAME_AMOUNT' };
  }
  return { status: 'OK', gap: 0 };
};

// ───────────────────────────── ngày ─────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Số ngày từ `from` tới `to` ('YYYY-MM-DD', theo lịch, không theo múi giờ). null nếu sai dạng. */
export const daysBetween = (from: string | null | undefined, to: string | null | undefined): number | null => {
  const a = ISO_DAY.exec(from ?? '');
  const b = ISO_DAY.exec(to ?? '');
  if (!a || !b) return null;
  const ta = Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  const tb = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3]));
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
};

// ───────────────────────────── bộ dò ─────────────────────────────

const compareVi = (a: string, b: string): number => a.localeCompare(b, 'vi', { sensitivity: 'base' });

export const computeFixedFeeChecks = (
  input: Omit<ProfitReportChecksInput, 'today'> & { today?: string },
): FixedFeeChecks => {
  const shortRatio = input.options?.shortRatio ?? DEFAULT_SHORT_RATIO;
  const overRatio = input.options?.overRatio ?? DEFAULT_OVER_RATIO;
  const ctx = buildFeeKeyContext(input.expenseTypes);
  const scope = input.scopeBuildingIds?.length ? new Set(input.scopeBuildingIds) : null;
  const skipRent = new Set(input.skipRentBuildingIds ?? []);

  const rateOf = new Map<string, ProfitCheckFeeRate>();
  for (const r of input.feeRates ?? []) rateOf.set(`${r.buildingId}|${r.feeCategory}`, r);

  // Gom phần chi theo toà × khoản × phiếu.
  const sums = new Map<string, { actual: number; pending: number; vouchers: Map<string, FixedFeeVoucher> }>();
  const rowBuildingName = new Map<string, string>();
  for (const row of input.rows) {
    if (!row.buildingId || !(row.expense > 0)) continue;
    // Dòng ngoài KQKD (cọc, phiếu ép không hạch toán) không làm lợi nhuận đủ chi.
    if (row.countsInBusinessResult === false) continue;
    if (row.buildingName) rowBuildingName.set(row.buildingId, row.buildingName);
    const key = resolveFixedFeeKey(row, ctx);
    if (!key) continue;
    const cellKey = `${row.buildingId}|${key}`;
    const cell = sums.get(cellKey) ?? { actual: 0, pending: 0, vouchers: new Map<string, FixedFeeVoucher>() };
    const pending = row.approvalStatus === 'UNAPPROVED';
    cell.actual += row.expense;
    if (pending) cell.pending += row.expense;
    const v = cell.vouchers.get(row.voucherId);
    if (v) {
      v.amount += row.expense;
      v.pending = v.pending || pending;
    } else {
      cell.vouchers.set(row.voucherId, {
        voucherId: row.voucherId,
        voucherName: row.voucherName,
        voucherDate: row.voucherDate,
        amount: row.expense,
        pending,
      });
    }
    sums.set(cellKey, cell);
  }

  const targets = input.buildings
    .filter((b) => !b.is_virtual && b.status !== 'INACTIVE')
    .filter((b) => !scope || scope.has(b.id))
    .map((b) => ({ b, name: (b.name ?? rowBuildingName.get(b.id) ?? '').trim() }))
    .sort((x, y) => compareVi(x.name, y.name) || compareVi(x.b.id, y.b.id));

  const cells: FixedFeeCell[] = [];
  for (const { b, name } of targets) {
    const hidden = new Set(b.hidden_fixed_expenses ?? []);
    for (const key of FIXED_FEE_KEYS) {
      if (hidden.has(key)) continue;
      if (key === 'thang_may' && !b.has_elevator) continue;
      if (key === 'tien_nha' && skipRent.has(b.id)) continue;
      const rate = rateOf.get(`${b.id}|${key}`);
      if (rate?.notApplicable) continue;
      const expected = rate?.defaultAmount != null && rate.defaultAmount > 0 ? rate.defaultAmount : null;
      const sum = sums.get(`${b.id}|${key}`);
      const actual = sum?.actual ?? 0;
      const vouchers = sum
        ? [...sum.vouchers.values()].sort(
            (x, y) => (x.voucherDate ?? '').localeCompare(y.voucherDate ?? '') || compareVi(x.voucherName, y.voucherName),
          )
        : [];
      const verdict = classifyFixedFee(actual, expected, vouchers, { shortRatio, overRatio });
      cells.push({
        buildingId: b.id,
        buildingName: name,
        key,
        label: FIXED_FEE_LABEL[key],
        status: verdict.status,
        expected,
        actual,
        pendingAmount: sum?.pending ?? 0,
        gap: verdict.gap,
        ratio: expected != null ? actual / expected : null,
        ...(verdict.duplicateReason ? { duplicateReason: verdict.duplicateReason } : {}),
        vouchers,
      });
    }
  }

  const issues = cells.filter((c) => c.status !== 'OK');
  const missingBuildings = new Set<string>();
  const duplicateBuildings = new Set<string>();
  let missingCount = 0;
  let shortCount = 0;
  let duplicateCount = 0;
  let unpricedMissingCount = 0;
  let missingAmount = 0;
  let excessAmount = 0;
  for (const c of issues) {
    if (c.status === 'MISSING' || c.status === 'SHORT') {
      missingBuildings.add(c.buildingId);
      if (c.status === 'MISSING') missingCount++;
      else shortCount++;
      if (c.expected == null) unpricedMissingCount++;
      else missingAmount += c.gap;
    } else if (c.status === 'POSSIBLE_DUPLICATE') {
      duplicateBuildings.add(c.buildingId);
      duplicateCount++;
      excessAmount += c.gap;
    }
  }

  return {
    cells,
    issues,
    checkedBuildingCount: targets.length,
    missingBuildingCount: missingBuildings.size,
    duplicateBuildingCount: duplicateBuildings.size,
    missingCount,
    shortCount,
    duplicateCount,
    unpricedMissingCount,
    missingAmount,
    excessAmount,
  };
};

/** Phiếu CHỜ DUYỆT có ngày phiếu cũ hơn `thresholdDays` ngày so với `today` mà đang nằm trong tổng. */
export const findStalePendingVouchers = (
  rows: readonly ProfitCheckRow[],
  today: string,
  thresholdDays: number = DEFAULT_STALE_PENDING_DAYS,
): StalePendingChecks => {
  const byVoucher = new Map<string, StalePendingVoucher>();
  for (const row of rows) {
    if (row.approvalStatus !== 'UNAPPROVED') continue;
    const age = daysBetween(row.voucherDate, today);
    if (age == null || age <= thresholdDays) continue;
    const v = byVoucher.get(row.voucherId);
    if (v) {
      v.income += row.income;
      v.expense += row.expense;
    } else {
      byVoucher.set(row.voucherId, {
        voucherId: row.voucherId,
        voucherName: row.voucherName,
        buildingId: row.buildingId,
        buildingName: row.buildingName,
        voucherDate: (row.voucherDate ?? '').slice(0, 10),
        ageDays: age,
        income: row.income,
        expense: row.expense,
      });
    }
  }
  const vouchers = [...byVoucher.values()]
    .filter((v) => v.income !== 0 || v.expense !== 0)
    .sort((a, b) => a.voucherDate.localeCompare(b.voucherDate) || compareVi(a.voucherName, b.voucherName));
  return {
    thresholdDays,
    vouchers,
    count: vouchers.length,
    income: vouchers.reduce((s, v) => s + v.income, 0),
    expense: vouchers.reduce((s, v) => s + v.expense, 0),
  };
};

export const computeProfitReportChecks = (input: ProfitReportChecksInput): ProfitReportChecksResult => {
  const fixedFees = computeFixedFeeChecks(input);
  const stalePending = findStalePendingVouchers(
    input.rows,
    input.today,
    input.options?.stalePendingDays ?? DEFAULT_STALE_PENDING_DAYS,
  );
  return {
    fixedFees,
    stalePending,
    hasWarnings: fixedFees.issues.length > 0 || stalePending.count > 0,
  };
};

// ───────────────────────────── ghi chú phòng ─────────────────────────────

export interface RoomNotesSummary {
  /** F45: mọi phòng trống cuối tháng (ghi chú 'vacant'), kể cả phòng có dòng thanh lý/bỏ cọc. */
  vacantRooms: number;
  /** F14: phòng còn HĐ mà tháng này CHƯA có hoá đơn tiền phòng. */
  missingInvoiceRooms: number;
  /** F14: phòng có hoá đơn tháng này nhưng chưa thu đồng nào. */
  unpaidInvoiceRooms: number;
  unpaidInvoiceAmount: number;
  /** Trong số phòng chưa thu: hoá đơn đã quá hạn. */
  overdueInvoiceRooms: number;
  /** F46: HĐ kết thúc trong tháng chưa thanh lý (chỉ có khi hook bật includeEndedContracts). */
  endedUnsettled: number;
  /** Σ còn nợ trên hoá đơn tháng của các HĐ đó. */
  endedUnsettledRemaining: number;
}

export const summarizeRoomNotes = (
  notes: ReadonlyMap<string, VacantRoomNote> | null | undefined,
): RoomNotesSummary => {
  const out: RoomNotesSummary = {
    vacantRooms: 0,
    missingInvoiceRooms: 0,
    unpaidInvoiceRooms: 0,
    unpaidInvoiceAmount: 0,
    overdueInvoiceRooms: 0,
    endedUnsettled: 0,
    endedUnsettledRemaining: 0,
  };
  if (!notes) return out;
  for (const n of notes.values()) {
    if (n.kind === 'vacant') out.vacantRooms++;
    else if (n.kind === 'active') {
      if (n.invoiceState === 'none') out.missingInvoiceRooms++;
      else if (n.invoiceState === 'unpaid') {
        out.unpaidInvoiceRooms++;
        out.unpaidInvoiceAmount += n.invoiceRemaining ?? 0;
        if (n.invoiceOverdue) out.overdueInvoiceRooms++;
      }
    } else if (n.kind === 'ended_unsettled') {
      out.endedUnsettled++;
      out.endedUnsettledRemaining += n.finalInvoiceRemaining ?? 0;
    }
  }
  return out;
};
