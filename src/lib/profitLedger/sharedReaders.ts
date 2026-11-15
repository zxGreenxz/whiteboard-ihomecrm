// Khuôn dùng chung của nhiều RPC sổ tổng: mốc, trạng thái số dư, phiếu lương cần xem lại, cảnh báo chi.
// Tên trường giữ NGUYÊN như payload máy chủ (snake_case) để đối chiếu thẳng với d1_*_interface.md.

import {
  count, fail, list, money, obj, oneOf, optInstant, optMoney, optMonth, sameMoney, str,
  type PayloadRow,
} from './readPrimitives';

export const PROFIT_LEDGER_SUBJECT_KINDS = ['SHAREHOLDER', 'MANAGER'] as const;
export type ProfitLedgerSubjectKind = (typeof PROFIT_LEDGER_SUBJECT_KINDS)[number];

export const LEDGER_BALANCE_STATUSES = ['OWED', 'SETTLED', 'ADVANCE'] as const;
/** OWED: công ty còn nợ (số dư > 0) · SETTLED: = 0 · ADVANCE: đang tạm ứng (< 0). */
export type LedgerBalanceStatus = (typeof LEDGER_BALANCE_STATUSES)[number];

export function ledgerStatusOf(balance: number): LedgerBalanceStatus {
  if (sameMoney(balance, 0)) return 'SETTLED';
  return balance > 0 ? 'OWED' : 'ADVANCE';
}

/** Trạng thái phải khớp số dư cùng payload — lệch là payload hỏng, không tự chọn bên nào. */
export function readBalanceStatus(value: unknown, balance: number, path: string): LedgerBalanceStatus {
  const status = oneOf(value, LEDGER_BALANCE_STATUSES, path);
  return status === ledgerStatusOf(balance) ? status : fail(path);
}

/**
 * Mốc hiệu lực của chủ thể (E1, E2, E10): `null` = chưa từng đặt mốc.
 * `settled_through_month = null` = dòng hiệu lực là dòng GỠ MỐC — coi như không có mốc, NHƯNG
 * `id` vẫn là giá trị gửi `p_expected_marker_id` khi đặt mốc mới (E9).
 */
export interface ProfitLedgerMarker {
  id: string;
  settled_through_month: string | null;
  ledger_seq: number;
}

export function readMarker(value: unknown, path: string): ProfitLedgerMarker | null {
  if (value === null) return null;
  const row = obj(value, path);
  return {
    id: str(row.id, `${path}.id`),
    settled_through_month: optMonth(row.settled_through_month, `${path}.settled_through_month`),
    ledger_seq: count(row.ledger_seq, `${path}.ledger_seq`),
  };
}

/** Mốc ở E8 (`current_marker`) có thêm giờ đặt. */
export interface ProfitLedgerMarkerWithTime extends ProfitLedgerMarker {
  created_at: string | null;
}

export function readMarkerWithTime(value: unknown, path: string): ProfitLedgerMarkerWithTime | null {
  const marker = readMarker(value, path);
  if (!marker) return null;
  const row = obj(value, path);
  return { ...marker, created_at: optInstant(row.created_at, `${path}.created_at`) };
}

/** Tháng của mốc đang có hiệu lực (null khi chưa có mốc hoặc mốc đã gỡ). */
export function activeMarkerMonth(marker: Pick<ProfitLedgerMarker, 'settled_through_month'> | null | undefined): string | null {
  return marker?.settled_through_month ?? null;
}

export interface NeedsReviewSummary {
  /** Số phiếu lương "cần chủ xem lại" còn sống (mọi kỳ) — khác 0 thì chi lợi nhuận bị chặn. */
  count: number;
  /** Tổng phần đầu tư máy gợi ý cho các phiếu đó. */
  suggested: number;
}

export function readNeedsReview(value: unknown, path: string): NeedsReviewSummary {
  const row = obj(value, path);
  return { count: count(row.count, `${path}.count`), suggested: money(row.suggested, `${path}.suggested`) };
}

export interface ExcludedBeforeMarker {
  allocated: number;
  payouts: number;
  salary: number;
}

export function readExcluded(value: unknown, path: string): ExcludedBeforeMarker {
  const row = obj(value, path);
  return {
    allocated: money(row.allocated, `${path}.allocated`),
    payouts: money(row.payouts, `${path}.payouts`),
    salary: money(row.salary, `${path}.salary`),
  };
}

/**
 * Cảnh báo của một lần chi (E4, E5 và `at_create.warnings` của E7 dùng chung hàm máy chủ).
 * Số trong cảnh báo chỉ để hiển thị (số chính thức là within/advance của cùng payload): dòng sổ cũ
 * có thể lưu cảnh báo không kèm số ⇒ `null` (KHÔNG thành 0); có khoá mà sai kiểu vẫn là lỗi.
 */
export type PayoutWarning =
  | { code: 'ADVANCE'; advance_amount: number | null }
  | { code: 'ADVANCE_EXCEEDS_ESTIMATE'; outstanding_advance: number | null; open_estimate: number | null }
  | { code: 'NEEDS_OWNER_APPROVAL' }
  /** Mã máy chủ thêm sau mà giao diện chưa biết: giữ mã, không đoán số. */
  | { code: 'OTHER'; raw_code: string };

const warningMoney = (row: PayloadRow, key: string, path: string): number | null =>
  key in row ? optMoney(row[key], `${path}.${key}`) : null;

function readWarning(row: PayloadRow, path: string): PayoutWarning {
  const code = str(row.code, `${path}.code`);
  if (code === 'ADVANCE') return { code, advance_amount: warningMoney(row, 'advance_amount', path) };
  if (code === 'ADVANCE_EXCEEDS_ESTIMATE') {
    return {
      code,
      outstanding_advance: warningMoney(row, 'outstanding_advance', path),
      open_estimate: warningMoney(row, 'open_estimate', path),
    };
  }
  if (code === 'NEEDS_OWNER_APPROVAL') return { code };
  return { code: 'OTHER', raw_code: code };
}

export function readWarnings(value: unknown, path: string): PayoutWarning[] {
  return list(value, path, readWarning);
}

export const PAYOUT_MAKER_KINDS = ['OWNER', 'CUSTODIAN_ADVANCE'] as const;
/** OWNER: chủ (quyền chi lợi nhuận) lập · CUSTODIAN_ADVANCE: người giữ sổ tự tạm ứng cho chính mình. */
export type PayoutMakerKind = (typeof PAYOUT_MAKER_KINDS)[number];
