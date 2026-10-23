// Lib thuần của khoá tháng đã chốt theo KỲ + "phát sinh sau chốt" (rà 21/10 F06, chủ chốt 22/10/2026).
// Số tiền, mã, tên đều giả.
import { describe, expect, it } from 'vitest';
import { periodBlockMessage } from '@/lib/cashbookClosing';
import {
  NO_ENGINE_EXCLUSIONS,
  engineExclusionsOf,
  lockedMonthsOf,
  postLockByBuildingMonth,
  postLockChipText,
  postLockEntriesFor,
  postLockFormBlock,
  postLockFormMonths,
  postLockLockTabLabel,
  postLockQueryRange,
  postLockReason,
  postLockWarnings,
  profitPeriodLockedMessage,
  profitPostLockSchema,
  splitPostLock,
  subtractEngineExclusions,
  voucherProfitMonths,
  type PostLockFormInput,
  type PostLockVoucher,
  type ProfitPostLockData,
} from '@/lib/profitPostLock';

const A = '00000000-0000-4000-8000-000000000011';
const B = '00000000-0000-4000-8000-000000000012';
const V1 = '00000000-0000-4000-8000-000000000101';
const V2 = '00000000-0000-4000-8000-000000000102';
const V3 = '00000000-0000-4000-8000-000000000103';

const entry = (o: Partial<PostLockVoucher>): PostLockVoucher => ({
  voucher_id: V1,
  building_id: A,
  building_name: 'Toà A',
  month: '2025-08-01',
  locked_at: '2025-09-03T03:00:00+00:00',
  code: 'PC0001',
  name: 'Điện T8',
  restricted: false,
  voucher_date: '2025-09-05',
  type: 'EXPENSE',
  invoice_month: null,
  period_from: '2025-08-01',
  period_to: '2025-08-31',
  income: 0,
  expense: 1_200_000,
  created_at: '2025-09-05T03:00:00+00:00',
  approved_at: '2025-09-05T03:00:00+00:00',
  ...o,
});

const pnl = (startDate: string | null, endDate: string | null, countsInPnl = true) => ({ startDate, endDate, countsInPnl });
const T8 = new Set(['2025-08-01']);

describe('voucherProfitMonths — luật kỳ của fa_accrual_allocations', () => {
  const v = (o: Partial<PostLockFormInput>): PostLockFormInput => ({ voucherDate: '2025-09-15', items: [], ...o });
  it.each([
    ['không dòng ⇒ tháng ngày phiếu', v({}), ['2025-09-01']],
    ['không dòng + hoá đơn ⇒ tháng hoá đơn', v({ invoiceMonth: '2025-08' }), ['2025-08-01']],
    ['dòng có kỳ ⇒ mọi tháng của kỳ', v({ items: [pnl('2025-07-10', '2025-09-02')] }), ['2025-07-01', '2025-08-01', '2025-09-01']],
    ['kỳ ngược ⇒ tháng bắt đầu', v({ items: [pnl('2025-08-10', '2025-07-05')] }), ['2025-08-01']],
    ['kỳ ngược cùng tháng ⇒ tháng bắt đầu', v({ items: [pnl('2025-08-10', '2025-08-05')] }), ['2025-08-01']],
    ['thiếu ngày cuối ⇒ tháng ngày phiếu', v({ items: [pnl('2025-08-01', null)] }), ['2025-09-01']],
    ['dòng cọc bỏ', v({ items: [pnl('2025-08-01', '2025-08-31', false)] }), []],
    ['ép KQKD ⇒ dòng cọc cũng tính', v({ businessResultAccounting: true, items: [pnl('2025-08-01', '2025-08-31', false)] }), ['2025-08-01']],
    ['tắt KQKD ⇒ không tháng nào', v({ businessResultAccounting: false, items: [pnl('2025-08-01', '2025-08-31')] }), []],
    ['hoá đơn ⇒ mọi dòng vào tháng hoá đơn', v({ invoiceMonth: '2025-06', items: [pnl('2025-08-01', '2025-08-31')] }), ['2025-06-01']],
  ])('%s', (_t, input, out) => {
    expect(voucherProfitMonths(input)).toEqual(out);
  });

  it('kỳ quá dài chỉ soi tối đa 36 tháng', () => {
    expect(voucherProfitMonths(v({ items: [pnl('2020-01-01', '2029-12-31')] }))).toHaveLength(36);
  });

  it('tháng cần hỏi + khoảng hỏi server', () => {
    const cur = v({ voucherDate: '2025-09-15', items: [pnl('2025-07-01', '2025-08-31')] });
    const goc = v({ voucherDate: '2025-10-02', invoiceMonth: '2025-06' });
    expect(postLockFormMonths(cur, goc, null)).toEqual(['2025-06-01', '2025-07-01', '2025-08-01', '2025-09-01', '2025-10-01']);
    expect(postLockQueryRange(['2025-09-01', '2025-06-01'])).toEqual({ from: '2025-06-01', to: '2025-09-01' });
    expect(postLockQueryRange([])).toBeNull();
    expect(postLockQueryRange(['2022-01-01', '2025-01-01'])).toBeNull();
    // phiếu gắn hoá đơn mà không biết tháng ⇒ chỉ hỏi ngày phiếu
    expect(postLockFormMonths(v({ hasInvoice: true, items: [pnl('2025-07-01', '2025-07-31')] }))).toEqual(['2025-09-01']);
  });
});

describe('postLockFormBlock — lỗi đỏ trong form', () => {
  const MSG = 'Tháng 08/2025 của toà Toà A đã chốt lợi nhuận — không ghi được phiếu có kỳ trong tháng này. Muốn ghi: mở khoá tháng ở tab Chốt LN.';
  const side = (input: Partial<PostLockFormInput>, locked = T8, extra: object = {}) => ({
    input: { voucherDate: '2025-09-15', items: [], ...input },
    lockedMonths: locked,
    buildingName: 'Toà A',
    ...extra,
  });

  it('kỳ trong tháng đã chốt ⇒ BLOCKED đúng câu', () => {
    expect(postLockFormBlock({ current: side({ items: [pnl('2025-08-01', '2025-08-31')] }) })).toEqual({
      kind: 'BLOCKED', month: '2025-08-01', message: MSG,
    });
    expect(profitPeriodLockedMessage('2025-08-01', 'Toà A')).toBe(MSG);
  });

  it('kỳ tháng mở / dòng cọc / tắt KQKD / toà chưa chốt ⇒ NONE', () => {
    expect(postLockFormBlock({ current: side({ items: [pnl('2025-09-01', '2025-09-30')] }) }).kind).toBe('NONE');
    expect(postLockFormBlock({ current: side({ items: [pnl('2025-08-01', '2025-08-31', false)] }) }).kind).toBe('NONE');
    expect(postLockFormBlock({ current: side({ businessResultAccounting: false, items: [pnl('2025-08-01', '2025-08-31')] }) }).kind).toBe('NONE');
    expect(postLockFormBlock({ current: side({ items: [pnl('2025-08-01', '2025-08-31')] }, new Set()) }).kind).toBe('NONE');
  });

  it('ngày phiếu trong tháng đã chốt ⇒ BLOCKED kể cả phiếu ngoài KQKD', () => {
    const r = postLockFormBlock({ current: side({ voucherDate: '2025-08-20', businessResultAccounting: false }) });
    expect(r).toMatchObject({ kind: 'BLOCKED', month: '2025-08-01' });
  });

  it('thu tiền hoá đơn tháng đã chốt: LẬP không báo; SỬA thì báo', () => {
    expect(postLockFormBlock({ current: side({ invoiceMonth: '2025-08', items: [pnl(null, null)] }) }).kind).toBe('NONE');
    expect(postLockFormBlock({ current: side({ invoiceMonth: '2025-08' }), isEdit: true }).kind).toBe('BLOCKED');
    // phiếu gắn hoá đơn mà form không biết tháng ⇒ để máy chủ quyết
    expect(postLockFormBlock({ current: side({ hasInvoice: true, items: [pnl('2025-08-01', '2025-08-31')] }) }).kind).toBe('NONE');
  });

  it('sửa: bản gốc ĐÃ DUYỆT có kỳ tháng đã chốt ⇒ BLOCKED; bản gốc chờ duyệt ⇒ chỉ xét ngày phiếu', () => {
    const current = side({ items: [pnl('2025-09-01', '2025-09-30')] });
    const goc = { voucherDate: '2025-09-01', items: [pnl('2025-08-01', '2025-08-31')] };
    expect(postLockFormBlock({ current, original: side(goc), isEdit: true }).kind).toBe('BLOCKED');
    expect(postLockFormBlock({ current, original: side(goc, T8, { periodCounts: false }), isEdit: true }).kind).toBe('NONE');
    expect(
      postLockFormBlock({ current, original: side({ ...goc, voucherDate: '2025-08-31' }, T8, { periodCounts: false }), isEdit: true }).kind,
    ).toBe('BLOCKED');
  });

  it('đổi toà: mỗi bản xét tháng chốt của toà mình, câu nêu đúng toà', () => {
    const r = postLockFormBlock({
      current: side({ items: [pnl('2025-08-01', '2025-08-31')] }, new Set(), { buildingName: 'Toà B' }),
      original: side({ voucherDate: '2025-09-01', items: [pnl('2025-08-01', '2025-08-31')] }, T8, { buildingName: 'Toà A' }),
      isEdit: true,
    });
    expect(r).toMatchObject({ kind: 'BLOCKED', message: MSG });
  });

  it('lỗi máy chủ ra đúng câu của form (periodBlockMessage bỏ tiền tố)', () => {
    expect(periodBlockMessage(`[PROFIT_LOCKED] ${MSG}`)).toBe(MSG);
  });
});

describe('Báo cáo LN — tách khoản phát sinh sau chốt', () => {
  type Row = { voucherId: string; buildingId: string | null; income: number; expense: number; approvalStatus: 'APPROVED' | 'UNAPPROVED'; itemId: string };
  const row = (voucherId: string, o: Partial<Row> = {}): Row => ({
    voucherId, buildingId: A, income: 0, expense: 100, approvalStatus: 'APPROVED', itemId: `${voucherId}:i`, ...o,
  });
  const accrual = (rows: Row[]) => {
    const inc = rows.reduce((s, r) => s + r.income, 0);
    const exp = rows.reduce((s, r) => s + r.expense, 0);
    const pend = rows.filter((r) => r.approvalStatus === 'UNAPPROVED');
    return {
      totalIncome: inc, totalExpense: exp, difference: inc - exp, rows,
      pendingIncome: pend.reduce((s, r) => s + r.income, 0),
      pendingExpense: pend.reduce((s, r) => s + r.expense, 0),
      pendingCount: new Set(pend.map((r) => r.voucherId)).size,
      extra: 'giữ nguyên',
    };
  };

  it('bỏ dòng của (phiếu, toà) sau chốt, tính lại tổng; tổng mới = tổng cũ − phần tách', () => {
    const base = accrual([
      row(V1, { expense: 1_200_000 }),
      row(V1, { expense: 300_000, itemId: 'x2' }),
      row(V2, { income: 5_000, expense: 0 }),
      row(V3, { expense: 70, approvalStatus: 'UNAPPROVED' }),
      row(V1, { buildingId: B, expense: 9 }), // cùng phiếu, khác toà ⇒ giữ
    ]);
    const s = splitPostLock(base, [entry({ voucher_id: V1 }), entry({ voucher_id: V3 })]);
    expect(s.accrual.rows.map((r) => r.itemId)).toEqual([`${V2}:i`, `${V3}:i`, `${V1}:i`]);
    expect(s.accrual.totalExpense).toBe(base.totalExpense - 1_500_000);
    expect(s.accrual.totalIncome).toBe(5_000);
    expect(s.accrual.difference).toBe(s.accrual.totalIncome - s.accrual.totalExpense);
    // phiếu chờ duyệt không bao giờ bị tách (RPC chỉ trả phiếu đã duyệt)
    expect(s.accrual.pendingCount).toBe(1);
    expect(s.accrual.pendingExpense).toBe(70);
    expect(s.accrual.extra).toBe('giữ nguyên');
    expect(s).toMatchObject({ count: 1, income: 0, expense: 1_500_000 });
    expect(s.entries.map((e) => e.voucher_id)).toEqual([V1]);
  });

  it('không khoản nào ⇒ trả đúng bản cũ', () => {
    const base = accrual([row(V1)]);
    expect(splitPostLock(base, []).accrual).toBe(base);
    expect(splitPostLock(base, [entry({ voucher_id: V2 })]).accrual).toBe(base);
  });

  it('lọc đúng tháng + toà; engine trừ đúng số RPC; thanh kiểm chứng hết lệch giả', () => {
    const data: ProfitPostLockData = {
      from: '2025-08-01',
      to: '2025-09-01',
      locked: [{ building_id: A, building_name: 'Toà A', month: '2025-08-01', locked_at: '2025-09-03T03:00:00+00:00' }],
      after_lock: [
        entry({ voucher_id: V1 }),
        entry({ voucher_id: V2, type: 'INCOME', income: 3_000_000, expense: 0, invoice_month: '2025-08' }),
        entry({ voucher_id: V3, building_id: B, expense: 5 }),
        entry({ voucher_id: V3, month: '2025-09-01', expense: 7 }),
      ],
    };
    const entries = postLockEntriesFor(data, '2025-08', [A]);
    expect(entries.map((e) => e.voucher_id)).toEqual([V1, V2]);
    const ex = engineExclusionsOf(entries);
    expect(ex).toMatchObject({ count: 2, income: 3_000_000, expense: 1_200_000 });
    const fa = {
      income: 10_000_000,
      expense: 4_000_000,
      byBuilding: new Map([[A, { name: 'Toà A', income: 10_000_000, expense: 4_000_000 }]]),
    };
    const adj = subtractEngineExclusions(fa, ex);
    expect(adj).toMatchObject({ income: 7_000_000, expense: 2_800_000 });
    expect(adj.byBuilding.get(A)).toEqual({ name: 'Toà A', income: 7_000_000, expense: 2_800_000 });
    expect(subtractEngineExclusions(fa, NO_ENGINE_EXCLUSIONS)).toBe(fa);
    expect(lockedMonthsOf(data, A)).toEqual(new Set(['2025-08-01']));
    expect(lockedMonthsOf(data, B)).toEqual(new Set());
  });

  it('chữ chip / cảnh báo / lý do', () => {
    const fmt = (n: number) => `${n}`;
    expect(postLockChipText({ count: 0, income: 0, expense: 0 }, fmt)).toBeNull();
    expect(postLockChipText({ count: 2, income: 5, expense: 7 }, fmt)).toBe(
      'Phát sinh sau chốt — chưa cộng vào tháng đã chốt: 2 khoản · thu 5 · chi 7',
    );
    expect(postLockWarnings({ count: 0, income: 0, expense: 0 })).toEqual([]);
    expect(postLockWarnings({ count: 1, income: 0, expense: 1_200_000 })[0]).toContain('Muốn cộng: mở khoá tháng ở tab Chốt LN rồi chốt lại');
    expect(postLockReason(entry({}))).toBe('Kỳ 01/08/2025–31/08/2025');
    expect(postLockReason(entry({ type: 'INCOME', invoice_month: '2025-08' }))).toBe('Thu tiền hoá đơn 08/2025');
    expect(postLockReason(entry({ period_from: null, period_to: null }))).toBe('Ngày phiếu 05/09/2025');
  });

  it('tab Chốt LN: nhãn theo toà × tháng', () => {
    const data = profitPostLockSchema.parse({
      from: '2025-08-01', to: '2025-08-01', locked: [],
      after_lock: [entry({ voucher_id: V1 }), entry({ voucher_id: V2, expense: 1 }), entry({ voucher_id: V3, building_id: B })],
    });
    const cells = postLockByBuildingMonth(data);
    expect(postLockLockTabLabel(cells.get(`${A}|2025-08`))).toBe('2 khoản phát sinh sau chốt (chưa cộng)');
    expect(postLockLockTabLabel(cells.get(`${B}|2025-08`))).toBe('1 khoản phát sinh sau chốt (chưa cộng)');
    expect(postLockLockTabLabel(cells.get(`${A}|2025-09`))).toBeNull();
  });

  it('gói sai hình ⇒ zod ném', () => {
    expect(() => profitPostLockSchema.parse({ from: '2025-08-01', to: '2025-08-01', locked: [], after_lock: [{ voucher_id: 'x' }] })).toThrow();
  });
});
