// Bộ đọc các RPC GHI / XEM TRƯỚC của sổ tổng:
//   E4 xem trước hộp chi · E5 lập phiếu chi · E6 huỷ phiếu · E8 xem trước mốc · E9 đặt mốc
//   E11 lương điều hành (manager_salary_payout_v1, khoá `voucher_id` mới) · E16 xác nhận phần lương.
// Nguồn: 20261115084108_so_tong_loi_nhuan_tao.sql, 20261115084015_so_tong_loi_nhuan_chan.sql,
// 20261115083422_so_tong_loi_nhuan_luong.sql (+ d1_tao/d1_chan/d1_luong_interface.md).
// Mỗi bộ đọc so lại phần máy chủ "dội lại" (id chủ thể, số tiền) với đúng thứ đã gửi: biên nhận
// của một lệnh khác là biên nhận hỏng, không phải thành công.

import { readProfitLedgerRoute, type ProfitLedgerRoute } from './route';
import {
  bool, fail, money, month, obj, oneOf, optMoney, optMonth, optStr, sameMoney, str,
} from './readPrimitives';
import {
  PAYOUT_MAKER_KINDS, readExcluded, readMarkerWithTime, readNeedsReview, readWarnings,
  type ExcludedBeforeMarker, type NeedsReviewSummary, type PayoutMakerKind, type PayoutWarning,
  type ProfitLedgerMarkerWithTime, type ProfitLedgerSubjectKind,
} from './sharedReaders';

/* ───────────────────────────── E4 shareholder_profit_payout_preview_v1 ───────────────────────────── */

export const PAYOUT_BLOCKED_REASONS = ['ROUTE', 'SALARY_REVIEW_PENDING'] as const;
/** Lý do khoá gửi; 'OTHER' = mã máy chủ mới chưa biết (vẫn khoá — đóng an toàn). */
export type PayoutBlockedReason = (typeof PAYOUT_BLOCKED_REASONS)[number] | 'OTHER';

export interface PayoutPreview {
  route: ProfitLedgerRoute;
  shareholder_id: string;
  maker_kind: PayoutMakerKind;
  payee_is_maker: boolean;
  /** Số dư hiện tại của cổ đông (dương = công ty còn nợ, âm = đang tạm ứng). */
  balance_before: number;
  /** null khi chưa nhập số tiền. */
  within_amount: number | null;
  advance_amount: number | null;
  /** Lợi nhuận ước tính của các tháng trọn vẹn chưa chốt. */
  open_estimate: number;
  warnings: PayoutWarning[];
  requires_owner_approval: boolean;
  /** Máy chủ cho gửi (route CANONICAL, không phiếu lương chờ xem lại, đủ số tiền + sổ quỹ). */
  can_submit: boolean;
  blocked_reason: PayoutBlockedReason | null;
  needs_review: NeedsReviewSummary;
}

export interface PayoutPreviewRequest {
  shareholderId: string;
  amount: number | null;
  accountId: string | null;
}

export function readPayoutPreview(value: unknown, request: PayoutPreviewRequest): PayoutPreview {
  const root = obj(value, 'E4');
  if (root.shareholder_id !== request.shareholderId) fail('E4.shareholder_id');
  const within = optMoney(root.within_amount, 'E4.within_amount');
  const advance = optMoney(root.advance_amount, 'E4.advance_amount');
  if (request.amount === null) {
    if (within !== null || advance !== null) fail('E4.within_amount');
  } else {
    // Cùng công thức E5 dùng lúc lập: within + advance = số tiền, cả hai ≥ 0.
    if (within === null || advance === null || within < 0 || advance < 0 || !sameMoney(within + advance, request.amount)) {
      fail('E4.within_amount');
    }
  }
  const blockedRaw = root.blocked_reason;
  let blocked: PayoutBlockedReason | null = null;
  if (blockedRaw !== null) {
    const code = str(blockedRaw, 'E4.blocked_reason');
    blocked = (PAYOUT_BLOCKED_REASONS as readonly string[]).includes(code) ? (code as PayoutBlockedReason) : 'OTHER';
  }
  const canSubmit = bool(root.can_submit, 'E4.can_submit');
  return {
    route: readProfitLedgerRoute(str(root.route, 'E4.route')),
    shareholder_id: request.shareholderId,
    maker_kind: oneOf(root.maker_kind, PAYOUT_MAKER_KINDS, 'E4.maker_kind'),
    payee_is_maker: bool(root.payee_is_maker, 'E4.payee_is_maker'),
    balance_before: money(root.balance_before, 'E4.balance_before'),
    within_amount: within,
    advance_amount: advance,
    open_estimate: money(root.open_estimate, 'E4.open_estimate'),
    warnings: readWarnings(root.warnings, 'E4.warnings'),
    requires_owner_approval: bool(root.requires_owner_approval, 'E4.requires_owner_approval'),
    // Không tin can_submit khi còn lý do khoá (đóng an toàn nếu hai trường lệch nhau).
    can_submit: canSubmit && blocked === null,
    blocked_reason: blocked,
    needs_review: readNeedsReview(root.needs_review, 'E4.needs_review'),
  };
}

/* ───────────────────────────── E5 shareholder_profit_ledger_payout_v1 ───────────────────────────── */

export interface LedgerPayoutResult {
  voucher_id: string;
  approval_request_id: string;
  shareholder_id: string;
  amount: number;
  within_amount: number;
  advance_amount: number;
  balance_before: number;
  warnings: PayoutWarning[];
  maker_kind: PayoutMakerKind;
  state: 'PENDING_APPROVAL';
}

export function readLedgerPayoutResult(value: unknown, request: { shareholderId: string; amount: number }): LedgerPayoutResult {
  const root = obj(value, 'E5');
  if (root.shareholder_id !== request.shareholderId) fail('E5.shareholder_id');
  const amount = money(root.amount, 'E5.amount');
  if (!sameMoney(amount, request.amount)) fail('E5.amount');
  const within = money(root.within_amount, 'E5.within_amount');
  const advance = money(root.advance_amount, 'E5.advance_amount');
  if (within < 0 || advance < 0 || !sameMoney(within + advance, amount)) fail('E5.within_amount');
  return {
    voucher_id: str(root.voucher_id, 'E5.voucher_id'),
    approval_request_id: str(root.approval_request_id, 'E5.approval_request_id'),
    shareholder_id: request.shareholderId,
    amount,
    within_amount: within,
    advance_amount: advance,
    balance_before: money(root.balance_before, 'E5.balance_before'),
    warnings: readWarnings(root.warnings, 'E5.warnings'),
    maker_kind: oneOf(root.maker_kind, PAYOUT_MAKER_KINDS, 'E5.maker_kind'),
    state: oneOf(root.state, ['PENDING_APPROVAL'] as const, 'E5.state'),
  };
}

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
