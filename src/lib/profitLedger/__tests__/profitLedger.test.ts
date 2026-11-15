// Bộ đọc + bảng route của sổ tổng lợi nhuận. Payload mẫu dựng theo đúng khuôn RPC Đợt 1 (dữ liệu giả).
import { describe, expect, it } from 'vitest';
import { PROFIT_LEDGER_BANNERS, profitLedgerRouteState, readProfitLedgerRoute } from '../route';
import {
  readLedgerPayoutDetail, readManagerLedger, readMyProfitLedger, readShareholderLedger, readShareholderLedgerEntries,
} from '../ledgerReaders';
import {
  readLedgerCancelResult, readLedgerPayoutResult, readManagerSalaryPayoutResult, readMarkerPreview, readMarkerResult,
  readPayoutPreview, readSalaryResolveResult,
} from '../actionReaders';
import {
  readSalaryFreezeResult, readSalaryProfitInputs, readSalaryQuoteResult, readUnlockSalaryImpact, unlockImpactNeedsAcknowledge,
} from '../salaryReaders';
import { ProfitLedgerPayloadError } from '../readPrimitives';
import { profitPayoutAccounts } from '../payoutAccounts';
import {
  cancelTargetFromDetail, cancelTargetFromLedgerEntry, cancelTargetFromMyPayout, expectedCancelState, isProfitLedgerVoucher,
} from '../vouchers';

const ORG = '00000000-0000-4000-8000-000000000001';
const SH = '00000000-0000-4000-8000-000000000061';
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const shareholderRow = (over: Record<string, unknown> = {}) => ({
  shareholder_id: SH, name: 'Cổ đông 1', is_active: true, is_deleted: false, has_login: true, marker: null,
  allocated: 154.5, payouts_approved: 30, payouts_pending: 30, salary_investment: 12, salary_advance_offset: 4,
  balance: 86.5, status: 'OWED', open_advance: 0, needs_review_count: 1, ...over,
});
const e1 = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG, route: 'SHADOW', as_of: '2026-11-15T16:26:05.914+07:00', shareholders: [shareholderRow()], ...over,
});

describe('route: chuỗi lạ đóng an toàn, bảng hành vi theo route', () => {
  it.each([null, undefined, '', 'CANARY', 'canonical', 'ON', 42])('%s ⇒ LEGACY', (value) => {
    expect(readProfitLedgerRoute(value)).toBe('LEGACY');
    expect(profitLedgerRouteState(value).canPayShareholder).toBe(false);
  });
  it('LEGACY: chỉ huỷ + lương điều hành; banner xem thử', () => {
    expect(profitLedgerRouteState('LEGACY')).toMatchObject({
      canPayShareholder: false, canCancel: true, canSetMarker: false, canPayManager: true, canResolveSalary: false,
      canApprove: false, ledgerReady: false, banner: PROFIT_LEDGER_BANNERS.LEGACY,
    });
  });
  it('SHADOW: mốc + xác nhận lương, chưa chi', () => {
    expect(profitLedgerRouteState('SHADOW')).toMatchObject({
      canPayShareholder: false, canCancel: true, canSetMarker: true, canPayManager: true, canResolveSalary: true,
      canApprove: false, ledgerReady: true, banner: PROFIT_LEDGER_BANNERS.SHADOW,
    });
  });
  it('CANONICAL: mở hết, không banner', () => {
    const s = profitLedgerRouteState('CANONICAL');
    expect([s.canPayShareholder, s.canCancel, s.canSetMarker, s.canPayManager, s.canResolveSalary, s.canApprove, s.ledgerReady]).toEqual(Array(7).fill(true));
    expect(s.banner).toBeNull();
  });
  it('FROZEN: chỉ huỷ được', () => {
    expect(profitLedgerRouteState('FROZEN')).toMatchObject({
      canPayShareholder: false, canCancel: true, canSetMarker: false, canPayManager: false, canResolveSalary: false,
      canApprove: false, ledgerReady: true, banner: PROFIT_LEDGER_BANNERS.FROZEN,
    });
  });
});

describe('E1 sổ tổng — số đọc chặt', () => {
  it('đọc đúng một dòng, giữ route', () => {
    const r = readShareholderLedger(e1(), ORG);
    expect(r.route).toBe('SHADOW');
    expect(r.shareholders[0]).toMatchObject({ balance: 86.5, status: 'OWED', needs_review_count: 1, marker: null });
  });
  it('số dạng chuỗi numeric vẫn đọc được', () => {
    expect(readShareholderLedger(e1({ shareholders: [shareholderRow({ balance: '86.5', allocated: '154.50' })] }), ORG).shareholders[0]!.balance).toBe(86.5);
  });
  it.each([
    ['thiếu', undefined], ['null', null], ['NaN', Number.NaN], ['chuỗi rác', 'abc'], ['chuỗi rỗng', ''], ['vô cực', Number.POSITIVE_INFINITY],
  ])('balance %s ⇒ lỗi, KHÔNG thành 0', (_label, value) => {
    const row = shareholderRow({ balance: value });
    if (value === undefined) delete (row as Record<string, unknown>).balance;
    expect(() => readShareholderLedger(e1({ shareholders: [row] }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
  it.each(['allocated', 'payouts_approved', 'payouts_pending', 'salary_investment', 'salary_advance_offset', 'open_advance'])(
    '%s thiếu ⇒ lỗi', (key) => {
      const row = shareholderRow();
      delete (row as Record<string, unknown>)[key];
      expect(() => readShareholderLedger(e1({ shareholders: [row] }), ORG)).toThrow(ProfitLedgerPayloadError);
    },
  );
  it('trạng thái lệch số dư ⇒ lỗi (không tự chọn bên nào)', () => {
    expect(() => readShareholderLedger(e1({ shareholders: [shareholderRow({ status: 'ADVANCE' })] }), ORG)).toThrow(ProfitLedgerPayloadError);
  });
  it('open_advance phải = max(−balance, 0)', () => {
    expect(readShareholderLedger(e1({ shareholders: [shareholderRow({ balance: -3, status: 'ADVANCE', open_advance: 3 })] }), ORG).shareholders[0]!.open_advance).toBe(3);
    expect(() => readShareholderLedger(e1({ shareholders: [shareholderRow({ balance: -3, status: 'ADVANCE', open_advance: 0 })] }), ORG)).toThrow();
  });
  it('mốc: dòng gỡ mốc giữ id, tháng null', () => {
    const r = readShareholderLedger(e1({ shareholders: [shareholderRow({ marker: { id: 'm1', settled_through_month: null, ledger_seq: 4720 } })] }), ORG);
    expect(r.shareholders[0]!.marker).toEqual({ id: 'm1', settled_through_month: null, ledger_seq: 4720 });
  });
  it('công ty lệch, danh sách null, id trùng ⇒ lỗi', () => {
    expect(() => readShareholderLedger(e1({ organization_id: 'khac' }), ORG)).toThrow();
    expect(() => readShareholderLedger(e1({ shareholders: null }), ORG)).toThrow();
    expect(() => readShareholderLedger(e1({ shareholders: [shareholderRow(), shareholderRow()] }), ORG)).toThrow();
  });
});

const entry = (over: Record<string, unknown>) => ({
  kind: 'ALLOCATION', line_id: null, period_month: null, building_id: null, building_name: null, amount: 0, suggested: null,
  voucher_id: null, voucher_code: null, voucher_date: null, voucher_status: null, posting_status: null, account_name: null,
  maker_user_id: null, is_mine: false, is_advance: false, created_at: '2026-08-02T17:00:00+07:00', excluded_by_marker: false,
  running_balance: 0, ...over,
});
const e2 = (entries: unknown[], balance: number, over: Record<string, unknown> = {}) => ({
  organization_id: ORG,
  shareholder: { shareholder_id: SH, name: 'Cổ đông 1', is_active: true, is_deleted: false, has_login: true },
  marker: null,
  totals: {
    allocated: 100, payouts_approved: 0, payouts_pending: 20, salary_investment: 0, salary_advance_offset: 0, balance,
    status: balance > 0 ? 'OWED' : balance < 0 ? 'ADVANCE' : 'SETTLED',
    excluded_before_marker: { allocated: 0, payouts: 0, salary: 0 }, needs_review: { count: 1, suggested: 7 },
  },
  entries,
  ...over,
});

describe('E2 sổ chi tiết', () => {
  const rows = [
    entry({ kind: 'ALLOCATION', line_id: 'a1', period_month: '2026-07-01', amount: 100, running_balance: 100 }),
    entry({ kind: 'PAYOUT', voucher_id: 'v1', voucher_code: 'PC-1', voucher_date: '2026-08-10', voucher_status: 'UNAPPROVED', posting_status: 'UNPOSTED', amount: -20, running_balance: 80, maker_user_id: 'u1', is_advance: true }),
    entry({ kind: 'SALARY_REVIEW', line_id: 'l1', voucher_id: 'pl', voucher_code: 'PL-09', voucher_date: '2026-10-12', voucher_status: 'APPROVED', period_month: '2026-09-01', suggested: 7, running_balance: 80 }),
  ];
  it('đọc dòng, khoá duy nhất kind:(line_id ?? voucher_id)', () => {
    const r = readShareholderLedgerEntries(e2(rows, 80), ORG, SH);
    expect(r.entries.map((e) => e.key)).toEqual(['ALLOCATION:a1', 'PAYOUT:v1', 'SALARY_REVIEW:l1']);
    expect(r.totals.needs_review).toEqual({ count: 1, suggested: 7 });
  });
  it('số dư chạy dòng cuối ≠ số dư sổ ⇒ lỗi', () => {
    expect(() => readShareholderLedgerEntries(e2(rows, 81), ORG, SH)).toThrow(ProfitLedgerPayloadError);
  });
  it('sổ rỗng chỉ hợp lệ khi số dư 0', () => {
    expect(readShareholderLedgerEntries(e2([], 0), ORG, SH).entries).toEqual([]);
    expect(() => readShareholderLedgerEntries(e2([], 5), ORG, SH)).toThrow();
  });
  it('dòng thiếu running_balance / amount ⇒ lỗi', () => {
    const bad = clone(rows);
    delete (bad[1] as Record<string, unknown>).amount;
    expect(() => readShareholderLedgerEntries(e2(bad, 80), ORG, SH)).toThrow();
  });
  it('cổ đông lệch tham số ⇒ lỗi', () => {
    expect(() => readShareholderLedgerEntries(e2(rows, 80), ORG, 'khac')).toThrow();
  });
});

const e3 = (over: Record<string, unknown> = {}) => ({
  organization_id: ORG, route: 'LEGACY', ready: false, shareholder: { id: SH, name: 'Cổ đông 1' },
  balance: 86.5, status: 'OWED', allocated: 154.5, paid: 30, paid_pending: 30, paid_via_salary: 12, advance_recovered: 4,
  marker: null,
  months: [{ period_month: '2026-08-01', amount: 24.5, excluded_by_marker: false, buildings: [{ building_id: 'b2', building_name: 'Toà Hai', amount: -15.5 }, { building_id: 'b1', building_name: 'Toà Một', amount: 40 }] }],
  payouts: [{ voucher_id: 'v3', voucher_code: 'PC-CHO', voucher_date: '2026-10-10', amount: 30, status: 'UNAPPROVED', posting_status: 'UNPOSTED', is_advance: true, is_mine: true, is_mine_pending: true, excluded_by_marker: false }],
  salary: [{ period_month: '2026-08-01', investment: 12, advance_offset: 4, excluded_by_marker: false }],
  ...over,
});

describe('E3 cổ đông tự xem — không lọt khoá cấm', () => {
  it('thiếu quyền xem ⇒ không có percent_rows / building_totals (undefined, không phải [])', () => {
    const r = readMyProfitLedger(e3(), ORG);
    expect('percent_rows' in r).toBe(false);
    expect('building_totals' in r).toBe(false);
    expect(r.ready).toBe(false);
  });
  it('có quyền ⇒ đọc hai mảng; doanh thu null giữ null', () => {
    const r = readMyProfitLedger(e3({
      route: 'CANONICAL', ready: true,
      percent_rows: [{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }],
      building_totals: [{ period_month: '2026-07-01', building_id: 'b1', building_name: 'Toà Một', revenue: null, expense: null, profit: 600 }],
    }), ORG);
    expect(r.percent_rows).toEqual([{ building_id: 'b1', building_name: 'Toà Một', percent: 20 }]);
    expect(r.building_totals?.[0]).toMatchObject({ revenue: null, expense: null, profit: 600 });
  });
  it('khoá lạ (percent, adjusted_profit…) ngoài hai mảng KHÔNG được chép vào kết quả', () => {
    const raw = e3({ percent: 30, adjusted_profit: 999, management_salary: 1 });
    (raw.months[0] as Record<string, unknown>).percent = 30;
    const text = JSON.stringify(readMyProfitLedger(raw, ORG));
    expect(text).not.toMatch(/percent|adjusted_profit|management_salary/);
  });
  it('route lạ ⇒ LEGACY và ready=false dù máy chủ báo ready', () => {
    expect(readMyProfitLedger(e3({ route: 'CANARY', ready: true }), ORG)).toMatchObject({ route: 'LEGACY', ready: false });
  });
  it('số thiếu ⇒ lỗi', () => {
    const raw = e3();
    delete (raw as Record<string, unknown>).paid_via_salary;
    expect(() => readMyProfitLedger(raw, ORG)).toThrow(ProfitLedgerPayloadError);
  });
});

describe('E7 chi tiết phiếu + E10 lương điều hành', () => {
  const e7 = (over: Record<string, unknown> = {}) => ({
    organization_id: ORG, route: 'CANONICAL',
    voucher: { id: 'v3', code: 'PC-CHO', voucher_date: '2026-10-10', amount: 30, approval_status: 'UNAPPROVED', posting_status: 'UNPOSTED', system_source: 'profit.ledger_payout', account_id: 'a1', account_name: 'Quỹ tiền mặt', is_live: true, created_at: '2026-10-10T16:00:00+07:00' },
    subject: { kind: 'SHAREHOLDER', id: SH, name: 'Cổ đông 1', is_deleted: false, has_login: true },
    at_create: { balance_before: 25, within: 25, advance: 5, warnings: [{ code: 'ADVANCE' }], maker_kind: 'CUSTODIAN_ADVANCE', payee_is_maker: true },
    now: { balance_excluding_this: 116.5, within: 30, advance: 0 },
    ...over,
  });
  it('cảnh báo cũ không kèm số ⇒ null (không thành 0)', () => {
    const r = readLedgerPayoutDetail(e7(), 'v3');
    expect(r.at_create?.warnings).toEqual([{ code: 'ADVANCE', advance_amount: null }]);
  });
  it('within + advance ≠ số phiếu ⇒ lỗi', () => {
    expect(() => readLedgerPayoutDetail(e7({ now: { balance_excluding_this: 1, within: 1, advance: 1 } }), 'v3')).toThrow();
  });
  it('phiếu cũ không dòng sổ ⇒ at_create null; dựng mục tiêu huỷ chỉ cho phiếu sổ tổng', () => {
    const old = readLedgerPayoutDetail(e7({ at_create: null, voucher: { ...e7().voucher, system_source: null } }), 'v3');
    expect(old.at_create).toBeNull();
    expect(cancelTargetFromDetail(old)).toBeNull();
    expect(cancelTargetFromDetail(readLedgerPayoutDetail(e7(), 'v3'))).toMatchObject({ voucherId: 'v3', organizationId: ORG, kind: 'SHAREHOLDER', amount: 30 });
  });
  it('E10 đọc người đã xoá còn số', () => {
    const r = readManagerLedger({ organization_id: ORG, route: 'LEGACY', as_of: '2026-11-15T16:26:06.212+07:00', managers: [
      { manager_id: 'm3', name: 'Quản lý đã nghỉ', is_active: true, is_deleted: true, has_login: false, marker: null, allocated: 7, payouts_approved: 0, payouts_pending: 0, balance: 7, status: 'OWED' },
    ] }, ORG);
    expect(r.managers[0]).toMatchObject({ is_deleted: true, balance: 7 });
  });
});

describe('E4/E5/E6/E8/E9/E11/E16', () => {
  const e4 = (over: Record<string, unknown> = {}) => ({
    route: 'CANONICAL', shareholder_id: SH, maker_kind: 'OWNER', payee_is_maker: false, balance_before: 100,
    within_amount: 100, advance_amount: 20, open_estimate: 50, warnings: [{ code: 'ADVANCE', advance_amount: 20 }, { code: 'NEEDS_OWNER_APPROVAL' }],
    requires_owner_approval: true, can_submit: true, blocked_reason: null, needs_review: { count: 0, suggested: 0 }, ...over,
  });
  it('E4 tách đúng số tiền; lệch ⇒ lỗi', () => {
    expect(readPayoutPreview(e4(), { shareholderId: SH, amount: 120, accountId: 'a1' })).toMatchObject({ within_amount: 100, advance_amount: 20, can_submit: true });
    expect(() => readPayoutPreview(e4(), { shareholderId: SH, amount: 121, accountId: 'a1' })).toThrow();
  });
  it('E4 chưa nhập số tiền ⇒ within/advance phải null, vẫn đọc số dư', () => {
    const r = readPayoutPreview(e4({ within_amount: null, advance_amount: null, warnings: [], can_submit: false }), { shareholderId: SH, amount: null, accountId: null });
    expect(r.balance_before).toBe(100);
    expect(() => readPayoutPreview(e4(), { shareholderId: SH, amount: null, accountId: null })).toThrow();
  });
  it('E4 lý do khoá lạ ⇒ OTHER và không cho gửi dù can_submit=true', () => {
    expect(readPayoutPreview(e4({ blocked_reason: 'NEW_THING' }), { shareholderId: SH, amount: 120, accountId: 'a1' })).toMatchObject({ blocked_reason: 'OTHER', can_submit: false });
  });
  it('E5 dội lại sai cổ đông / số tiền ⇒ lỗi (biên nhận lệnh khác)', () => {
    const e5 = { voucher_id: 'v9', approval_request_id: 'r9', shareholder_id: SH, amount: 120, within_amount: 100, advance_amount: 20, balance_before: 100, warnings: [], maker_kind: 'OWNER', state: 'PENDING_APPROVAL' };
    expect(readLedgerPayoutResult(e5, { shareholderId: SH, amount: 120 }).voucher_id).toBe('v9');
    expect(() => readLedgerPayoutResult(e5, { shareholderId: 'khac', amount: 120 })).toThrow();
    expect(() => readLedgerPayoutResult(e5, { shareholderId: SH, amount: 100 })).toThrow();
    expect(() => readLedgerPayoutResult({ ...e5, state: 'APPROVED' }, { shareholderId: SH, amount: 120 })).toThrow();
  });
  it('E6 huỷ phiếu đã chi phải có bút toán đảo', () => {
    expect(readLedgerCancelResult({ voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_AFTER_POSTING', reversal_posting_id: 'p1', balance_after: 10 }, 'v1').balance_after).toBe(10);
    expect(() => readLedgerCancelResult({ voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_AFTER_POSTING', reversal_posting_id: null, balance_after: 10 }, 'v1')).toThrow();
    expect(readLedgerCancelResult({ voucher_id: 'v1', changed: false, cancellation_kind: null, reversal_posting_id: null, balance_after: -5 }, 'v1').changed).toBe(false);
    expect(() => readLedgerCancelResult({ voucher_id: 'v1', changed: true, cancellation_kind: 'CANCELLED_UNPOSTED', reversal_posting_id: null }, 'v1')).toThrow();
  });
  it('E8 requires_acknowledge phải khớp advance_erased; E9 dội lại tháng', () => {
    const e8 = { route: 'SHADOW', subject_kind: 'SHAREHOLDER', subject_id: SH, settled_through_month: '2026-09-01', current_marker: { id: 'm0', settled_through_month: null, ledger_seq: 7, created_at: '2026-11-15T11:47:17.239913+00:00' }, balance_now: 10, balance_after: 0, excluded: { allocated: 10, payouts: 0, salary: 0 }, advance_erased: 0, requires_acknowledge: false };
    expect(readMarkerPreview(e8, { subjectKind: 'SHAREHOLDER', subjectId: SH, settledThroughMonth: '2026-09-01' }).current_marker?.id).toBe('m0');
    expect(() => readMarkerPreview({ ...e8, advance_erased: 5 }, { subjectKind: 'SHAREHOLDER', subjectId: SH, settledThroughMonth: '2026-09-01' })).toThrow();
    expect(readMarkerResult({ marker_id: 'm1', settled_through_month: null, supersedes_id: 'm0', balance_before: 0, balance_after: 10, advance_erased: 0 }, { settledThroughMonth: null }).supersedes_id).toBe('m0');
    expect(() => readMarkerResult({ marker_id: 'm1', settled_through_month: '2026-09-01', supersedes_id: null, balance_before: 0, balance_after: 10, advance_erased: 0 }, { settledThroughMonth: null })).toThrow();
  });
  it('E11: khoá voucher_id mới; balance_before vắng ⇒ null (route cũ), có ⇒ số', () => {
    const base = { manager_salary_voucher_id: 'v1', voucher_id: 'v1', approval_request_id: 'r1', manager_id: 'm1', state: 'PENDING_APPROVAL' };
    expect(readManagerSalaryPayoutResult(base, 'm1').balance_before).toBeNull();
    expect(readManagerSalaryPayoutResult({ ...base, balance_before: '300' }, 'm1').balance_before).toBe(300);
    expect(() => readManagerSalaryPayoutResult({ ...base, balance_before: null }, 'm1')).toThrow();
    expect(() => readManagerSalaryPayoutResult({ ...base, voucher_id: undefined }, 'm1')).toThrow();
  });
  it('E16 dội lại dòng', () => {
    const e16 = { line_id: 'l1', shareholder_id: SH, salary_voucher_id: 'pl', period_month: '2026-09-01', investment_amount: 7, advance_offset_amount: 0, balance_before: 80, balance_after: 73 };
    expect(readSalaryResolveResult(e16, 'l1').balance_after).toBe(73);
    expect(() => readSalaryResolveResult(e16, 'l2')).toThrow();
  });
});

describe('E12–E15 phần lương', () => {
  const staff = (over: Record<string, unknown> = {}) => ({
    staff_id: 's1', organization_id: ORG, shareholder_id: SH, sheet_status: 'DRAFT', profit_draft: false,
    allocations: [{ building_id: 'b1', building_label: 'B1', amount: 40, status: 'LOCKED', is_stale: false }],
    by_building: [{ label: 'B1', building_ids: ['b1'], allocated: 40, override_amount: null, amount: 40 }],
    allocated_total: 40, investment_month: 40, investment_cap: 40, marker_through: null, settled_by_marker: false, settlement: null,
    paid_lines: [], paid_investment: 0, paid_offset: 0, advance_open: 0, advance_offset_month: 0, suggested_advance_offset: 0,
    remaining_offset: 0, offset_conflict: false, needs_review: { count: 0, suggested: 0 }, ...over,
  });
  it('E12 đúng nhân viên được hỏi; thiếu / thừa ⇒ lỗi', () => {
    expect(readSalaryProfitInputs({ period_month: '2026-10-01', staff: [staff()] }, '2026-10-01', ['s1']).staff[0]!.investment_month).toBe(40);
    expect(() => readSalaryProfitInputs({ period_month: '2026-10-01', staff: [staff()] }, '2026-10-01', ['s1', 's2'])).toThrow();
    const thieuSo = staff();
    delete (thieuSo as Record<string, unknown>).suggested_advance_offset;
    expect(() => readSalaryProfitInputs({ period_month: '2026-10-01', staff: [thieuSo] }, '2026-10-01', ['s1'])).toThrow();
  });
  it('E13 ba dạng kết quả', () => {
    expect(readSalaryFreezeResult({ shareholder_id: null, staff_id: 's1', period_month: '2026-10-01', organization_id: ORG, settlement_id: null }, { staffId: 's1', periodMonth: '2026-10-01' }).kind).toBe('NOT_SHAREHOLDER');
    const common = { shareholder_id: SH, staff_id: 's1', period_month: '2026-10-01', organization_id: ORG, investment_month: 40, advance_offset_month: 5, paid_investment: 0, paid_offset: 0, unpaid_investment: 40, settled_by_marker: false };
    expect(readSalaryFreezeResult({ ...common, already_locked: false, settlement_id: 'c3', voided_settlement_id: null }, { staffId: 's1', periodMonth: '2026-10-01' })).toMatchObject({ kind: 'FROZEN', advance_offset_month: 5 });
    expect(readSalaryFreezeResult({ ...common, already_locked: true, settlement_id: null, offset_conflict: true }, { staffId: 's1', periodMonth: '2026-10-01' })).toMatchObject({ kind: 'ALREADY_LOCKED', offset_conflict: true });
  });
  it('E15 phải gắn đúng khoá trả lương', () => {
    const q = { quote_id: 'q1', shareholder_id: SH, staff_id: 's1', period_month: '2026-10-01', organization_id: ORG, investment_amount: 40, advance_offset_amount: 5, investment_month: 40, advance_offset_month: 5, paid_investment: 0, paid_offset: 0, settled_by_marker: false, sheet_status: 'DRAFT', expected_voucher_amount: 1000, payout_request_key: 'K-12345678', expires_at: '2026-11-15T12:00:00+00:00', voided_quote_ids: [], offset_conflict: false, needs_review_reason: null };
    expect(readSalaryQuoteResult(q, { staffId: 's1', periodMonth: '2026-10-01', payoutKey: 'K-12345678' }).kind).toBe('QUOTED');
    expect(() => readSalaryQuoteResult(q, { staffId: 's1', periodMonth: '2026-10-01', payoutKey: 'KHAC-1234' })).toThrow();
    expect(readSalaryQuoteResult({ quote_id: null, shareholder_id: null, staff_id: 's1', period_month: '2026-10-01', organization_id: ORG }, { staffId: 's1', periodMonth: '2026-10-01', payoutKey: 'K-12345678' }).kind).toBe('NOT_SHAREHOLDER');
  });
  it('E14: có ảnh hưởng ⇒ cần tick; trần tháng null giữ null', () => {
    const impact = readUnlockSalaryImpact({ organization_id: ORG, period_month: '2026-10-01', building_ids: null,
      paid_via_salary: [{ shareholder_id: SH, name: 'Cổ đông 2', staff_id: 's1', investment: 40, advance_offset: 0, salary_voucher_ids: ['pl'], salary_voucher_codes: [null], voucher_states: [{ salary_voucher_id: 'pl', approval_status: 'APPROVED', posting_status: null }], needs_review_count: 0, offset_conflict: null, paid_offset: null, advance_offset_month: null, sheet_status: null }],
      ledger_effects: [] }, ORG, '2026-10-01');
    expect(impact.paid_via_salary[0]).toMatchObject({ offset_conflict: null, paid_offset: null, salary_voucher_codes: [null] });
    expect(unlockImpactNeedsAcknowledge(impact)).toBe(true);
    expect(unlockImpactNeedsAcknowledge({ ...impact, paid_via_salary: [] })).toBe(false);
  });
});

describe('sổ quỹ chi + phiếu sổ tổng', () => {
  const accounts = [
    { id: 'a1', name: 'Quỹ chủ', organization_id: ORG, is_virtual: false },
    { id: 'a2', name: 'Quỹ người giữ', organization_id: ORG, is_virtual: false },
    { id: 'a3', name: 'CỌC giữ hộ', organization_id: ORG, is_virtual: true },
    { id: 'a4', name: 'Quỹ công ty khác', organization_id: 'org-b', is_virtual: false },
  ];
  it('OWNER: mọi sổ tiền thật của đúng công ty', () => {
    expect(profitPayoutAccounts({ mode: 'OWNER', organizationId: ORG, accounts }).map((a) => a.id)).toEqual(['a1', 'a2']);
  });
  it('SELF_ADVANCE: chỉ sổ đang GIỮ (CUSTODIAN), cùng công ty, không ảo', () => {
    const access = [
      { cashbook_id: 'a2', possession_kind: 'CUSTODIAN' },
      { cashbook_id: 'a1', possession_kind: 'KNOWER' },
      { cashbook_id: 'a3', possession_kind: 'CUSTODIAN' },
      { cashbook_id: 'a4', possession_kind: 'CUSTODIAN' },
    ];
    expect(profitPayoutAccounts({ mode: 'SELF_ADVANCE', organizationId: ORG, accounts, access }).map((a) => a.id)).toEqual(['a2']);
    expect(profitPayoutAccounts({ mode: 'SELF_ADVANCE', organizationId: ORG, accounts, access: null })).toEqual([]);
  });
  it('nguồn phiếu sổ tổng và trạng thái kỳ vọng khi huỷ', () => {
    expect(isProfitLedgerVoucher('profit.ledger_payout')).toBe(true);
    expect(isProfitLedgerVoucher('profit.manager_salary')).toBe(true);
    expect(isProfitLedgerVoucher('profit.distribution')).toBe(false);
    expect(isProfitLedgerVoucher('salary.manager')).toBe(false);
    expect(expectedCancelState('UNAPPROVED', 'UNPOSTED')).toBe('PENDING');
    expect(expectedCancelState('APPROVED', null)).toBe('APPROVED_UNPOSTED');
    expect(expectedCancelState('APPROVED', 'NOT_APPLICABLE')).toBe('APPROVED_UNPOSTED');
    expect(expectedCancelState('APPROVED', 'POSTED')).toBe('POSTED');
    expect(expectedCancelState('APPROVED', 'REVERSED')).toBeNull();
    expect(expectedCancelState('CANCELLED', 'UNPOSTED')).toBeNull();
  });
  it('mục tiêu huỷ từ sổ chi tiết chỉ cho phiếu lập theo sổ tổng; từ màn tự xem chỉ phiếu của mình còn chờ', () => {
    const r = readShareholderLedgerEntries(e2([
      entry({ kind: 'PAYOUT', voucher_id: 'old', voucher_status: 'APPROVED', posting_status: 'POSTED', amount: -10, running_balance: -10, account_name: 'Quỹ' }),
      entry({ kind: 'PAYOUT', voucher_id: 'new', voucher_status: 'APPROVED', posting_status: 'POSTED', amount: -20, running_balance: -30, maker_user_id: 'u1', account_name: 'Quỹ' }),
    ], -30), ORG, SH);
    expect(cancelTargetFromLedgerEntry(r.entries[0]!, { organizationId: ORG, subjectName: 'A' })).toBeNull();
    expect(cancelTargetFromLedgerEntry(r.entries[1]!, { organizationId: ORG, subjectName: 'A' })).toMatchObject({ voucherId: 'new', amount: 20, postingStatus: 'POSTED' });
    const mine = readMyProfitLedger(e3(), ORG).payouts[0]!;
    expect(cancelTargetFromMyPayout(mine, { organizationId: ORG, subjectName: 'A' })).toMatchObject({ voucherId: 'v3', approvalStatus: 'UNAPPROVED' });
    expect(cancelTargetFromMyPayout({ ...mine, is_mine_pending: false }, { organizationId: ORG, subjectName: 'A' })).toBeNull();
  });
});
