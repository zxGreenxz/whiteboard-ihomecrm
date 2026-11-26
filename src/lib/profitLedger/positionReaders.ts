// Bộ đọc tám RPC "tạm ứng cổ đông + chốt chi lợi nhuận theo tháng"
// (migration 20261118041911_tam_ung_co_dong_va_chot_chi_loi_nhuan.sql):
//   R1 shareholder_profit_positions_v1          vị thế mọi cổ đông (màn của chủ)
//   R2 shareholder_profit_my_position_v1        vị thế của chính mình + các lần chốt
//   R3 shareholder_profit_advance_options_v1    lựa chọn cho form Thu chi (KHÔNG có số tiền)
//   R4 shareholder_profit_advance_preview_v1    xem trước một phiếu tạm ứng
//   W1 shareholder_profit_advance_v1            lập phiếu tạm ứng
//   R5 shareholder_profit_settlement_preview_v1 xem trước chốt đến hết tháng N
//   W2 shareholder_profit_settle_v1             chốt
//   W3 shareholder_profit_settlement_void_v1    huỷ lần chốt không có phiếu tiền
//
// HAI CON SỐ (đã qua luật gấp một chiều của máy chủ):
//   unpaid_profit        "Lợi nhuận chưa chi"  — CÓ THỂ ÂM (mở chốt tháng đã chốt chi, mốc…)
//   advance_outstanding  "Tạm ứng đang có"     — luôn ≥ 0 (chỉ phiếu tạm ứng ĐÃ duyệt, chưa khấu trừ)
//   advance_pending      tạm ứng còn chờ duyệt — chưa được khấu trừ khi chốt
// Bất biến máy chủ bảo đảm: unpaid_profit − advance_outstanding − advance_pending = balance (số dư ròng).
// Bộ đọc kiểm lại bất biến đó: lệch là payload hỏng, không tự chọn một bên để hiện.

import { readProfitLedgerRoute, type ProfitLedgerRoute } from './route';
import {
  bool, fail, instant, list, money, month, obj, oneOf, optMoney, optMonth, optObj, optStr, sameMoney, str, uniqueBy,
  type PayloadRow,
} from './readPrimitives';
import {
  PAYOUT_MAKER_KINDS, readNeedsReview, readWarnings,
  type NeedsReviewSummary, type PayoutMakerKind, type PayoutWarning,
} from './sharedReaders';

/* ───────────────────────────── vị thế (dùng chung R1, R2, R4, R5) ───────────────────────────── */

/** Các phần máy chủ dựng hai con số từ đó. Ba trường `*_raw` / `advance_overoffset` chỉ để chẩn đoán — KHÔNG hiện. */
export interface ShareholderPositionComponents {
  allocated: number;
  payouts_pending: number;
  payouts_approved: number;
  salary_investment: number;
  salary_advance_offset: number;
  shared_fund_payable?: number;
  shared_fund_offset?: number;
  opening_advance?: number;
  unpaid_profit_raw: number;
  advance_outstanding_raw: number;
  /** Phần tạm ứng bị khấu trừ / trừ lương nhiều hơn tạm ứng đang có — đã gấp vào "lợi nhuận chưa chi". */
  advance_overoffset: number;
}

export interface ShareholderPosition {
  /** Lợi nhuận chưa chi (có thể âm). */
  unpaid_profit: number;
  /** Tạm ứng đã duyệt đang có (≥ 0). */
  advance_outstanding: number;
  /** Tạm ứng còn chờ duyệt (≥ 0) — chưa được khấu trừ. */
  advance_pending: number;
  /** Tiền của các lần chốt mà phiếu chi còn chờ duyệt (≥ 0). */
  settlement_cash_pending: number;
  /** Số dư ròng của sổ tổng = lợi nhuận chưa chi − tạm ứng đang có − tạm ứng chờ duyệt. */
  balance: number;
  /** Luỹ kế các lần chốt còn hiệu lực sau mốc: phần ghi nhận, phần khấu trừ tạm ứng, tiền. */
  settled: { recognized: number; offset: number; cash: number };
  last_settled_through_month: string | null;
  /** Tháng của mốc "đã trả đủ" đang hiệu lực; null = chưa có mốc. */
  marker_month: string | null;
  needs_review: NeedsReviewSummary;
  components: ShareholderPositionComponents;
}

function readComponents(value: unknown, path: string): ShareholderPositionComponents {
  const row = obj(value, path);
  // Ba trường được bổ sung cùng nhau khi bật sổ quỹ chung.
  const fund = 'shared_fund_payable' in row || 'shared_fund_offset' in row || 'opening_advance' in row ? {
    shared_fund_payable: nonNegative(money(row.shared_fund_payable, `${path}.shared_fund_payable`), `${path}.shared_fund_payable`),
    shared_fund_offset: nonNegative(money(row.shared_fund_offset, `${path}.shared_fund_offset`), `${path}.shared_fund_offset`),
    opening_advance: nonNegative(money(row.opening_advance, `${path}.opening_advance`), `${path}.opening_advance`),
  } : {};
  return {
    ...fund,
    allocated: money(row.allocated, `${path}.allocated`),
    payouts_pending: money(row.payouts_pending, `${path}.payouts_pending`),
    payouts_approved: money(row.payouts_approved, `${path}.payouts_approved`),
    salary_investment: money(row.salary_investment, `${path}.salary_investment`),
    salary_advance_offset: money(row.salary_advance_offset, `${path}.salary_advance_offset`),
    unpaid_profit_raw: money(row.unpaid_profit_raw, `${path}.unpaid_profit_raw`),
    advance_outstanding_raw: money(row.advance_outstanding_raw, `${path}.advance_outstanding_raw`),
    advance_overoffset: money(row.advance_overoffset, `${path}.advance_overoffset`),
  };
}

/** Số ≥ 0 (cho phép sai số đồng lẻ của số thực). */
function nonNegative(value: number, path: string): number {
  return value >= -0.005 ? value : fail(path);
}

export function readPosition(row: PayloadRow, path: string): ShareholderPosition {
  const unpaid = money(row.unpaid_profit, `${path}.unpaid_profit`);
  const outstanding = nonNegative(money(row.advance_outstanding, `${path}.advance_outstanding`), `${path}.advance_outstanding`);
  const pending = nonNegative(money(row.advance_pending, `${path}.advance_pending`), `${path}.advance_pending`);
  const balance = money(row.balance, `${path}.balance`);
  // Tự kiểm của máy chủ (PROFIT_LEDGER_POSITION_DRIFT) — kiểm lại để không hiện hai con số lệch số dư ròng.
  if (!sameMoney(unpaid - outstanding - pending, balance)) fail(`${path}.balance`);
  const settledRow = obj(row.settled, `${path}.settled`);
  const components = readComponents(row.components, `${path}.components`);
  // Luật gấp một chiều: số trả ra = số thô + phần gấp, phần gấp ≥ 0.
  if (components.advance_overoffset < -0.005
      || !sameMoney(unpaid, components.unpaid_profit_raw + components.advance_overoffset)
      || !sameMoney(outstanding, components.advance_outstanding_raw + components.advance_overoffset)) {
    fail(`${path}.components`);
  }
  return {
    unpaid_profit: unpaid,
    advance_outstanding: outstanding,
    advance_pending: pending,
    settlement_cash_pending: nonNegative(money(row.settlement_cash_pending, `${path}.settlement_cash_pending`), `${path}.settlement_cash_pending`),
    balance,
    settled: {
      recognized: money(settledRow.recognized, `${path}.settled.recognized`),
      offset: money(settledRow.offset, `${path}.settled.offset`),
      cash: money(settledRow.cash, `${path}.settled.cash`),
    },
    last_settled_through_month: optMonth(row.last_settled_through_month, `${path}.last_settled_through_month`),
    marker_month: optMonth(row.marker_month, `${path}.marker_month`),
    needs_review: readNeedsReview(row.needs_review, `${path}.needs_review`),
    components,
  };
}

/* ───────────────────────────── bản ghi chốt (R2, R5) ───────────────────────────── */

export interface ProfitSettlementRow {
  id: string;
  /** Chốt đến hết tháng này ('YYYY-MM-01'). */
  through_month: string;
  /** Phần lợi nhuận ghi nhận = khấu trừ tạm ứng + tiền. */
  recognized_amount: number;
  advance_offset_amount: number;
  cash_amount: number;
  /** Phiếu chi tiền của lần chốt; null ⇔ lần chốt không ra tiền (tiền = 0). */
  cash_voucher_id: string | null;
  cash_voucher_code: string | null;
  /** approval_status của phiếu tiền. */
  cash_voucher_status: string | null;
  cash_voucher_posting_status: string | null;
  created_at: string;
  /** Lần chốt nằm trước mốc "đã trả đủ" hiệu lực: không còn tính vào hai con số. */
  excluded_by_marker: boolean;
}

function readSettlementRow(row: PayloadRow, path: string): ProfitSettlementRow {
  const recognized = money(row.recognized_amount, `${path}.recognized_amount`);
  const offset = nonNegative(money(row.advance_offset_amount, `${path}.advance_offset_amount`), `${path}.advance_offset_amount`);
  const cash = nonNegative(money(row.cash_amount, `${path}.cash_amount`), `${path}.cash_amount`);
  if (!sameMoney(offset + cash, recognized)) fail(`${path}.recognized_amount`);
  const voucherId = optStr(row.cash_voucher_id, `${path}.cash_voucher_id`);
  // Có tiền ⇔ có phiếu (ràng buộc của bảng): nút "Huỷ chốt" chỉ dành cho lần chốt KHÔNG có phiếu.
  if ((cash > 0.005) !== (voucherId !== null && voucherId !== '')) fail(`${path}.cash_voucher_id`);
  return {
    id: str(row.id, `${path}.id`),
    through_month: month(row.through_month, `${path}.through_month`),
    recognized_amount: recognized,
    advance_offset_amount: offset,
    cash_amount: cash,
    cash_voucher_id: voucherId || null,
    cash_voucher_code: optStr(row.cash_voucher_code, `${path}.cash_voucher_code`),
    cash_voucher_status: optStr(row.cash_voucher_status, `${path}.cash_voucher_status`),
    cash_voucher_posting_status: optStr(row.cash_voucher_posting_status, `${path}.cash_voucher_posting_status`),
    created_at: instant(row.created_at, `${path}.created_at`),
    excluded_by_marker: bool(row.excluded_by_marker, `${path}.excluded_by_marker`),
  };
}

function readSettlements(value: unknown, path: string): ProfitSettlementRow[] {
  return uniqueBy(list(value, path, readSettlementRow), (row) => row.id, path);
}

/* ───────────────────────────── R1 shareholder_profit_positions_v1 ───────────────────────────── */

export interface ShareholderPositionRow extends ShareholderPosition {
  shareholder_id: string;
  name: string;
  is_active: boolean;
  /** Cổ đông đã xoá nhưng còn số khác 0 / còn phiếu lương cần xem lại. */
  is_deleted: boolean;
  has_login: boolean;
  /** Người này đang có quyền tạm ứng (tự ứng hoặc nhận phiếu Tạm Ứng lập hộ). */
  has_advance_right: boolean;
}

export interface ShareholderPositions {
  organization_id: string;
  route: ProfitLedgerRoute;
  as_of: string;
  shareholders: ShareholderPositionRow[];
}

export function readShareholderPositions(value: unknown, organizationId: string): ShareholderPositions {
  const root = obj(value, 'R1');
  if (root.organization_id !== organizationId) fail('R1.organization_id');
  const shareholders = list(root.shareholders, 'R1.shareholders', (row, path): ShareholderPositionRow => ({
    shareholder_id: str(row.shareholder_id, `${path}.shareholder_id`),
    name: str(row.name, `${path}.name`),
    is_active: bool(row.is_active, `${path}.is_active`),
    is_deleted: bool(row.is_deleted, `${path}.is_deleted`),
    has_login: bool(row.has_login, `${path}.has_login`),
    has_advance_right: bool(row.has_advance_right, `${path}.has_advance_right`),
    ...readPosition(row, path),
  }));
  return {
    organization_id: organizationId,
    route: readProfitLedgerRoute(str(root.route, 'R1.route')),
    as_of: instant(root.as_of, 'R1.as_of'),
    shareholders: uniqueBy(shareholders, (row) => row.shareholder_id, 'R1.shareholders'),
  };
}

/* ───────────────────────────── R2 shareholder_profit_my_position_v1 ───────────────────────────── */

export interface MyShareholderPosition extends ShareholderPosition {
  house_pool?: { contributed: number; reserved: number; paid: number; available: number };
  organization_id: string;
  route: ProfitLedgerRoute;
  shareholder: { id: string; name: string };
  /** Mọi lần chốt còn hiệu lực, mới nhất trước. */
  settlements: ProfitSettlementRow[];
}

export function readMyShareholderPosition(value: unknown, organizationId: string): MyShareholderPosition {
  const root = obj(value, 'R2');
  if (root.organization_id !== organizationId) fail('R2.organization_id');
  const shareholder = obj(root.shareholder, 'R2.shareholder');
  const pool = optObj(root.house_pool ?? null, 'R2.house_pool');
  return {
    organization_id: organizationId,
    route: readProfitLedgerRoute(str(root.route, 'R2.route')),
    shareholder: { id: str(shareholder.id, 'R2.shareholder.id'), name: str(shareholder.name, 'R2.shareholder.name') },
    ...readPosition(root, 'R2'),
    ...(pool && { house_pool: {
      contributed: money(pool.contributed, 'R2.house_pool.contributed'),
      reserved: nonNegative(money(pool.reserved, 'R2.house_pool.reserved'), 'R2.house_pool.reserved'),
      paid: nonNegative(money(pool.paid, 'R2.house_pool.paid'), 'R2.house_pool.paid'),
      available: money(pool.available, 'R2.house_pool.available'),
    } }),
    settlements: readSettlements(root.settlements, 'R2.settlements'),
  };
}

/* ───────────────────────────── R3 shareholder_profit_advance_options_v1 ───────────────────────────── */

export interface AdvanceOptionAccount {
  account_id: string;
  name: string;
}

export interface AdvanceOptionPayee {
  shareholder_id: string;
  name: string;
  /** Người nhận là chính người đang đăng nhập (tự tạm ứng). */
  is_self: boolean;
}

export interface AdvanceOptions {
  route: ProfitLedgerRoute;
  /** Sổ quỹ TIỀN THẬT người gọi đang giữ. */
  accounts: AdvanceOptionAccount[];
  /** Cổ đông đang có quyền tạm ứng; rỗng khi người gọi không giữ sổ nào. */
  payees: AdvanceOptionPayee[];
  /** Hạng mục "Tạm Ứng" của công ty; null khi công ty chưa có (lệnh lập tự tạo). */
  advance_type: { id: string; name: string } | null;
  /** Lập được phiếu Tạm Ứng ở Thu chi: sổ tổng chạy thật, có sổ đang giữ, có người nhận. */
  can_create: boolean;
}

export function readAdvanceOptions(value: unknown): AdvanceOptions {
  const root = obj(value, 'R3');
  const route = readProfitLedgerRoute(str(root.route, 'R3.route'));
  const accounts = uniqueBy(list(root.accounts, 'R3.accounts', (row, path): AdvanceOptionAccount => ({
    account_id: str(row.account_id, `${path}.account_id`),
    name: str(row.name, `${path}.name`),
  })), (row) => row.account_id, 'R3.accounts');
  const payees = uniqueBy(list(root.payees, 'R3.payees', (row, path): AdvanceOptionPayee => ({
    shareholder_id: str(row.shareholder_id, `${path}.shareholder_id`),
    name: str(row.name, `${path}.name`),
    is_self: bool(row.is_self, `${path}.is_self`),
  })), (row) => row.shareholder_id, 'R3.payees');
  const typeRow = optObj(root.advance_type, 'R3.advance_type');
  return {
    route,
    accounts,
    payees,
    advance_type: typeRow
      ? { id: str(typeRow.id, 'R3.advance_type.id'), name: str(typeRow.name, 'R3.advance_type.name') }
      : null,
    // Đóng an toàn: không mở chế độ Tạm Ứng chỉ vì cờ nói "được" khi thiếu sổ / người nhận / route lạ.
    can_create: bool(root.can_create, 'R3.can_create') && route === 'CANONICAL' && accounts.length > 0 && payees.length > 0,
  };
}

/* ───────────────────────────── R4 shareholder_profit_advance_preview_v1 ───────────────────────────── */

export const ADVANCE_BLOCKED_REASONS = ['ROUTE', 'NOT_CUSTODIAN', 'PAYEE_NO_RIGHT', 'SALARY_REVIEW_PENDING'] as const;
/** Lý do khoá gửi; 'OTHER' = mã máy chủ mới chưa biết (vẫn khoá — đóng an toàn). */
export type AdvanceBlockedReason = (typeof ADVANCE_BLOCKED_REASONS)[number] | 'OTHER';

export interface AdvancePreviewPosition extends ShareholderPosition {
  /** Sau khi lập phiếu này (phiếu chờ duyệt); null khi chưa nhập số tiền. */
  after_advance: { advance_pending: number; balance: number } | null;
}

export interface AdvancePreview {
  route: ProfitLedgerRoute;
  shareholder_id: string;
  /** CUSTODIAN_ADVANCE: tự tạm ứng · CUSTODIAN_FOR_PAYEE: người giữ sổ lập hộ. */
  maker_kind: PayoutMakerKind;
  payee_is_maker: boolean;
  can_submit: boolean;
  blocked_reason: AdvanceBlockedReason | null;
  warnings: PayoutWarning[];
  /**
   * Số của cổ đông — máy chủ CHỈ trả cho người có quyền chi lợi nhuận hoặc chính người nhận đang có
   * quyền tạm ứng. Người giữ sổ lập hộ nhận `null` (không được thấy số của cổ đông).
   */
  position: AdvancePreviewPosition | null;
}

export interface AdvancePreviewRequest {
  shareholderId: string;
  amount: number | null;
  accountId: string | null;
}

function readBlocked<T extends string>(value: unknown, known: readonly T[], path: string): T | 'OTHER' | null {
  if (value === null) return null;
  const code = str(value, path);
  return (known as readonly string[]).includes(code) ? (code as T) : 'OTHER';
}

export function readAdvancePreview(value: unknown, request: AdvancePreviewRequest): AdvancePreview {
  const root = obj(value, 'R4');
  if (root.shareholder_id !== request.shareholderId) fail('R4.shareholder_id');
  const payeeIsMaker = bool(root.payee_is_maker, 'R4.payee_is_maker');
  const makerKind = oneOf(root.maker_kind, PAYOUT_MAKER_KINDS, 'R4.maker_kind');
  // Lệnh tạm ứng chỉ có hai cách lập, và cách lập phải khớp "người nhận là người lập".
  if (makerKind !== (payeeIsMaker ? 'CUSTODIAN_ADVANCE' : 'CUSTODIAN_FOR_PAYEE')) fail('R4.maker_kind');
  const positionRow = optObj(root.position, 'R4.position');
  let position: AdvancePreviewPosition | null = null;
  if (positionRow) {
    const base = readPosition(positionRow, 'R4.position');
    const afterRow = optObj(positionRow.after_advance, 'R4.position.after_advance');
    let after: AdvancePreviewPosition['after_advance'] = null;
    if (request.amount === null) {
      if (afterRow) fail('R4.position.after_advance');
    } else {
      const row = afterRow ?? fail('R4.position.after_advance');
      after = {
        advance_pending: money(row.advance_pending, 'R4.position.after_advance.advance_pending'),
        balance: money(row.balance, 'R4.position.after_advance.balance'),
      };
      // Phiếu mới là phiếu chờ duyệt: cộng đúng số tiền vào "chờ duyệt", trừ đúng số tiền khỏi số dư ròng.
      if (!sameMoney(after.advance_pending, base.advance_pending + request.amount)
          || !sameMoney(after.balance, base.balance - request.amount)) {
        fail('R4.position.after_advance');
      }
    }
    position = { ...base, after_advance: after };
  }
  const blocked = readBlocked(root.blocked_reason, ADVANCE_BLOCKED_REASONS, 'R4.blocked_reason');
  return {
    route: readProfitLedgerRoute(str(root.route, 'R4.route')),
    shareholder_id: request.shareholderId,
    maker_kind: root.owner_workflow === true ? 'OWNER' : makerKind,
    payee_is_maker: payeeIsMaker,
    // Không tin can_submit khi còn lý do khoá, hoặc khi chưa đủ số tiền + sổ quỹ.
    can_submit: bool(root.can_submit, 'R4.can_submit') && blocked === null && request.amount !== null && request.accountId !== null,
    blocked_reason: blocked,
    warnings: readWarnings(root.warnings, 'R4.warnings'),
    position,
  };
}

/* ───────────────────────────── W1 shareholder_profit_advance_v1 ───────────────────────────── */

export interface AdvanceResult {
  voucher_id: string;
  approval_request_id: string;
  shareholder_id: string;
  amount: number;
  /** Luôn 0: mọi khoản ứng đều là tạm ứng. */
  within_amount: number;
  advance_amount: number;
  /** Số dư ròng trước phiếu; null với người giữ sổ lập hộ (không được thấy số của cổ đông). */
  balance_before: number | null;
  warnings: PayoutWarning[];
  maker_kind: PayoutMakerKind;
  payout_kind: 'ADVANCE';
  state: 'PENDING_APPROVAL';
}

export function readAdvanceResult(value: unknown, request: { shareholderId: string; amount: number }): AdvanceResult {
  const root = obj(value, 'W1');
  if (root.shareholder_id !== request.shareholderId) fail('W1.shareholder_id');
  const amount = money(root.amount, 'W1.amount');
  if (!sameMoney(amount, request.amount)) fail('W1.amount');
  const within = money(root.within_amount, 'W1.within_amount');
  const advance = money(root.advance_amount, 'W1.advance_amount');
  if (!sameMoney(within, 0) || !sameMoney(advance, amount)) fail('W1.advance_amount');
  const makerKind = oneOf(root.maker_kind, PAYOUT_MAKER_KINDS, 'W1.maker_kind');
  if (makerKind === 'OWNER') fail('W1.maker_kind');
  return {
    voucher_id: str(root.voucher_id, 'W1.voucher_id'),
    approval_request_id: str(root.approval_request_id, 'W1.approval_request_id'),
    shareholder_id: request.shareholderId,
    amount,
    within_amount: within,
    advance_amount: advance,
    balance_before: optMoney(root.balance_before, 'W1.balance_before'),
    warnings: readWarnings(root.warnings, 'W1.warnings'),
    maker_kind: root.owner_workflow === true ? 'OWNER' : makerKind,
    payout_kind: oneOf(root.payout_kind, ['ADVANCE'] as const, 'W1.payout_kind'),
    state: oneOf(root.state, ['PENDING_APPROVAL'] as const, 'W1.state'),
  };
}

/* ───────────────────────────── R5 shareholder_profit_settlement_preview_v1 ───────────────────────────── */

export const SETTLEMENT_BLOCKED_REASONS = ['ROUTE', 'SALARY_REVIEW_PENDING', 'NOTHING_TO_SETTLE', 'ACCOUNT_REQUIRED'] as const;
export type SettlementBlockedReason = (typeof SETTLEMENT_BLOCKED_REASONS)[number] | 'OTHER';

export interface SettlementMonth {
  /** 'YYYY-MM-01'. */
  month: string;
  /** Phần được chia của riêng tháng (tháng lỗ thì âm). */
  allocated: number;
  /** Lợi nhuận chưa chi luỹ kế đến hết tháng này (có thể ≤ 0). */
  unpaid_through: number;
  /** Chốt đến tháng này được (đủ điều kiện và luỹ kế > 0). */
  selectable: boolean;
}

export interface SettlementPreview {
  route: ProfitLedgerRoute;
  shareholder_id: string;
  months: SettlementMonth[];
  /** Tháng chọn được nhỏ nhất; null = không tháng nào chọn được. */
  min_through_month: string | null;
  /** Tháng đang xem trước; null = cổ đông không còn tháng đủ điều kiện nào. */
  through_month: string | null;
  position: ShareholderPosition;
  /** Lợi nhuận chưa chi đến hết tháng đó; ≤ 0 = không còn gì để chốt; null khi không có tháng. */
  recognized_amount: number | null;
  /** Khấu trừ tạm ứng; null khi không có gì để chốt. */
  advance_offset_amount: number | null;
  /** Thực chi; null khi không có gì để chốt. */
  cash_amount: number | null;
  /** Tạm ứng còn lại sau lần chốt; null khi không có gì để chốt. */
  advance_left: number | null;
  /** Tạm ứng còn chờ duyệt — KHÔNG được khấu trừ trong lần chốt này. */
  advance_pending: number;
  /** Các lần chốt còn hiệu lực của cổ đông, mới nhất trước. */
  settlements: ProfitSettlementRow[];
  can_submit: boolean;
  blocked_reason: SettlementBlockedReason | null;
}

export interface SettlementPreviewRequest {
  shareholderId: string;
  /** null = để máy chủ chọn tháng đủ điều kiện mới nhất. */
  throughMonth: string | null;
  accountId: string | null;
}

export function readSettlementPreview(value: unknown, request: SettlementPreviewRequest): SettlementPreview {
  const root = obj(value, 'R5');
  if (root.shareholder_id !== request.shareholderId) fail('R5.shareholder_id');
  const months = uniqueBy(list(root.months, 'R5.months', (row, path): SettlementMonth => {
    const unpaidThrough = money(row.unpaid_through, `${path}.unpaid_through`);
    const selectable = bool(row.selectable, `${path}.selectable`);
    // Tháng chọn được phải còn lợi nhuận chưa chi luỹ kế > 0.
    if (selectable && !(unpaidThrough > 0)) fail(`${path}.selectable`);
    return {
      month: month(row.month, `${path}.month`),
      allocated: money(row.allocated, `${path}.allocated`),
      unpaid_through: unpaidThrough,
      selectable,
    };
  }), (row) => row.month, 'R5.months');
  const through = optMonth(root.through_month, 'R5.through_month');
  if (request.throughMonth !== null && through !== request.throughMonth) fail('R5.through_month');
  const position = readPosition(obj(root.position, 'R5.position'), 'R5.position');
  const recognized = optMoney(root.recognized_amount, 'R5.recognized_amount');
  const offset = optMoney(root.advance_offset_amount, 'R5.advance_offset_amount');
  const cash = optMoney(root.cash_amount, 'R5.cash_amount');
  const left = optMoney(root.advance_left, 'R5.advance_left');
  if (through === null) {
    if (recognized !== null) fail('R5.recognized_amount');
  } else {
    // Số ghi nhận của tháng đang xem phải là số luỹ kế của đúng tháng đó trong danh sách.
    const row = months.find((m) => m.month === through) ?? fail('R5.through_month');
    if (recognized === null || !sameMoney(recognized, row.unpaid_through)) fail('R5.recognized_amount');
  }
  const settleable = recognized !== null && recognized > 0;
  if (settleable) {
    // K + tiền = X; K, tiền ≥ 0; tạm ứng còn lại = tạm ứng đang có − K (không âm).
    if (offset === null || cash === null || left === null || offset < -0.005 || cash < -0.005 || left < -0.005
        || !sameMoney(offset + cash, recognized) || !sameMoney(left, position.advance_outstanding - offset)) {
      fail('R5.cash_amount');
    }
  } else if (offset !== null || cash !== null) {
    fail('R5.cash_amount');
  }
  const pending = money(root.advance_pending, 'R5.advance_pending');
  if (!sameMoney(pending, position.advance_pending)) fail('R5.advance_pending');
  const blocked = readBlocked(root.blocked_reason, SETTLEMENT_BLOCKED_REASONS, 'R5.blocked_reason');
  return {
    route: readProfitLedgerRoute(str(root.route, 'R5.route')),
    shareholder_id: request.shareholderId,
    months,
    min_through_month: optMonth(root.min_through_month, 'R5.min_through_month'),
    through_month: through,
    position,
    recognized_amount: recognized,
    advance_offset_amount: settleable ? offset : null,
    cash_amount: settleable ? cash : null,
    advance_left: settleable ? left : null,
    advance_pending: pending,
    settlements: readSettlements(root.settlements, 'R5.settlements'),
    // Không tin can_submit khi còn lý do khoá hoặc khi không có gì để chốt.
    can_submit: bool(root.can_submit, 'R5.can_submit') && blocked === null && settleable,
    blocked_reason: blocked,
  };
}

/* ───────────────────────────── W2 shareholder_profit_settle_v1 ───────────────────────────── */

export interface SettleResult {
  settlement_id: string;
  through_month: string;
  recognized_amount: number;
  advance_offset_amount: number;
  cash_amount: number;
  /** Phiếu chi tiền chờ duyệt; null khi lần chốt không ra tiền. */
  voucher_id: string | null;
  approval_request_id: string | null;
  /** PENDING_APPROVAL: có phiếu chi chờ duyệt · SETTLED: không ra tiền, có hiệu lực ngay. */
  state: 'PENDING_APPROVAL' | 'SETTLED';
}

export function readSettleResult(value: unknown, request: { throughMonth: string }): SettleResult {
  const root = obj(value, 'W2');
  const through = month(root.through_month, 'W2.through_month');
  if (through !== request.throughMonth) fail('W2.through_month');
  const recognized = money(root.recognized_amount, 'W2.recognized_amount');
  const offset = money(root.advance_offset_amount, 'W2.advance_offset_amount');
  const cash = money(root.cash_amount, 'W2.cash_amount');
  if (!(recognized > 0) || offset < -0.005 || cash < -0.005 || !sameMoney(offset + cash, recognized)) fail('W2.recognized_amount');
  const voucherId = optStr(root.voucher_id, 'W2.voucher_id') || null;
  const state = oneOf(root.state, ['PENDING_APPROVAL', 'SETTLED'] as const, 'W2.state');
  // Có tiền ⇔ có phiếu chờ duyệt; không tiền ⇔ không phiếu, có hiệu lực ngay.
  const hasCash = cash > 0.005;
  if (hasCash !== (voucherId !== null) || hasCash !== (state === 'PENDING_APPROVAL')) fail('W2.state');
  return {
    settlement_id: str(root.settlement_id, 'W2.settlement_id'),
    through_month: through,
    recognized_amount: recognized,
    advance_offset_amount: offset,
    cash_amount: cash,
    voucher_id: voucherId,
    approval_request_id: optStr(root.approval_request_id, 'W2.approval_request_id') || null,
    state,
  };
}

/* ───────────────────────────── W3 shareholder_profit_settlement_void_v1 ───────────────────────────── */

export interface SettlementVoidResult {
  settlement_id: string;
  state: 'VOID';
}

export function readSettlementVoidResult(value: unknown, settlementId: string): SettlementVoidResult {
  const root = obj(value, 'W3');
  if (root.settlement_id !== settlementId) fail('W3.settlement_id');
  return { settlement_id: settlementId, state: oneOf(root.state, ['VOID'] as const, 'W3.state') };
}
