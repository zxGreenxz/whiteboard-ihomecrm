// Bộ đọc phần LƯƠNG của sổ tổng: E12 (đầu vào bảng lương), E13 (đóng băng trước khi chốt lương),
// E14 (ảnh hưởng khi mở khoá tháng lợi nhuận), E15 (báo giá phần lợi nhuận trước mỗi phiếu lương).
// Nguồn: 20261115083422_so_tong_loi_nhuan_luong.sql (+ d1_luong_interface.md).

import {
  bool, count, fail, instant, list, money, month, obj, oneOf, optInstant, optMoney, optMonth, optObj,
  optStr, optStrList, str, strList, uniqueBy, type PayloadRow,
} from './readPrimitives';
import { readNeedsReview, type NeedsReviewSummary } from './sharedReaders';

export const SALARY_SHEET_STATUSES = ['LOCKED', 'DRAFT', 'NONE'] as const;
export type SalarySheetStatus = (typeof SALARY_SHEET_STATUSES)[number];

/* ───────────────────────────── E12 salary_profit_inputs_v1 ───────────────────────────── */

export interface SalaryProfitAllocation {
  building_id: string;
  /** Nhãn toà máy chủ dùng để gộp (mã, không thì tên, không thì "—"). */
  building_label: string;
  amount: number;
  status: 'LOCKED' | 'DRAFT';
  is_stale: boolean;
}

export interface SalaryProfitBuildingLine {
  label: string;
  building_ids: string[];
  allocated: number;
  /** Ghi đè `dh:<nhãn>` mới nhất; null = không ghi đè. */
  override_amount: number | null;
  amount: number;
}

export interface SalaryProfitSettlement {
  id: string;
  investment_month: number;
  advance_offset_month: number;
  applied_offset_at_freeze: number;
  expected_take_home: number | null;
  created_at: string;
  /** Bản đóng băng khớp bảng lương đã chốt (mới được dùng làm D của tháng). */
  matches_sheet: boolean;
}

export interface SalaryProfitPaidLine {
  line_id: string;
  salary_voucher_id: string | null;
  voucher_code: string | null;
  voucher_amount: number | null;
  voucher_live: boolean;
  /** Y_i. */
  investment: number;
  /** D_i. */
  advance_offset: number;
  suggested_investment: number | null;
  state: 'LINKED' | 'NEEDS_REVIEW';
  source: string;
  created_at: string;
  linked_at: string | null;
}

export interface SalaryProfitStaff {
  staff_id: string;
  organization_id: string | null;
  /** null = nhân viên không phải cổ đông (mọi số còn lại trung tính). */
  shareholder_id: string | null;
  sheet_status: SalarySheetStatus;
  /** Công ty còn toà chưa chốt lợi nhuận kỳ này. */
  profit_draft: boolean;
  allocations: SalaryProfitAllocation[];
  by_building: SalaryProfitBuildingLine[];
  /** A_m. */
  allocated_total: number;
  /** Y_m: dòng "Lợi nhuận đầu tư" của lương tháng. */
  investment_month: number;
  /** Phần đầu tư trả qua lương (kỳ ≤ mốc ⇒ 0). */
  investment_cap: number;
  marker_through: string | null;
  settled_by_marker: boolean;
  settlement: SalaryProfitSettlement | null;
  paid_lines: SalaryProfitPaidLine[];
  /** ΣY của dòng LINKED sống. */
  paid_investment: number;
  /** ΣD của dòng LINKED sống. */
  paid_offset: number;
  advance_open: number;
  /** D_m. */
  advance_offset_month: number;
  /** Dòng "Trừ tạm ứng lợi nhuận" (= D_m; bảng nháp luôn ≥ paid_offset). */
  suggested_advance_offset: number;
  remaining_offset: number;
  /** Bảng đã chốt không gồm phần đã trừ: phiếu sau sẽ "cần xem lại". */
  offset_conflict: boolean;
  /** Mọi kỳ của cổ đông (khác 0 ⇒ chi lợi nhuận bị chặn). */
  needs_review: NeedsReviewSummary;
}

export interface SalaryProfitInputs {
  period_month: string;
  staff: SalaryProfitStaff[];
}

function readSettlement(value: unknown, path: string): SalaryProfitSettlement | null {
  const row = optObj(value, path);
  if (!row) return null;
  return {
    id: str(row.id, `${path}.id`),
    investment_month: money(row.investment_month, `${path}.investment_month`),
    advance_offset_month: money(row.advance_offset_month, `${path}.advance_offset_month`),
    applied_offset_at_freeze: money(row.applied_offset_at_freeze, `${path}.applied_offset_at_freeze`),
    expected_take_home: optMoney(row.expected_take_home, `${path}.expected_take_home`),
    created_at: instant(row.created_at, `${path}.created_at`),
    matches_sheet: bool(row.matches_sheet, `${path}.matches_sheet`),
  };
}

function readStaff(row: PayloadRow, path: string): SalaryProfitStaff {
  return {
    staff_id: str(row.staff_id, `${path}.staff_id`),
    organization_id: optStr(row.organization_id, `${path}.organization_id`),
    shareholder_id: optStr(row.shareholder_id, `${path}.shareholder_id`),
    sheet_status: oneOf(row.sheet_status, SALARY_SHEET_STATUSES, `${path}.sheet_status`),
    profit_draft: bool(row.profit_draft, `${path}.profit_draft`),
    allocations: list(row.allocations, `${path}.allocations`, (a, p) => ({
      building_id: str(a.building_id, `${p}.building_id`),
      building_label: str(a.building_label, `${p}.building_label`),
      amount: money(a.amount, `${p}.amount`),
      status: oneOf(a.status, ['LOCKED', 'DRAFT'] as const, `${p}.status`),
      is_stale: bool(a.is_stale, `${p}.is_stale`),
    })),
    by_building: list(row.by_building, `${path}.by_building`, (b, p) => ({
      label: str(b.label, `${p}.label`),
      building_ids: strList(b.building_ids, `${p}.building_ids`),
      allocated: money(b.allocated, `${p}.allocated`),
      override_amount: optMoney(b.override_amount, `${p}.override_amount`),
      amount: money(b.amount, `${p}.amount`),
    })),
    allocated_total: money(row.allocated_total, `${path}.allocated_total`),
    investment_month: money(row.investment_month, `${path}.investment_month`),
    investment_cap: money(row.investment_cap, `${path}.investment_cap`),
    marker_through: optMonth(row.marker_through, `${path}.marker_through`),
    settled_by_marker: bool(row.settled_by_marker, `${path}.settled_by_marker`),
    settlement: readSettlement(row.settlement, `${path}.settlement`),
    paid_lines: list(row.paid_lines, `${path}.paid_lines`, (l, p) => ({
      line_id: str(l.line_id, `${p}.line_id`),
      salary_voucher_id: optStr(l.salary_voucher_id, `${p}.salary_voucher_id`),
      voucher_code: optStr(l.voucher_code, `${p}.voucher_code`),
      voucher_amount: optMoney(l.voucher_amount, `${p}.voucher_amount`),
      voucher_live: bool(l.voucher_live, `${p}.voucher_live`),
      investment: money(l.investment, `${p}.investment`),
      advance_offset: money(l.advance_offset, `${p}.advance_offset`),
      suggested_investment: optMoney(l.suggested_investment, `${p}.suggested_investment`),
      state: oneOf(l.state, ['LINKED', 'NEEDS_REVIEW'] as const, `${p}.state`),
      source: str(l.source, `${p}.source`),
      created_at: instant(l.created_at, `${p}.created_at`),
      linked_at: optInstant(l.linked_at, `${p}.linked_at`),
    })),
    paid_investment: money(row.paid_investment, `${path}.paid_investment`),
    paid_offset: money(row.paid_offset, `${path}.paid_offset`),
    advance_open: money(row.advance_open, `${path}.advance_open`),
    advance_offset_month: money(row.advance_offset_month, `${path}.advance_offset_month`),
    suggested_advance_offset: money(row.suggested_advance_offset, `${path}.suggested_advance_offset`),
    remaining_offset: money(row.remaining_offset, `${path}.remaining_offset`),
    offset_conflict: bool(row.offset_conflict, `${path}.offset_conflict`),
    needs_review: readNeedsReview(row.needs_review, `${path}.needs_review`),
  };
}

export function readSalaryProfitInputs(value: unknown, periodMonth: string, staffIds: readonly string[]): SalaryProfitInputs {
  const root = obj(value, 'E12');
  if (root.period_month !== periodMonth) fail('E12.period_month');
  const staff = uniqueBy(list(root.staff, 'E12.staff', readStaff), (s) => s.staff_id, 'E12.staff');
  const asked = new Set(staffIds);
  // Máy chủ trả đúng mỗi nhân viên được hỏi một dòng (bỏ trùng) — thiếu hoặc thừa là payload lệch.
  if (staff.length !== asked.size || staff.some((s) => !asked.has(s.staff_id))) fail('E12.staff');
  return { period_month: periodMonth, staff };
}

/* ───────────────────────────── E13 salary_profit_settlement_freeze_v1 ───────────────────────────── */

interface SalaryFreezeCommon {
  shareholder_id: string;
  staff_id: string;
  period_month: string;
  organization_id: string;
  investment_month: number;
  advance_offset_month: number;
  paid_investment: number;
  paid_offset: number;
  /** = Y_cap − ΣY (có thể âm). */
  unpaid_investment: number;
  settled_by_marker: boolean;
}

export type SalaryFreezeResult =
  | { kind: 'NOT_SHAREHOLDER'; staff_id: string; period_month: string; organization_id: string | null }
  /** Bảng lương đã chốt: máy chủ KHÔNG ghi gì, trả số hiện hành. */
  | (SalaryFreezeCommon & { kind: 'ALREADY_LOCKED'; settlement_id: string | null; offset_conflict: boolean })
  | (SalaryFreezeCommon & { kind: 'FROZEN'; settlement_id: string; voided_settlement_id: string | null });

export function readSalaryFreezeResult(value: unknown, request: { staffId: string; periodMonth: string }): SalaryFreezeResult {
  const root = obj(value, 'E13');
  if (root.staff_id !== request.staffId) fail('E13.staff_id');
  if (root.period_month !== request.periodMonth) fail('E13.period_month');
  if (root.shareholder_id === null) {
    if (root.settlement_id !== null) fail('E13.settlement_id');
    return {
      kind: 'NOT_SHAREHOLDER', staff_id: request.staffId, period_month: request.periodMonth,
      organization_id: optStr(root.organization_id, 'E13.organization_id'),
    };
  }
  const common: SalaryFreezeCommon = {
    shareholder_id: str(root.shareholder_id, 'E13.shareholder_id'),
    staff_id: request.staffId,
    period_month: request.periodMonth,
    organization_id: str(root.organization_id, 'E13.organization_id'),
    investment_month: money(root.investment_month, 'E13.investment_month'),
    advance_offset_month: money(root.advance_offset_month, 'E13.advance_offset_month'),
    paid_investment: money(root.paid_investment, 'E13.paid_investment'),
    paid_offset: money(root.paid_offset, 'E13.paid_offset'),
    unpaid_investment: money(root.unpaid_investment, 'E13.unpaid_investment'),
    settled_by_marker: bool(root.settled_by_marker, 'E13.settled_by_marker'),
  };
  if (bool(root.already_locked, 'E13.already_locked')) {
    return {
      ...common, kind: 'ALREADY_LOCKED',
      settlement_id: optStr(root.settlement_id, 'E13.settlement_id'),
      offset_conflict: bool(root.offset_conflict, 'E13.offset_conflict'),
    };
  }
  return {
    ...common, kind: 'FROZEN',
    settlement_id: str(root.settlement_id, 'E13.settlement_id'),
    voided_settlement_id: optStr(root.voided_settlement_id, 'E13.voided_settlement_id'),
  };
}

/* ───────────────────────────── E14 profit_unlock_salary_impact_v1 ───────────────────────────── */

export interface UnlockLedgerEffect {
  shareholder_id: string;
  name: string;
  /** auth_user_id của cổ đông (= nhân viên hưởng lương) hoặc null. */
  staff_id: string | null;
  balance_now: number;
  allocations_in_scope: number;
  /** = allocations_in_scope, trừ khi kỳ ≤ mốc (0). */
  allocations_removed: number;
  balance_after: number;
  /** Đang ≥ 0 mà sau khi mở khoá thành âm. */
  becomes_advance: boolean;
  advance_after: boolean;
  settled_by_marker: boolean;
}

export interface UnlockPaidViaSalary {
  shareholder_id: string;
  name: string;
  staff_id: string | null;
  investment: number;
  advance_offset: number;
  salary_voucher_ids: string[];
  salary_voucher_codes: (string | null)[];
  voucher_states: { salary_voucher_id: string; approval_status: string | null; posting_status: string | null }[];
  needs_review_count: number;
  /** null khi cổ đông đã xoá hoặc không có đăng nhập (không tính được trần tháng). */
  offset_conflict: boolean | null;
  paid_offset: number | null;
  advance_offset_month: number | null;
  sheet_status: SalarySheetStatus | null;
}

export interface UnlockSalaryImpact {
  organization_id: string;
  period_month: string;
  building_ids: string[] | null;
  paid_via_salary: UnlockPaidViaSalary[];
  ledger_effects: UnlockLedgerEffect[];
}

export function readUnlockSalaryImpact(value: unknown, organizationId: string, periodMonth: string): UnlockSalaryImpact {
  const root = obj(value, 'E14');
  if (root.organization_id !== organizationId) fail('E14.organization_id');
  if (root.period_month !== periodMonth) fail('E14.period_month');
  return {
    organization_id: organizationId,
    period_month: periodMonth,
    building_ids: root.building_ids === null ? null : strList(root.building_ids, 'E14.building_ids'),
    paid_via_salary: list(root.paid_via_salary, 'E14.paid_via_salary', (row, p) => ({
      shareholder_id: str(row.shareholder_id, `${p}.shareholder_id`),
      name: str(row.name, `${p}.name`),
      staff_id: optStr(row.staff_id, `${p}.staff_id`),
      investment: money(row.investment, `${p}.investment`),
      advance_offset: money(row.advance_offset, `${p}.advance_offset`),
      salary_voucher_ids: strList(row.salary_voucher_ids, `${p}.salary_voucher_ids`),
      salary_voucher_codes: optStrList(row.salary_voucher_codes, `${p}.salary_voucher_codes`),
      voucher_states: list(row.voucher_states, `${p}.voucher_states`, (s, sp) => ({
        salary_voucher_id: str(s.salary_voucher_id, `${sp}.salary_voucher_id`),
        approval_status: optStr(s.approval_status, `${sp}.approval_status`),
        posting_status: optStr(s.posting_status, `${sp}.posting_status`),
      })),
      needs_review_count: count(row.needs_review_count, `${p}.needs_review_count`),
      offset_conflict: row.offset_conflict === null ? null : bool(row.offset_conflict, `${p}.offset_conflict`),
      paid_offset: optMoney(row.paid_offset, `${p}.paid_offset`),
      advance_offset_month: optMoney(row.advance_offset_month, `${p}.advance_offset_month`),
      sheet_status: row.sheet_status === null ? null : oneOf(row.sheet_status, SALARY_SHEET_STATUSES, `${p}.sheet_status`),
    })),
    ledger_effects: list(root.ledger_effects, 'E14.ledger_effects', (row, p) => ({
      shareholder_id: str(row.shareholder_id, `${p}.shareholder_id`),
      name: str(row.name, `${p}.name`),
      staff_id: optStr(row.staff_id, `${p}.staff_id`),
      balance_now: money(row.balance_now, `${p}.balance_now`),
      allocations_in_scope: money(row.allocations_in_scope, `${p}.allocations_in_scope`),
      allocations_removed: money(row.allocations_removed, `${p}.allocations_removed`),
      balance_after: money(row.balance_after, `${p}.balance_after`),
      becomes_advance: bool(row.becomes_advance, `${p}.becomes_advance`),
      advance_after: bool(row.advance_after, `${p}.advance_after`),
      settled_by_marker: bool(row.settled_by_marker, `${p}.settled_by_marker`),
    })),
  };
}

/** Mở khoá / đặt lại tháng này có chạm lương hoặc sổ tổng của ai không (có ⇒ bắt tick "đã hiểu"). */
export function unlockImpactNeedsAcknowledge(impact: UnlockSalaryImpact): boolean {
  return impact.paid_via_salary.length > 0 || impact.ledger_effects.some((e) => e.allocations_removed !== 0);
}

/* ───────────────────────────── E15 salary_profit_payout_quote_v1 ───────────────────────────── */

export const SALARY_QUOTE_REVIEW_REASONS = ['OFFSET_CONFLICT', 'MIXED_SIGN_SELECTION'] as const;

export type SalaryQuoteResult =
  | { kind: 'NOT_SHAREHOLDER'; staff_id: string; period_month: string; organization_id: string | null }
  | {
      kind: 'QUOTED';
      quote_id: string;
      shareholder_id: string;
      staff_id: string;
      period_month: string;
      organization_id: string;
      /** Y_i của phiếu sắp lập. */
      investment_amount: number;
      /** D_i của phiếu sắp lập. */
      advance_offset_amount: number;
      investment_month: number;
      advance_offset_month: number;
      paid_investment: number;
      paid_offset: number;
      settled_by_marker: boolean;
      sheet_status: SalarySheetStatus;
      expected_voucher_amount: number;
      payout_request_key: string;
      expires_at: string;
      voided_quote_ids: string[];
      offset_conflict: boolean;
      /** Khác null ⇒ lập phiếu theo báo giá này thì dòng lợi nhuận sẽ "cần chủ xem lại" — nên dừng. */
      needs_review_reason: string | null;
    };

export function readSalaryQuoteResult(
  value: unknown,
  request: { staffId: string; periodMonth: string; payoutKey: string },
): SalaryQuoteResult {
  const root = obj(value, 'E15');
  if (root.staff_id !== request.staffId) fail('E15.staff_id');
  if (root.period_month !== request.periodMonth) fail('E15.period_month');
  if (root.quote_id === null) {
    if (root.shareholder_id !== null) fail('E15.shareholder_id');
    return {
      kind: 'NOT_SHAREHOLDER', staff_id: request.staffId, period_month: request.periodMonth,
      organization_id: optStr(root.organization_id, 'E15.organization_id'),
    };
  }
  // Báo giá phải gắn ĐÚNG khoá trả lương sẽ gửi salary_payout_v1, nếu không F3 không bao giờ khớp.
  if (root.payout_request_key !== request.payoutKey) fail('E15.payout_request_key');
  return {
    kind: 'QUOTED',
    quote_id: str(root.quote_id, 'E15.quote_id'),
    shareholder_id: str(root.shareholder_id, 'E15.shareholder_id'),
    staff_id: request.staffId,
    period_month: month(root.period_month, 'E15.period_month'),
    organization_id: str(root.organization_id, 'E15.organization_id'),
    investment_amount: money(root.investment_amount, 'E15.investment_amount'),
    advance_offset_amount: money(root.advance_offset_amount, 'E15.advance_offset_amount'),
    investment_month: money(root.investment_month, 'E15.investment_month'),
    advance_offset_month: money(root.advance_offset_month, 'E15.advance_offset_month'),
    paid_investment: money(root.paid_investment, 'E15.paid_investment'),
    paid_offset: money(root.paid_offset, 'E15.paid_offset'),
    settled_by_marker: bool(root.settled_by_marker, 'E15.settled_by_marker'),
    sheet_status: oneOf(root.sheet_status, SALARY_SHEET_STATUSES, 'E15.sheet_status'),
    expected_voucher_amount: money(root.expected_voucher_amount, 'E15.expected_voucher_amount'),
    payout_request_key: request.payoutKey,
    expires_at: instant(root.expires_at, 'E15.expires_at'),
    voided_quote_ids: strList(root.voided_quote_ids, 'E15.voided_quote_ids'),
    offset_conflict: bool(root.offset_conflict, 'E15.offset_conflict'),
    needs_review_reason: optStr(root.needs_review_reason, 'E15.needs_review_reason'),
  };
}
