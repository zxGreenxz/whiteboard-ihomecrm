// Bộ đọc các RPC ĐỌC của sổ tổng: E1 (sổ tổng cổ đông), E2 (sổ chi tiết), E3 (cổ đông tự xem),
// E7 (chi tiết một phiếu chi), E10 (sổ lương điều hành).
// Nguồn hợp đồng: supabase/migrations/20261115083533_so_tong_loi_nhuan_doc.sql (+ d1_doc_interface.md).

import { readProfitLedgerRoute, type ProfitLedgerRoute } from './route';
import {
  bool, count, day, fail, instant, list, money, month, obj, oneOf, optDay, optMoney, optObj, optStr,
  sameMoney, str, uniqueBy, type PayloadRow,
} from './readPrimitives';
import {
  PAYOUT_MAKER_KINDS, PROFIT_LEDGER_SUBJECT_KINDS, readBalanceStatus, readExcluded, readMarker,
  readNeedsReview, readWarnings,
  type ExcludedBeforeMarker, type LedgerBalanceStatus, type NeedsReviewSummary, type PayoutMakerKind,
  type PayoutWarning, type ProfitLedgerMarker, type ProfitLedgerSubjectKind,
} from './sharedReaders';

/* ───────────────────────────── E1 shareholder_profit_ledger_v1 ───────────────────────────── */

export interface ShareholderLedgerRow {
  shareholder_id: string;
  name: string;
  is_active: boolean;
  /** Cổ đông đã xoá nhưng còn số (số dư ≠ 0, phiếu chờ duyệt, hoặc phiếu lương chờ xem lại). */
  is_deleted: boolean;
  has_login: boolean;
  marker: ProfitLedgerMarker | null;
  /** Phân bổ các tháng đã chốt SAU mốc. */
  allocated: number;
  /** Phiếu đã duyệt (kể cả chưa chi tiền). */
  payouts_approved: number;
  /** Phiếu đang chờ duyệt — đã trừ vào số dư. */
  payouts_pending: number;
  /** ΣY_i: phần lợi nhuận đã trả qua phiếu lương. */
  salary_investment: number;
  /** ΣD_i: phần lương đã trừ để bù tạm ứng. */
  salary_advance_offset: number;
  /** = allocated − payouts_approved − payouts_pending − (salary_investment − salary_advance_offset). */
  balance: number;
  status: LedgerBalanceStatus;
  /** = max(−balance, 0): số đang tạm ứng chưa bù. */
  open_advance: number;
  needs_review_count: number;
}

export interface ShareholderLedger {
  organization_id: string;
  route: ProfitLedgerRoute;
  as_of: string;
  shareholders: ShareholderLedgerRow[];
}

function readShareholderRow(row: PayloadRow, path: string): ShareholderLedgerRow {
  const balance = money(row.balance, `${path}.balance`);
  const openAdvance = money(row.open_advance, `${path}.open_advance`);
  if (!sameMoney(openAdvance, Math.max(-balance, 0))) fail(`${path}.open_advance`);
  return {
    shareholder_id: str(row.shareholder_id, `${path}.shareholder_id`),
    name: str(row.name, `${path}.name`),
    is_active: bool(row.is_active, `${path}.is_active`),
    is_deleted: bool(row.is_deleted, `${path}.is_deleted`),
    has_login: bool(row.has_login, `${path}.has_login`),
    marker: readMarker(row.marker, `${path}.marker`),
    allocated: money(row.allocated, `${path}.allocated`),
    payouts_approved: money(row.payouts_approved, `${path}.payouts_approved`),
    payouts_pending: money(row.payouts_pending, `${path}.payouts_pending`),
    salary_investment: money(row.salary_investment, `${path}.salary_investment`),
    salary_advance_offset: money(row.salary_advance_offset, `${path}.salary_advance_offset`),
    balance,
    status: readBalanceStatus(row.status, balance, `${path}.status`),
    open_advance: openAdvance,
    needs_review_count: count(row.needs_review_count, `${path}.needs_review_count`),
  };
}

export function readShareholderLedger(value: unknown, organizationId: string): ShareholderLedger {
  const root = obj(value, 'E1');
  if (root.organization_id !== organizationId) fail('E1.organization_id');
  return {
    organization_id: organizationId,
    route: readProfitLedgerRoute(str(root.route, 'E1.route')),
    as_of: instant(root.as_of, 'E1.as_of'),
    shareholders: uniqueBy(list(root.shareholders, 'E1.shareholders', readShareholderRow), (r) => r.shareholder_id, 'E1.shareholders'),
  };
}

/* ─────────────────────────── E2 shareholder_profit_ledger_entries_v1 ─────────────────────────── */

export const LEDGER_ENTRY_KINDS = ['ALLOCATION', 'PAYOUT', 'SALARY', 'SALARY_OFFSET', 'SALARY_REVIEW'] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export interface ShareholderLedgerEntry {
  /** Khoá React duy nhất: `kind:(line_id ?? voucher_id)`. */
  key: string;
  kind: LedgerEntryKind;
  line_id: string | null;
  period_month: string | null;
  building_id: string | null;
  building_name: string | null;
  /** Số có dấu: +phân bổ, −phiếu chi, −Y_i, +D_i, 0 (SALARY_REVIEW). */
  amount: number;
  /** Chỉ SALARY_REVIEW: phần đầu tư máy gợi ý. */
  suggested: number | null;
  voucher_id: string | null;
  voucher_code: string | null;
  voucher_date: string | null;
  /** approval_status của phiếu ('APPROVED' | 'UNAPPROVED' …). */
  voucher_status: string | null;
  /** Chỉ PAYOUT: posting_status ('UNPOSTED' | 'POSTED' | null …). */
  posting_status: string | null;
  account_name: string | null;
  maker_user_id: string | null;
  is_mine: boolean;
  is_advance: boolean;
  created_at: string;
  /** Dòng nằm trước mốc: hiện mờ, không vào số dư. */
  excluded_by_marker: boolean;
  running_balance: number;
}

export interface ShareholderLedgerTotals {
  allocated: number;
  payouts_approved: number;
  payouts_pending: number;
  salary_investment: number;
  salary_advance_offset: number;
  balance: number;
  status: LedgerBalanceStatus;
  excluded_before_marker: ExcludedBeforeMarker;
  needs_review: NeedsReviewSummary;
}

export interface LedgerSubjectSummary {
  shareholder_id: string;
  name: string;
  is_active: boolean;
  is_deleted: boolean;
  has_login: boolean;
}

export interface ShareholderLedgerEntries {
  organization_id: string;
  shareholder: LedgerSubjectSummary;
  marker: ProfitLedgerMarker | null;
  totals: ShareholderLedgerTotals;
  entries: ShareholderLedgerEntry[];
}

function readEntry(row: PayloadRow, path: string): ShareholderLedgerEntry {
  const kind = oneOf(row.kind, LEDGER_ENTRY_KINDS, `${path}.kind`);
  const lineId = optStr(row.line_id, `${path}.line_id`);
  const voucherId = optStr(row.voucher_id, `${path}.voucher_id`);
  const identity = lineId ?? voucherId;
  if (!identity) fail(`${path}.line_id`);
  return {
    key: `${kind}:${identity}`,
    kind,
    line_id: lineId,
    period_month: row.period_month === null ? null : month(row.period_month, `${path}.period_month`),
    building_id: optStr(row.building_id, `${path}.building_id`),
    building_name: optStr(row.building_name, `${path}.building_name`),
    amount: money(row.amount, `${path}.amount`),
    suggested: optMoney(row.suggested, `${path}.suggested`),
    voucher_id: voucherId,
    voucher_code: optStr(row.voucher_code, `${path}.voucher_code`),
    voucher_date: optDay(row.voucher_date, `${path}.voucher_date`),
    voucher_status: optStr(row.voucher_status, `${path}.voucher_status`),
    posting_status: optStr(row.posting_status, `${path}.posting_status`),
    account_name: optStr(row.account_name, `${path}.account_name`),
    maker_user_id: optStr(row.maker_user_id, `${path}.maker_user_id`),
    is_mine: bool(row.is_mine, `${path}.is_mine`),
    is_advance: bool(row.is_advance, `${path}.is_advance`),
    created_at: instant(row.created_at, `${path}.created_at`),
    excluded_by_marker: bool(row.excluded_by_marker, `${path}.excluded_by_marker`),
    running_balance: money(row.running_balance, `${path}.running_balance`),
  };
}

function readSubjectSummary(value: unknown, path: string): LedgerSubjectSummary {
  const row = obj(value, path);
  return {
    shareholder_id: str(row.shareholder_id, `${path}.shareholder_id`),
    name: str(row.name, `${path}.name`),
    is_active: bool(row.is_active, `${path}.is_active`),
    is_deleted: bool(row.is_deleted, `${path}.is_deleted`),
    has_login: bool(row.has_login, `${path}.has_login`),
  };
}

export function readShareholderLedgerEntries(value: unknown, organizationId: string, shareholderId: string): ShareholderLedgerEntries {
  const root = obj(value, 'E2');
  if (root.organization_id !== organizationId) fail('E2.organization_id');
  const shareholder = readSubjectSummary(root.shareholder, 'E2.shareholder');
  if (shareholder.shareholder_id !== shareholderId) fail('E2.shareholder.shareholder_id');
  const t = obj(root.totals, 'E2.totals');
  const balance = money(t.balance, 'E2.totals.balance');
  const totals: ShareholderLedgerTotals = {
    allocated: money(t.allocated, 'E2.totals.allocated'),
    payouts_approved: money(t.payouts_approved, 'E2.totals.payouts_approved'),
    payouts_pending: money(t.payouts_pending, 'E2.totals.payouts_pending'),
    salary_investment: money(t.salary_investment, 'E2.totals.salary_investment'),
    salary_advance_offset: money(t.salary_advance_offset, 'E2.totals.salary_advance_offset'),
    balance,
    status: readBalanceStatus(t.status, balance, 'E2.totals.status'),
    excluded_before_marker: readExcluded(t.excluded_before_marker, 'E2.totals.excluded_before_marker'),
    needs_review: readNeedsReview(t.needs_review, 'E2.totals.needs_review'),
  };
  const entries = uniqueBy(list(root.entries, 'E2.entries', readEntry), (e) => e.key, 'E2.entries');
  // Bất biến của máy chủ (đã kiểm ở doc_shareholder_v1): số dư chạy của dòng cuối = số dư sổ.
  const last = entries.length ? entries[entries.length - 1]!.running_balance : 0;
  if (!sameMoney(last, balance)) fail('E2.entries.running_balance');
  return { organization_id: organizationId, shareholder, marker: readMarker(root.marker, 'E2.marker'), totals, entries };
}

/* ───────────────────────────── E3 shareholder_profit_my_ledger_v1 ───────────────────────────── */

export interface MyLedgerMonthBuilding {
  building_id: string | null;
  building_name: string | null;
  amount: number;
}

export interface MyLedgerMonth {
  period_month: string;
  amount: number;
  excluded_by_marker: boolean;
  buildings: MyLedgerMonthBuilding[];
}

export interface MyLedgerPayout {
  voucher_id: string;
  voucher_code: string | null;
  voucher_date: string | null;
  /** Số DƯƠNG. */
  amount: number;
  /** approval_status của phiếu. */
  status: string | null;
  posting_status: string | null;
  is_advance: boolean;
  is_mine: boolean;
  /** Phiếu do chính mình lập còn chờ duyệt — tự huỷ được. */
  is_mine_pending: boolean;
  excluded_by_marker: boolean;
}

export interface MyLedgerSalary {
  period_month: string;
  investment: number;
  advance_offset: number;
  excluded_by_marker: boolean;
}

export interface MyPercentRow {
  building_id: string;
  building_name: string | null;
  percent: number;
}

export interface MyBuildingTotal {
  period_month: string;
  building_id: string;
  building_name: string | null;
  /** null: tháng chốt trước khi có số nguồn (bản chốt cũ) — KHÔNG phải 0. */
  revenue: number | null;
  expense: number | null;
  profit: number;
}

export interface MyProfitLedger {
  organization_id: string;
  route: ProfitLedgerRoute;
  /** true từ SHADOW trở đi: màn tự xem đọc sổ tổng; false (LEGACY) giữ thân cũ. */
  ready: boolean;
  shareholder: { id: string; name: string };
  balance: number;
  status: LedgerBalanceStatus;
  allocated: number;
  /** = payouts_approved. */
  paid: number;
  /** = payouts_pending. */
  paid_pending: number;
  /** ΣY_i. */
  paid_via_salary: number;
  /** ΣD_i. */
  advance_recovered: number;
  marker: { settled_through_month: string } | null;
  months: MyLedgerMonth[];
  payouts: MyLedgerPayout[];
  salary: MyLedgerSalary[];
  /** CHỈ có khi người xem có shareholder_profit.view_percent (khoá vắng ⇒ undefined). */
  percent_rows?: MyPercentRow[];
  /** CHỈ có khi người xem có shareholder_profit.view_building_totals. */
  building_totals?: MyBuildingTotal[];
}

function readMyMonth(row: PayloadRow, path: string): MyLedgerMonth {
  return {
    period_month: month(row.period_month, `${path}.period_month`),
    amount: money(row.amount, `${path}.amount`),
    excluded_by_marker: bool(row.excluded_by_marker, `${path}.excluded_by_marker`),
    buildings: list(row.buildings, `${path}.buildings`, (b, p) => ({
      building_id: optStr(b.building_id, `${p}.building_id`),
      building_name: optStr(b.building_name, `${p}.building_name`),
      amount: money(b.amount, `${p}.amount`),
    })),
  };
}

function readMyPayout(row: PayloadRow, path: string): MyLedgerPayout {
  return {
    voucher_id: str(row.voucher_id, `${path}.voucher_id`),
    voucher_code: optStr(row.voucher_code, `${path}.voucher_code`),
    voucher_date: optDay(row.voucher_date, `${path}.voucher_date`),
    amount: money(row.amount, `${path}.amount`),
    status: optStr(row.status, `${path}.status`),
    posting_status: optStr(row.posting_status, `${path}.posting_status`),
    is_advance: bool(row.is_advance, `${path}.is_advance`),
    is_mine: bool(row.is_mine, `${path}.is_mine`),
    is_mine_pending: bool(row.is_mine_pending, `${path}.is_mine_pending`),
    excluded_by_marker: bool(row.excluded_by_marker, `${path}.excluded_by_marker`),
  };
}

export function readMyProfitLedger(value: unknown, organizationId: string): MyProfitLedger {
  const root = obj(value, 'E3');
  if (root.organization_id !== organizationId) fail('E3.organization_id');
  const route = readProfitLedgerRoute(str(root.route, 'E3.route'));
  const shareholder = obj(root.shareholder, 'E3.shareholder');
  const balance = money(root.balance, 'E3.balance');
  const markerRow = optObj(root.marker, 'E3.marker');
  const result: MyProfitLedger = {
    organization_id: organizationId,
    route,
    // Route lạ đã quy về LEGACY ⇒ không hiện sổ tổng như số chính thức dù máy chủ nói ready.
    ready: bool(root.ready, 'E3.ready') && route !== 'LEGACY',
    shareholder: { id: str(shareholder.id, 'E3.shareholder.id'), name: str(shareholder.name, 'E3.shareholder.name') },
    balance,
    status: readBalanceStatus(root.status, balance, 'E3.status'),
    allocated: money(root.allocated, 'E3.allocated'),
    paid: money(root.paid, 'E3.paid'),
    paid_pending: money(root.paid_pending, 'E3.paid_pending'),
    paid_via_salary: money(root.paid_via_salary, 'E3.paid_via_salary'),
    advance_recovered: money(root.advance_recovered, 'E3.advance_recovered'),
    marker: markerRow ? { settled_through_month: month(markerRow.settled_through_month, 'E3.marker.settled_through_month') } : null,
    months: list(root.months, 'E3.months', readMyMonth),
    payouts: list(root.payouts, 'E3.payouts', readMyPayout),
    salary: list(root.salary, 'E3.salary', (row, path) => ({
      period_month: month(row.period_month, `${path}.period_month`),
      investment: money(row.investment, `${path}.investment`),
      advance_offset: money(row.advance_offset, `${path}.advance_offset`),
      excluded_by_marker: bool(row.excluded_by_marker, `${path}.excluded_by_marker`),
    })),
  };
  // Hai mảng nhạy cảm: chỉ đọc khi KHOÁ có mặt (máy chủ bỏ hẳn khoá khi thiếu quyền). Không chép
  // khoá lạ nào khác của payload vào kết quả.
  if ('percent_rows' in root) {
    result.percent_rows = list(root.percent_rows, 'E3.percent_rows', (row, path) => ({
      building_id: str(row.building_id, `${path}.building_id`),
      building_name: optStr(row.building_name, `${path}.building_name`),
      percent: money(row.percent, `${path}.percent`),
    }));
  }
  if ('building_totals' in root) {
    result.building_totals = list(root.building_totals, 'E3.building_totals', (row, path) => ({
      period_month: month(row.period_month, `${path}.period_month`),
      building_id: str(row.building_id, `${path}.building_id`),
      building_name: optStr(row.building_name, `${path}.building_name`),
      revenue: optMoney(row.revenue, `${path}.revenue`),
      expense: optMoney(row.expense, `${path}.expense`),
      profit: money(row.profit, `${path}.profit`),
    }));
  }
  return result;
}

/* ───────────────────────────── E7 profit_ledger_payout_detail_v1 ───────────────────────────── */

export interface LedgerPayoutDetail {
  organization_id: string;
  route: ProfitLedgerRoute;
  voucher: {
    id: string;
    code: string | null;
    voucher_date: string;
    amount: number;
    approval_status: string;
    posting_status: string | null;
    system_source: string | null;
    account_id: string | null;
    account_name: string | null;
    /** Phiếu còn sống (đã duyệt, hoặc chờ duyệt mà yêu cầu chưa bị từ chối/rút). */
    is_live: boolean;
    created_at: string;
  };
  subject: { kind: ProfitLedgerSubjectKind; id: string; name: string; is_deleted: boolean; has_login: boolean };
  /** Lúc lập (dòng sổ C2); null với phiếu cũ không lập qua sổ tổng. */
  at_create: {
    balance_before: number;
    within: number;
    advance: number;
    warnings: PayoutWarning[];
    maker_kind: PayoutMakerKind;
    payee_is_maker: boolean;
  } | null;
  /** Bây giờ: số dư nếu bỏ chính phiếu này; MANAGER mà advance > 0 ⇒ duyệt sẽ bị từ chối. */
  now: { balance_excluding_this: number; within: number; advance: number };
}

export function readLedgerPayoutDetail(value: unknown, voucherId: string): LedgerPayoutDetail {
  const root = obj(value, 'E7');
  const v = obj(root.voucher, 'E7.voucher');
  if (v.id !== voucherId) fail('E7.voucher.id');
  const amount = money(v.amount, 'E7.voucher.amount');
  const s = obj(root.subject, 'E7.subject');
  const atCreateRow = optObj(root.at_create, 'E7.at_create');
  const nowRow = obj(root.now, 'E7.now');
  const now = {
    balance_excluding_this: money(nowRow.balance_excluding_this, 'E7.now.balance_excluding_this'),
    within: money(nowRow.within, 'E7.now.within'),
    advance: money(nowRow.advance, 'E7.now.advance'),
  };
  if (!sameMoney(now.within + now.advance, amount)) fail('E7.now');
  let atCreate: LedgerPayoutDetail['at_create'] = null;
  if (atCreateRow) {
    atCreate = {
      balance_before: money(atCreateRow.balance_before, 'E7.at_create.balance_before'),
      within: money(atCreateRow.within, 'E7.at_create.within'),
      advance: money(atCreateRow.advance, 'E7.at_create.advance'),
      warnings: readWarnings(atCreateRow.warnings, 'E7.at_create.warnings'),
      maker_kind: oneOf(atCreateRow.maker_kind, PAYOUT_MAKER_KINDS, 'E7.at_create.maker_kind'),
      payee_is_maker: bool(atCreateRow.payee_is_maker, 'E7.at_create.payee_is_maker'),
    };
    if (!sameMoney(atCreate.within + atCreate.advance, amount)) fail('E7.at_create');
  }
  return {
    organization_id: str(root.organization_id, 'E7.organization_id'),
    route: readProfitLedgerRoute(str(root.route, 'E7.route')),
    voucher: {
      id: voucherId,
      code: optStr(v.code, 'E7.voucher.code'),
      voucher_date: day(v.voucher_date, 'E7.voucher.voucher_date'),
      amount,
      approval_status: str(v.approval_status, 'E7.voucher.approval_status'),
      posting_status: optStr(v.posting_status, 'E7.voucher.posting_status'),
      system_source: optStr(v.system_source, 'E7.voucher.system_source'),
      account_id: optStr(v.account_id, 'E7.voucher.account_id'),
      account_name: optStr(v.account_name, 'E7.voucher.account_name'),
      is_live: bool(v.is_live, 'E7.voucher.is_live'),
      created_at: instant(v.created_at, 'E7.voucher.created_at'),
    },
    subject: {
      kind: oneOf(s.kind, PROFIT_LEDGER_SUBJECT_KINDS, 'E7.subject.kind'),
      id: str(s.id, 'E7.subject.id'),
      name: str(s.name, 'E7.subject.name'),
      is_deleted: bool(s.is_deleted, 'E7.subject.is_deleted'),
      has_login: bool(s.has_login, 'E7.subject.has_login'),
    },
    at_create: atCreate,
    now,
  };
}

/* ───────────────────────────── E10 profit_manager_ledger_v1 ───────────────────────────── */

export interface ManagerLedgerRow {
  manager_id: string;
  name: string;
  is_active: boolean;
  is_deleted: boolean;
  has_login: boolean;
  marker: ProfitLedgerMarker | null;
  allocated: number;
  payouts_approved: number;
  payouts_pending: number;
  /** Còn lại = allocated − payouts_approved − payouts_pending. */
  balance: number;
  status: LedgerBalanceStatus;
}

export interface ManagerLedger {
  organization_id: string;
  route: ProfitLedgerRoute;
  as_of: string;
  managers: ManagerLedgerRow[];
}

export function readManagerLedger(value: unknown, organizationId: string): ManagerLedger {
  const root = obj(value, 'E10');
  if (root.organization_id !== organizationId) fail('E10.organization_id');
  const managers = list(root.managers, 'E10.managers', (row, path): ManagerLedgerRow => {
    const balance = money(row.balance, `${path}.balance`);
    return {
      manager_id: str(row.manager_id, `${path}.manager_id`),
      name: str(row.name, `${path}.name`),
      is_active: bool(row.is_active, `${path}.is_active`),
      is_deleted: bool(row.is_deleted, `${path}.is_deleted`),
      has_login: bool(row.has_login, `${path}.has_login`),
      marker: readMarker(row.marker, `${path}.marker`),
      allocated: money(row.allocated, `${path}.allocated`),
      payouts_approved: money(row.payouts_approved, `${path}.payouts_approved`),
      payouts_pending: money(row.payouts_pending, `${path}.payouts_pending`),
      balance,
      status: readBalanceStatus(row.status, balance, `${path}.status`),
    };
  });
  return {
    organization_id: organizationId,
    route: readProfitLedgerRoute(str(root.route, 'E10.route')),
    as_of: instant(root.as_of, 'E10.as_of'),
    managers: uniqueBy(managers, (r) => r.manager_id, 'E10.managers'),
  };
}
