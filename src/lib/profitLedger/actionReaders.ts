// Bộ đọc các RPC GHI / XEM TRƯỚC của sổ tổng:
//   E6 huỷ phiếu · E8 xem trước mốc · E9 đặt mốc
//   E11 lương điều hành (manager_salary_payout_v1, khoá `voucher_id` mới) · E16 xác nhận phần lương.
// Nguồn: 20261115084108_so_tong_loi_nhuan_tao.sql, 20261115084015_so_tong_loi_nhuan_chan.sql,
// 20261115083422_so_tong_loi_nhuan_luong.sql (+ d1_tao/d1_chan/d1_luong_interface.md).
// Mỗi bộ đọc so lại phần máy chủ "dội lại" (id chủ thể, số tiền) với đúng thứ đã gửi: biên nhận
// của một lệnh khác là biên nhận hỏng, không phải thành công.
//
// 18/11/2026: E4 (xem trước hộp chi) và E5 (lập phiếu chi theo SỐ TIỀN NHẬP TAY) của cổ đông đã bỏ khỏi web —
// tạm ứng và chốt chi lợi nhuận đọc ở positionReaders.ts (R4/W1, R5/W2/W3).

import { readProfitLedgerRoute, type ProfitLedgerRoute } from './route';
import {
  bool, fail, money, month, obj, oneOf, optMonth, optStr, str,
} from './readPrimitives';
import {
  readExcluded, readMarkerWithTime,
  type ExcludedBeforeMarker, type ProfitLedgerMarkerWithTime, type ProfitLedgerSubjectKind,
} from './sharedReaders';

/* ───────────────────────────── E6 profit_ledger_payout_cancel_v1 ───────────────────────────── */

export const CANCELLATION_KINDS = ['CANCELLED_UNPOSTED', 'CANCELLED_AFTER_POSTING'] as const;
export type CancellationKind = (typeof CANCELLATION_KINDS)[number];

export interface LedgerCancelResult {
  voucher_id: string;
  /** false: phiếu đã huỷ từ trước (lệnh phát lại / người khác vừa huỷ). */
  changed: boolean;
  cancellation_kind: CancellationKind | null;
  reversal_posting_id: string | null;
  /** Số dư sổ tổng của chủ thể sau huỷ (dương = công ty còn nợ, âm = đang tạm ứng). */
  balance_after: number;
}

export function readLedgerCancelResult(value: unknown, voucherId: string): LedgerCancelResult {
  const root = obj(value, 'E6');
  if (root.voucher_id !== voucherId) fail('E6.voucher_id');
  const changed = bool(root.changed, 'E6.changed');
  const kind = root.cancellation_kind === null && !changed
    ? null
    : oneOf(root.cancellation_kind, CANCELLATION_KINDS, 'E6.cancellation_kind');
  const reversal = optStr(root.reversal_posting_id, 'E6.reversal_posting_id');
  // Huỷ phiếu đã chi phải có bút toán đảo; huỷ phiếu chưa chi thì không.
  if (changed && (kind === 'CANCELLED_AFTER_POSTING') !== (reversal !== null)) fail('E6.reversal_posting_id');
  return {
    voucher_id: voucherId,
    changed,
    cancellation_kind: kind,
    reversal_posting_id: reversal,
    balance_after: money(root.balance_after, 'E6.balance_after'),
  };
}

/* ───────────────────────────── E8 profit_ledger_marker_preview_v1 ───────────────────────────── */

export interface MarkerPreview {
  route: ProfitLedgerRoute;
  subject_kind: ProfitLedgerSubjectKind;
  subject_id: string;
  /** Tháng mốc đang xem trước; null = gỡ mốc. */
  settled_through_month: string | null;
  /** Dòng mốc hiệu lực: `id` là `p_expected_marker_id` của E9 (null khi chưa từng có mốc). */
  current_marker: ProfitLedgerMarkerWithTime | null;
  balance_now: number;
  balance_after: number;
  /** Phần mốc MỚI loại (so với không mốc). */
  excluded: ExcludedBeforeMarker;
  /** Phần tạm ứng mốc này xoá dấu — > 0 thì phải tick xác nhận riêng. */
  advance_erased: number;
  requires_acknowledge: boolean;
}

export interface MarkerRequest {
  subjectKind: ProfitLedgerSubjectKind;
  subjectId: string;
  settledThroughMonth: string | null;
}

export function readMarkerPreview(value: unknown, request: MarkerRequest): MarkerPreview {
  const root = obj(value, 'E8');
  if (root.subject_kind !== request.subjectKind) fail('E8.subject_kind');
  if (root.subject_id !== request.subjectId) fail('E8.subject_id');
  const settled = optMonth(root.settled_through_month, 'E8.settled_through_month');
  if (settled !== request.settledThroughMonth) fail('E8.settled_through_month');
  const erased = money(root.advance_erased, 'E8.advance_erased');
  const requires = bool(root.requires_acknowledge, 'E8.requires_acknowledge');
  if (erased < 0 || requires !== erased > 0) fail('E8.requires_acknowledge');
  return {
    route: readProfitLedgerRoute(str(root.route, 'E8.route')),
    subject_kind: request.subjectKind,
    subject_id: request.subjectId,
    settled_through_month: settled,
    current_marker: readMarkerWithTime(root.current_marker, 'E8.current_marker'),
    balance_now: money(root.balance_now, 'E8.balance_now'),
    balance_after: money(root.balance_after, 'E8.balance_after'),
    excluded: readExcluded(root.excluded, 'E8.excluded'),
    advance_erased: erased,
    requires_acknowledge: requires,
  };
}

/* ───────────────────────────── E9 profit_ledger_set_marker_v1 ───────────────────────────── */

export interface MarkerResult {
  marker_id: string;
  settled_through_month: string | null;
  supersedes_id: string | null;
  balance_before: number;
  balance_after: number;
  advance_erased: number;
}

export function readMarkerResult(value: unknown, request: Pick<MarkerRequest, 'settledThroughMonth'>): MarkerResult {
  const root = obj(value, 'E9');
  const settled = optMonth(root.settled_through_month, 'E9.settled_through_month');
  if (settled !== request.settledThroughMonth) fail('E9.settled_through_month');
  return {
    marker_id: str(root.marker_id, 'E9.marker_id'),
    settled_through_month: settled,
    supersedes_id: optStr(root.supersedes_id, 'E9.supersedes_id'),
    balance_before: money(root.balance_before, 'E9.balance_before'),
    balance_after: money(root.balance_after, 'E9.balance_after'),
    advance_erased: money(root.advance_erased, 'E9.advance_erased'),
  };
}

/* ───────────────────────────── E11 manager_salary_payout_v1 ───────────────────────────── */

export interface ManagerSalaryPayoutResult {
  voucher_id: string;
  manager_salary_voucher_id: string;
  approval_request_id: string | null;
  manager_id: string;
  state: 'PENDING_APPROVAL';
  /** Chỉ khi sổ tổng chạy thật (CANONICAL): số còn lại trước phiếu này; route khác ⇒ null. */
  balance_before: number | null;
}

export function readManagerSalaryPayoutResult(value: unknown, managerId: string): ManagerSalaryPayoutResult {
  const root = obj(value, 'E11');
  if (root.manager_id !== managerId) fail('E11.manager_id');
  const voucherId = str(root.voucher_id, 'E11.voucher_id');
  const legacyId = str(root.manager_salary_voucher_id, 'E11.manager_salary_voucher_id');
  if (legacyId !== voucherId) fail('E11.manager_salary_voucher_id');
  return {
    voucher_id: voucherId,
    manager_salary_voucher_id: legacyId,
    approval_request_id: optStr(root.approval_request_id ?? null, 'E11.approval_request_id'),
    manager_id: managerId,
    state: oneOf(root.state, ['PENDING_APPROVAL'] as const, 'E11.state'),
    // Nhánh LEGACY/SHADOW không có khoá này (thân cũ) — vắng mặt là hợp lệ, không phải 0.
    balance_before: 'balance_before' in root ? money(root.balance_before, 'E11.balance_before') : null,
  };
}

/* ───────────────────────────── E16 profit_ledger_salary_resolve_v1 ───────────────────────────── */

export interface SalaryResolveResult {
  line_id: string;
  shareholder_id: string;
  salary_voucher_id: string;
  period_month: string;
  investment_amount: number;
  advance_offset_amount: number;
  balance_before: number;
  balance_after: number;
}

export function readSalaryResolveResult(value: unknown, lineId: string): SalaryResolveResult {
  const root = obj(value, 'E16');
  if (root.line_id !== lineId) fail('E16.line_id');
  return {
    line_id: lineId,
    shareholder_id: str(root.shareholder_id, 'E16.shareholder_id'),
    salary_voucher_id: str(root.salary_voucher_id, 'E16.salary_voucher_id'),
    period_month: month(root.period_month, 'E16.period_month'),
    investment_amount: money(root.investment_amount, 'E16.investment_amount'),
    advance_offset_amount: money(root.advance_offset_amount, 'E16.advance_offset_amount'),
    balance_before: money(root.balance_before, 'E16.balance_before'),
    balance_after: money(root.balance_after, 'E16.balance_after'),
  };
}
