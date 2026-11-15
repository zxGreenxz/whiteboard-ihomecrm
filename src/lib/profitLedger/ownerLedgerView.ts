// Số và chữ cho trang lợi nhuận của CHỦ (Tổng quan máy tính + điện thoại) dựng từ sổ tổng:
// E1 (sổ tổng cổ đông), E2 (sổ chi tiết), E10 (sổ lương điều hành). Hàm thuần — component chỉ vẽ.
//
// Luật hiển thị theo công tắc sổ tổng (brief Đợt 2):
//   LEGACY  — số đầu trang giữ CÁCH TÍNH CŨ; bảng sổ tổng hiện kèm nhãn "xem thử" (không phải số chính thức).
//   SHADOW / CANONICAL / FROZEN — số đầu trang đọc sổ tổng.

import type {
  LedgerEntryKind, ManagerLedgerRow, ShareholderLedgerEntry, ShareholderLedgerRow,
} from './ledgerReaders';
import { profitLedgerRouteState, type ProfitLedgerRouteState } from './route';
import { activeMarkerMonth, type LedgerBalanceStatus, type ProfitLedgerMarker } from './sharedReaders';
import { expectedCancelState, type ProfitPayoutCancelTarget } from './vouchers';
import { formatVND } from '@/lib/utils';

/* ───────────────────────────── chế độ số đầu trang ───────────────────────────── */

/**
 * LEDGER: số đầu trang đọc sổ tổng · LEGACY: giữ cách tính cũ · PENDING: đang tải sổ tổng ·
 * ERROR: sổ tổng đang chạy thật mà chưa tải được (hiện "—", không đoán số).
 */
export type OwnerLedgerMode = 'LEDGER' | 'LEGACY' | 'PENDING' | 'ERROR';

export function ownerLedgerMode(input: {
  organizationId: string | null;
  /** route của E1 khi đã tải (undefined = chưa biết). */
  route: unknown;
  hasLedger: boolean;
  loading: boolean;
  /** E1 trả 42501: người xem không được xem sổ tổng — giữ cách cũ như trước Đợt 2. */
  forbidden: boolean;
}): OwnerLedgerMode {
  if (!input.organizationId) return 'LEGACY';
  if (input.route !== undefined) {
    if (!profitLedgerRouteState(input.route).ledgerReady) return 'LEGACY';
    if (input.hasLedger) return 'LEDGER';
  }
  if (input.forbidden) return 'LEGACY';
  return input.loading ? 'PENDING' : 'ERROR';
}

/* ───────────────────────────── tổng của E1 ───────────────────────────── */

export interface ShareholderLedgerSummary {
  allocated: number;
  approved: number;
  pending: number;
  /** Σ(Y − D): phần lợi nhuận đã trả qua phiếu lương, trừ phần lương đã bù tạm ứng. */
  viaSalary: number;
  /** Σ max(số dư, 0): công ty còn phải trả. */
  owed: number;
  /** Σ open_advance: đang tạm ứng chưa bù. */
  advance: number;
  owedCount: number;
  advanceCount: number;
}

/** Thực trả qua lương của một cổ đông: Y − D (có thể âm khi phần bù tạm ứng lớn hơn). */
export const salaryNet = (row: Pick<ShareholderLedgerRow, 'salary_investment' | 'salary_advance_offset'>): number =>
  row.salary_investment - row.salary_advance_offset;

export function summarizeShareholderLedger(rows: readonly ShareholderLedgerRow[]): ShareholderLedgerSummary {
  const sum: ShareholderLedgerSummary = {
    allocated: 0, approved: 0, pending: 0, viaSalary: 0, owed: 0, advance: 0, owedCount: 0, advanceCount: 0,
  };
  for (const row of rows) {
    sum.allocated += row.allocated;
    sum.approved += row.payouts_approved;
    sum.pending += row.payouts_pending;
    sum.viaSalary += salaryNet(row);
    sum.owed += Math.max(row.balance, 0);
    sum.advance += row.open_advance;
    if (row.status === 'OWED') sum.owedCount += 1;
    if (row.status === 'ADVANCE') sum.advanceCount += 1;
  }
  return sum;
}

/* ───────────────────────────── nhãn ───────────────────────────── */

export const SHAREHOLDER_STATUS_LABEL: Readonly<Record<LedgerBalanceStatus, string>> = {
  OWED: 'Còn phải trả',
  SETTLED: 'Đã trả đủ',
  ADVANCE: 'Đang tạm ứng',
};

export const MANAGER_STATUS_LABEL: Readonly<Record<LedgerBalanceStatus, string>> = {
  OWED: 'Còn lại',
  SETTLED: 'Đã trả đủ',
  // Chỉ xảy ra với phiếu cũ lập trước khi có trần (sổ tổng chưa chạy thật).
  ADVANCE: 'Đã chi vượt',
};

/** Số dư có dấu thành chữ: dương/0 = số còn phải trả, âm = "tạm ứng X". */
export function ledgerBalanceText(balance: number): string {
  return balance < 0 ? `tạm ứng ${formatVND(-balance)}` : formatVND(balance);
}

/** 'YYYY-MM-01' → 'T09/2026'; chuỗi lạ ⇒ chính nó (không đoán). */
export function ledgerMonthLabel(value: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(value);
  return m ? `T${m[2]}/${m[1]}` : value;
}

/** Mốc đang có hiệu lực: "hết T09/2026"; không có (hoặc đã gỡ) ⇒ null. */
export function markerText(marker: Pick<ProfitLedgerMarker, 'settled_through_month'> | null | undefined): string | null {
  const month = activeMarkerMonth(marker);
  return month ? `hết ${ledgerMonthLabel(month)}` : null;
}

/** Trạng thái phiếu cho người dùng (không lộ mã kỹ thuật). */
export function voucherStateLabel(approval: string | null | undefined, posting: string | null | undefined): string {
  if (approval === 'UNAPPROVED') return 'Chờ duyệt';
  if (approval === 'CANCELLED') return 'Đã huỷ';
  if (approval === 'APPROVED') {
    if (posting === 'POSTED') return 'Đã chi';
    if (posting === 'REVERSED') return 'Đã đảo';
    return 'Đã duyệt, chưa chi';
  }
  return '—';
}

export const LEDGER_ENTRY_KIND_LABEL: Readonly<Record<LedgerEntryKind, string>> = {
  ALLOCATION: 'Được chia',
  PAYOUT: 'Phiếu chi',
  SALARY: 'Trả qua lương',
  SALARY_OFFSET: 'Lương bù tạm ứng',
  SALARY_REVIEW: 'Phiếu lương cần xem lại',
};

/** 'YYYY-MM' của tháng liền trước (mặc định ô chọn tháng mốc). */
export function previousYearMonth(yearMonth: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) return yearMonth;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/* ───────────────────────────── nút thao tác ───────────────────────────── */

/** Lý do KHÔNG cho chi lợi nhuận cổ đông này (null = chi được). Quyền chi do nơi gọi kiểm. */
export function shareholderPayBlock(row: ShareholderLedgerRow, routeState: ProfitLedgerRouteState): string | null {
  if (row.is_deleted) return 'Cổ đông đã xoá — không chi được.';
  if (!row.is_active) return 'Cổ đông đang ngưng — không chi được.';
  if (!routeState.canPayShareholder) return routeState.banner ?? 'Sổ tổng chưa mở chi lợi nhuận.';
  if (row.needs_review_count > 0) {
    return `Còn ${row.needs_review_count} phiếu lương cần xem lại phần lợi nhuận — xác nhận trước khi chi.`;
  }
  return null;
}

/** Lý do KHÔNG cho chi lương điều hành người này (null = chi được). */
export function managerPayBlock(row: ManagerLedgerRow, routeState: ProfitLedgerRouteState): string | null {
  if (row.is_deleted) return 'Người nhận đã xoá — không chi được.';
  if (!row.is_active) return 'Người nhận đang ngưng — không chi được.';
  if (!routeState.canPayManager) return 'Sổ tổng đang đóng băng — tạm khoá chi lương điều hành.';
  if (row.balance <= 0) return 'Không còn lương điều hành để chi.';
  return null;
}

/**
 * Được bấm Huỷ một phiếu chi của sổ chi tiết: người có quyền chi lợi nhuận, hoặc chính người lập
 * khi phiếu còn chờ duyệt (máy chủ E6 là chốt cuối).
 */
export function canCancelLedgerEntry(entry: Pick<ShareholderLedgerEntry, 'is_mine' | 'voucher_status'>, canDistribute: boolean): boolean {
  return canDistribute || (entry.is_mine && entry.voucher_status === 'UNAPPROVED');
}

/** Phiếu lương điều hành (useManagerLedgerPayouts) — chỉ những trường cần cho hộp huỷ. */
export interface ManagerPayoutLike {
  id: string;
  code: string | null;
  total_amount: number;
  approval_status: string;
  posting_status: string | null;
  account_name: string | null;
  is_ledger_voucher: boolean;
}

/**
 * Hộp huỷ (E6) cho một phiếu lương điều hành. Chỉ phiếu lập theo sổ tổng (`profit.manager_salary`);
 * phiếu cũ huỷ theo đường cũ ở Thu chi ⇒ null. Trạng thái không huỷ được ⇒ null.
 */
export function cancelTargetFromManagerPayout(
  payout: ManagerPayoutLike,
  context: { organizationId: string; subjectName: string | null },
): ProfitPayoutCancelTarget | null {
  if (!payout.is_ledger_voucher) return null;
  if (!expectedCancelState(payout.approval_status, payout.posting_status)) return null;
  return {
    voucherId: payout.id,
    organizationId: context.organizationId,
    kind: 'MANAGER',
    code: payout.code,
    amount: payout.total_amount,
    approvalStatus: payout.approval_status,
    postingStatus: payout.posting_status,
    subjectName: context.subjectName,
    accountName: payout.account_name,
  };
}
