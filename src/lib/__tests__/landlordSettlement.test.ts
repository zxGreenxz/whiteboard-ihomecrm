import { describe, expect, it } from 'vitest';
import {
  barPercent,
  calcLines,
  confirmReceiptSchema,
  depositAdjustmentLine,
  initialsOf,
  landlordOperationOptionsSchema,
  monthConfirmState,
  noteUpdateReceiptSchema,
  settlementOverviewSchema,
  settlementYears,
  shareText,
  vnDate,
  vnDateTime,
  describeNet,
  describeOperationChange,
  ihomeLineOf,
  ihomeProfitOf,
  landlordErrorMessage,
  landlordShortfallOf,
  managerTermsLabel,
  managerTermsShort,
  pendingBuildingIdsOf,
  landlordShareUrl,
  monthKey,
  monthLabel,
  monthShort,
  monthToDate,
  monthsDescending,
  sameIdSet,
  termsAt,
  settlementMonthSchema,
  settlementPublicSchema,
} from '@/lib/landlordSettlement';

const statement = {
  period_month: '2025-01-01',
  manager_percent: 30,
  terms_from: '2025-01-01',
  totals: {
    landlord_collected: 10_000_000, manager_collected: 1_550_000, revenue: 11_550_000,
    landlord_paid: 500_000, manager_paid: 2_030_000, expense: 2_530_000, profit: 9_020_000,
    manager_share: 2_706_000, landlord_share: 6_314_000, landlord_held_deposits: 0, landlord_extra_cash: 0,
    landlord_owes_manager: 3_186_000,
  },
  reversed_voucher_count: 0,
  unposted_voucher_count: 0,
  foreign_account_voucher_count: 0,
  deposits: { received: 3_000_000, paid_out: 400_000, landlord_received: 0, landlord_paid_out: 0 },
  termination: {
    revenue_from_deposit: 400_000, forfeit_revenue: 0, extra_receipt: 0, refund_beyond_deposit: 0,
    deposit_refunded: 0, deposit_offset: 400_000, pending_refund: 0,
  },
  pending: { voucher_count: 1, income: 0, expense: 700_000, landlord_deposit: 0 },
  excluded: { voucher_count: 0, income: 0, expense: 0 },
  vouchers: [{
    code: 'PT1', voucher_date: '2025-01-05', type: 'INCOME', name: 'Tiền phòng', account_name: 'Sổ chủ nhà',
    side: 'LANDLORD', group: 'PNL', source: null, cash_reversed: false, cash_unposted: false, restricted: false, excluded_reason: null, status: 'APPROVED', amount: 10_000_000,
  }],
  source_hash: 'abc',
};

const month = {
  building_name: 'Toà A', landlord_name: 'Chủ nhà A', period_month: '2025-01-01', status: 'OPEN',
  effective_from: '2025-01-01', is_current_month: false, statement, live_hash: null, is_stale: false,
  closed: null, can_close: false, close_blockers: [], warnings: null, kqkd_bridge: null,
};

describe('đọc gói quyết toán', () => {
  it('nhận gói link công khai (không có id phiếu)', () => {
    const parsed = settlementPublicSchema.parse({
      overview: {
        building_name: 'Toà A', landlord_name: 'Chủ nhà A', manager_percent: 30, manager_fixed_amount: 0, effective_from: '2025-01-01',
        is_active: true, opening_confirmed: true, current_month: '2025-02-01',
        months: [{
          period_month: '2025-01-01', status: 'OPEN', is_stale: false, is_current_month: false, manager_percent: 30,
          manager_fixed_amount: 0, revenue: 1, expense: 0, profit: 1, manager_share: 0, landlord_owes_manager: 0, pending_count: 0,
        }],
        payments: [{ paid_on: '2025-02-03', direction: 'LANDLORD_TO_MANAGER', amount: 1_000_000, note: null }],
        totals: { opening_balance: 0, closed_month_count: 0, closed_net: 0, open_net: 0, paid_by_landlord: 1_000_000, paid_by_manager: 0, balance_closed: -1_000_000, balance_with_open: -1_000_000 },
      },
      month,
    });
    expect(parsed.month.statement?.totals.landlord_owes_manager).toBe(3_186_000);
  });

  it('gói sai hình thì ném, không đoán số', () => {
    expect(() => settlementMonthSchema.parse({ ...month, statement: { ...statement, totals: { ...statement.totals, profit: '9020000' } } })).toThrow();
    expect(() => settlementMonthSchema.parse({ ...month, status: 'LOCKED' })).toThrow();
    expect(() => settlementMonthSchema.parse({ ...month, close_blockers: ['UNKNOWN'] })).toThrow();
    expect(() => settlementMonthSchema.parse({ ...month, statement: { ...statement, manager_fixed_amount: '5000000' } })).toThrow();
    expect(() => settlementMonthSchema.parse({ ...month, statement: { ...statement, totals: { ...statement.totals, manager_fixed_share: null } } })).toThrow();
  });

  it('ảnh chốt trước 23/10/2026 (chỉ có %): tiền cố định 0, phần % là toàn bộ phần quản lý server đã tính', () => {
    const st = settlementMonthSchema.parse(month).statement!;
    expect(st.manager_fixed_amount).toBe(0);
    expect([st.totals.manager_fixed_share, st.totals.manager_percent_share, st.totals.manager_share]).toEqual([0, 2_706_000, 2_706_000]);
  });

  it('gói có tiền cố định: lấy nguyên hai phần server tách, không tự cộng trừ', () => {
    const st = settlementMonthSchema.parse({
      ...month,
      statement: {
        ...statement, manager_fixed_amount: 5_000_000,
        totals: { ...statement.totals, manager_fixed_share: 5_000_000, manager_percent_share: 2_706_000, manager_share: 7_706_000 },
      },
    }).statement!;
    expect([st.manager_fixed_amount, st.totals.manager_fixed_share, st.totals.manager_percent_share, st.totals.manager_share])
      .toEqual([5_000_000, 5_000_000, 2_706_000, 7_706_000]);
  });
});

describe('phần quản lý: tiền cố định và/hoặc %', () => {
  const vnd = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
  it.each([
    [{ manager_percent: 30, manager_fixed_amount: 5_000_000 }, '5.000.000 đ/tháng + 30% lợi nhuận', 'cố định + 30%'],
    [{ manager_percent: 0, manager_fixed_amount: 5_000_000 }, '5.000.000 đ/tháng cố định', 'cố định'],
    [{ manager_percent: 12.5, manager_fixed_amount: 0 }, '12,5% lợi nhuận', '12,5%'],
  ])('%o ⇒ %s', (t, dai, ngan) => {
    expect(managerTermsLabel(t, vnd)).toBe(dai);
    expect(managerTermsShort(t)).toBe(ngan);
  });
  it('chủ nhà bù: chỉ khi có phần cố định và phần chủ nhà âm', () => {
    expect(landlordShortfallOf({ manager_fixed_share: 5_000_000, landlord_share: -7_000_000 })).toBe(7_000_000);
    expect(landlordShortfallOf({ manager_fixed_share: 5_000_000, landlord_share: 0 })).toBeNull();
    expect(landlordShortfallOf({ manager_fixed_share: 5_000_000, landlord_share: 1_209_000 })).toBeNull();
    // không có phần cố định: phần chủ nhà âm là lỗ của tháng (luật cũ), không phải "bù phí"
    expect(landlordShortfallOf({ manager_fixed_share: 0, landlord_share: -2_000_000 })).toBeNull();
  });
});

describe('chiều quyết toán', () => {
  it.each([
    [3_186_000, 'LANDLORD_PAYS', 3_186_000],
    [-250_000, 'MANAGER_PAYS', 250_000],
    [0, 'EVEN', 0],
    [0.4, 'EVEN', 0],
  ] as const)('%d ⇒ %s %d', (net, direction, amount) => {
    expect(describeNet(net)).toEqual({ direction, amount });
  });
  it('số không hữu hạn là lỗi', () => {
    expect(() => describeNet(Number.NaN)).toThrow();
  });
});

describe('tháng', () => {
  it('đổi định dạng và liệt kê tháng mới nhất trước, qua năm', () => {
    expect(monthKey('2026-10-01')).toBe('2026-10');
    expect(monthToDate('2026-10')).toBe('2026-10-01');
    expect(monthLabel('2026-10-01')).toBe('Tháng 10/2026');
    expect(monthsDescending('2025-11-01', '2026-02-01')).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
    expect(monthsDescending('2026-11-01', '2026-10-01')).toEqual([]);
    expect(() => monthKey('10/2026')).toThrow();
  });
  it('link chủ nhà bỏ dấu / thừa ở origin', () => {
    expect(landlordShareUrl('https://ptcrm.vercel.app/', 'abc')).toBe('https://ptcrm.vercel.app/qt/abc');
  });
  it('tháng ngắn và so tập sổ không kể thứ tự', () => {
    expect(monthShort('2026-03-01')).toBe('03/2026');
    expect(sameIdSet(['a', 'b'], ['b', 'a', 'a'])).toBe(true);
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
  });
  it('điều khoản đang áp ở một tháng', () => {
    const ts = [{ valid_from: '2025-01-01', p: 30 }, { valid_from: '2025-04-01', p: 40 }];
    expect(termsAt(ts, '2025-03')?.p).toBe(30);
    expect(termsAt(ts, '2025-04')?.p).toBe(40);
    expect(termsAt(ts, '2024-12')?.p).toBe(30);
    expect(termsAt([], '2025-01')).toBeNull();
  });
});

describe('lịch sử cài đặt toà', () => {
  const vnd = (n: number) => `${n}đ`;
  const base = {
    landlord_name: 'Chủ nhà A', effective_from: '2025-01-01', note: null, is_active: true,
    opening_balance: 0, opening_confirmed_at: null,
    terms: [{ valid_from: '2025-01-01', manager_percent: 30, landlord_account_ids: ['s1'] }],
  };
  it('tạo mới', () => {
    expect(describeOperationChange(null, base, vnd)).toEqual(['Tạo cài đặt']);
  });
  it('nói đúng trường đổi: điều khoản theo tháng, số dư đầu kỳ, xác nhận, ngừng áp dụng', () => {
    const after = {
      ...base,
      opening_balance: 300_000,
      opening_confirmed_at: '2026-10-21T10:00:00Z',
      is_active: false,
      terms: [...base.terms, { valid_from: '2025-03-01', manager_percent: 40, landlord_account_ids: ['s1', 's2'] }],
    };
    expect(describeOperationChange(base, after, vnd)).toEqual([
      'Phần quản lý / sổ chủ nhà: từ 01/2025: 30% · 1 sổ chủ nhà → từ 01/2025: 30% · 1 sổ chủ nhà; từ 03/2025: 40% · 2 sổ chủ nhà',
      'Số dư đầu kỳ: 0đ → 300000đ',
      'Xác nhận số dư đầu kỳ với chủ nhà',
      'Ngừng áp dụng',
    ]);
    expect(describeOperationChange(after, { ...after, opening_confirmed_at: null }, vnd)).toEqual(['Bỏ xác nhận số dư đầu kỳ']);
    expect(describeOperationChange(base, { ...base, effective_from: '2024-12-01' }, vnd)).toEqual(['Áp dụng từ: 01/2025 → 12/2024']);
  });
  it('đổi tiền cố định: nói rõ số trước/sau; ảnh cũ không có trường thì coi là 0', () => {
    const after = { ...base, terms: [{ ...base.terms[0]!, manager_fixed_amount: 5_000_000 }] };
    expect(describeOperationChange(base, after, vnd)).toEqual([
      'Phần quản lý / sổ chủ nhà: từ 01/2025: 30% · 1 sổ chủ nhà → từ 01/2025: 30% + 5000000đ/tháng · 1 sổ chủ nhà',
    ]);
  });
});

describe('lợi nhuận của iHome trên Báo cáo LN', () => {
  const A = '00000000-0000-4000-8000-0000000000aa';
  const B = '00000000-0000-4000-8000-0000000000bb';
  const rows = [
    { building_id: A, period_month: '2026-10-01', status: 'CLOSED' as const, profit: 40_000_000, manager_share: 12_000_000, landlord_share: 28_000_000 },
    { building_id: A, period_month: '2026-11-01', status: 'OPEN' as const, profit: 10_000_000, manager_share: 3_000_000, landlord_share: 7_000_000 },
    // tháng lỗ: quản lý 0đ, chủ nhà chịu cả phần lỗ ⇒ iHome = tổng + 5tr
    { building_id: B, period_month: '2026-10-01', status: 'OPEN' as const, profit: -5_000_000, manager_share: 0, landlord_share: -5_000_000 },
  ];
  it('tổng − phần chủ nhà của toà vận hành trong đúng tháng và toà đang xem', () => {
    expect(ihomeProfitOf(100_000_000, rows, { months: ['2026-10'], buildingIds: null }))
      .toEqual({ profit: 77_000_000, landlordShare: 23_000_000, operatedCount: 2, provisional: true });
    expect(ihomeProfitOf(100_000_000, rows, { months: ['2026-10-01'], buildingIds: [A] }))
      .toEqual({ profit: 72_000_000, landlordShare: 28_000_000, operatedCount: 1, provisional: false });
  });
  it('tháng lỗ có phí quản lý cố định: phần chủ nhà âm ⇒ của iHome = tổng + phần chủ nhà bù (= đúng phí cố định)', () => {
    // LN toà −2tr, phí cố định 5tr ⇒ phần chủ nhà −7tr ⇒ iHome = −2tr − (−7tr) = 5tr
    const lo = [{ building_id: A, period_month: '2026-12-01', status: 'OPEN' as const, profit: -2_000_000, manager_share: 5_000_000, landlord_share: -7_000_000 }];
    expect(ihomeProfitOf(-2_000_000, lo, { months: ['2026-12'], buildingIds: [A] }))
      .toEqual({ profit: 5_000_000, landlordShare: -7_000_000, operatedCount: 1, provisional: true });
  });
  it('không có toà vận hành trong phạm vi ⇒ bằng đúng tổng', () => {
    expect(ihomeProfitOf(50_000_000, rows, { months: ['2026-09'], buildingIds: null }))
      .toEqual({ profit: 50_000_000, landlordShare: 0, operatedCount: 0, provisional: false });
  });

  const none: ReadonlySet<string> = new Set();
  const base = { ym: '2026-10', buildingIds: [] as string[], totalProfit: 100_000_000, sameBasis: true, pendingBuildingIds: none };
  it('dòng iHome: không có toà vận hành trong phạm vi ⇒ ẩn (tổng chính là của iHome)', () => {
    expect(ihomeLineOf(rows, { ...base, ym: '2026-09' })).toEqual({ kind: 'hidden' });
    expect(ihomeLineOf(rows, { ...base, buildingIds: ['00000000-0000-4000-8000-0000000000cc'] })).toEqual({ kind: 'hidden' });
  });
  it('dòng iHome: trang đang xem cơ sở khác (theo ngày phiếu / gồm cọc) ⇒ không trừ, báo khác cơ sở', () => {
    expect(ihomeLineOf(rows, { ...base, sameBasis: false })).toEqual({ kind: 'other-basis', operatedCount: 2 });
  });
  it('dòng iHome: đúng cơ sở ⇒ tổng − phần chủ nhà; tháng chưa chốt ⇒ tạm tính', () => {
    expect(ihomeLineOf(rows, base)).toEqual({ kind: 'ready', profit: 77_000_000, operatedCount: 2, provisional: true });
    expect(ihomeLineOf(rows, { ...base, buildingIds: [A] }))
      .toEqual({ kind: 'ready', profit: 72_000_000, operatedCount: 1, provisional: false });
  });
  it('dòng iHome: toà vận hành còn phiếu chờ duyệt trong tổng ⇒ tạm tính dù tháng đã chốt', () => {
    expect(ihomeLineOf(rows, { ...base, buildingIds: [A], pendingBuildingIds: new Set([A]) }))
      .toEqual({ kind: 'ready', profit: 72_000_000, operatedCount: 1, provisional: true });
    // phiếu chờ duyệt ở toà KHÔNG vận hành (hoặc ngoài phạm vi lọc) không làm dòng iHome thành tạm tính
    expect(ihomeLineOf(rows, { ...base, buildingIds: [A], pendingBuildingIds: new Set([B, 'toa-thuong']) }))
      .toEqual({ kind: 'ready', profit: 72_000_000, operatedCount: 1, provisional: false });
    // toà vận hành chỉ có quyết toán ở tháng KHÁC (chưa áp dụng ở tháng đang xem) ⇒ không xét
    const C = '00000000-0000-4000-8000-0000000000cc';
    const rows2 = [rows[0]!, { ...rows[1]!, building_id: C }];
    expect(ihomeLineOf(rows2, { ...base, pendingBuildingIds: new Set([C]) }))
      .toEqual({ kind: 'ready', profit: 72_000_000, operatedCount: 1, provisional: false });
  });
  it('toà có phiếu chờ duyệt: chỉ lấy dòng UNAPPROVED có toà', () => {
    const ids = pendingBuildingIdsOf([
      { buildingId: A, approvalStatus: 'UNAPPROVED' },
      { buildingId: B, approvalStatus: 'APPROVED' },
      { buildingId: null, approvalStatus: 'UNAPPROVED' },
    ]);
    expect([...ids]).toEqual([A]);
    expect(pendingBuildingIdsOf(undefined).size).toBe(0);
  });
});

describe('câu báo lỗi', () => {
  it('lỗi RPC quyết toán có câu tiếng Việt thì hiện nguyên câu', () => {
    const msg = 'Còn 2 phiếu chờ duyệt trong tháng 01/2025 — duyệt hoặc huỷ trước khi chốt';
    expect(landlordErrorMessage({ code: '55000', message: msg }, 'x')).toBe(msg);
  });
  it('lỗi thô của Postgres đi qua friendlyError, không lộ câu tiếng Anh', () => {
    const out = landlordErrorMessage({ code: '42501', message: 'permission denied for function landlord_settlement_month_v1' }, 'Chưa tải được');
    expect(out).not.toMatch(/permission denied/);
  });
});

describe('hợp đồng dữ liệu v3 (bàn giao, người giữ cọc, hạng mục)', () => {
  const overviewCu = {
    building_name: 'Toà A', landlord_name: 'Chủ nhà A', manager_percent: 30, effective_from: '2025-01-01',
    is_active: true, opening_confirmed: true, current_month: '2025-02-01',
    months: [{
      period_month: '2025-01-01', status: 'CLOSED', is_stale: false, is_current_month: false, manager_percent: 30,
      revenue: 1, expense: 0, profit: 1, manager_share: 0, landlord_owes_manager: 0, pending_count: 0,
    }],
    payments: [],
    totals: { opening_balance: 0, closed_month_count: 1, closed_net: 0, open_net: 0, paid_by_landlord: 0, paid_by_manager: 0, balance_closed: 0, balance_with_open: 0 },
  };

  it('gói CŨ (thiếu mọi trường mới): mặc định đúng hợp đồng, không tự tính số', () => {
    const m = settlementMonthSchema.parse({
      ...month,
      status: 'CLOSED',
      closed: { revision: 2, closed_at: '2025-02-01T00:00:00Z', note: null, closed_by_name: null },
      statement: { ...statement, totals: { ...statement.totals, landlord_held_deposits: 250_000 } },
    });
    const st = m.statement!;
    expect(st.deposit_holder).toBe('MANAGER');
    // thiếu deposit_adjustment ⇒ CHÉP landlord_held_deposits; cọc sổ quản lý không biết ⇒ null
    expect(st.totals.deposit_adjustment).toBe(250_000);
    expect(st.totals.manager_held_deposits).toBeNull();
    expect([st.deposits.manager_received, st.deposits.manager_paid_out]).toEqual([null, null]);
    expect(st.pending.deposit).toBe(st.pending.landlord_deposit);
    expect(st.categories).toBeNull();
    expect(st.vouchers[0]!.lines).toBeNull();
    expect(m.closed!.note_updated_at).toBeNull();
    expect(m.confirmation).toBeNull();

    const o = settlementOverviewSchema.parse(overviewCu);
    expect(o.deposit_holder).toBeNull();
    const t = o.months[0]!;
    expect([t.manager_fixed_share, t.manager_percent_share, t.manager_paid, t.manager_collected, t.deposit_holder,
      t.deposit_adjustment, t.extra_cash, t.close_revision, t.confirmed_at]).toEqual([null, null, null, null, null, null, null, null, null]);
  });

  it('gói MỚI: lấy nguyên các trường server trả', () => {
    const m = settlementMonthSchema.parse({
      ...month,
      status: 'CLOSED',
      closed: { revision: 2, closed_at: '2025-02-01T00:00:00Z', note: 'Ghi chú', closed_by_name: 'A', note_updated_at: '2025-02-02T00:00:00Z' },
      confirmation: { confirmed_at: '2025-02-03T00:00:00Z', note: null },
      statement: {
        ...statement,
        deposit_holder: 'LANDLORD',
        totals: { ...statement.totals, manager_held_deposits: 3_000_000, deposit_adjustment: -3_000_000 },
        deposits: { ...statement.deposits, manager_received: 3_000_000, manager_paid_out: 0 },
        pending: { ...statement.pending, deposit: -500_000 },
        categories: { income: [{ name: 'Tiền phòng', amount: 10_000_000, landlord_amount: 10_000_000, manager_amount: 0 }], expense: [] },
        vouchers: [{ ...statement.vouchers[0], lines: [{ category: 'Tiền phòng', amount: 10_000_000 }] }],
      },
    });
    const st = m.statement!;
    expect(st.deposit_holder).toBe('LANDLORD');
    expect([st.totals.manager_held_deposits, st.totals.deposit_adjustment]).toEqual([3_000_000, -3_000_000]);
    expect(st.pending.deposit).toBe(-500_000);
    expect(st.categories?.income[0]?.landlord_amount).toBe(10_000_000);
    expect(st.vouchers[0]!.lines).toEqual([{ category: 'Tiền phòng', amount: 10_000_000 }]);
    expect(m.closed!.note_updated_at).toBe('2025-02-02T00:00:00Z');
    expect(m.confirmation).toEqual({ confirmed_at: '2025-02-03T00:00:00Z', note: null });

    const o = settlementOverviewSchema.parse({
      ...overviewCu,
      deposit_holder: 'LANDLORD',
      months: [{ ...overviewCu.months[0], manager_paid: 1, manager_collected: 2, deposit_holder: 'LANDLORD', deposit_adjustment: -3, extra_cash: 0, close_revision: 2, confirmed_at: '2025-02-03T00:00:00Z' }],
    });
    expect(o.deposit_holder).toBe('LANDLORD');
    expect(o.months[0]!.confirmed_at).toBe('2025-02-03T00:00:00Z');
    expect(o.months[0]!.deposit_adjustment).toBe(-3);
  });

  it('trường mới sai hình thì ném (không đoán)', () => {
    expect(() => settlementMonthSchema.parse({ ...month, statement: { ...statement, deposit_holder: 'TENANT' } })).toThrow();
    expect(() => settlementMonthSchema.parse({ ...month, statement: { ...statement, totals: { ...statement.totals, deposit_adjustment: '1' } } })).toThrow();
    expect(() => settlementMonthSchema.parse({ ...month, confirmation: { note: 'x' } })).toThrow();
  });

  it('cài đặt toà: người giữ cọc thiếu ⇒ "MANAGER" (luật cũ)', () => {
    const o = landlordOperationOptionsSchema.parse({
      current: {
        landlord_name: 'A', manager_percent: 30, landlord_account_ids: [], terms_from: '2025-01-01', effective_from: '2025-01-01',
        note: null, is_active: true, opening_balance: 0, opening_confirmed_at: null, opening_confirmation_stale: false,
        opening_confirmed_pre_start: null, pre_start_landlord_deposits: 0, first_closed_month: null, last_closed_month: null,
        next_terms_month: '2025-01-01', terms: [{ valid_from: '2025-01-01', manager_percent: 30, landlord_account_ids: [] }],
        updated_at: '2025-01-01T00:00:00Z',
      },
      accounts: [], history: [],
    });
    expect(o.current?.deposit_holder).toBe('MANAGER');
    expect(o.current?.terms[0]?.deposit_holder).toBe('MANAGER');
  });

  it('biên nhận ghi chú / xác nhận: thiếu trường là chưa xác nhận', () => {
    expect(noteUpdateReceiptSchema.safeParse({ status: 'UPDATED', revision: 2, updated_at: 'x' }).success).toBe(true);
    expect(noteUpdateReceiptSchema.safeParse({ status: 'UPDATED' }).success).toBe(false);
    expect(confirmReceiptSchema.safeParse({ status: 'ALREADY_CONFIRMED', confirmed_at: 'x' }).success).toBe(true);
    expect(confirmReceiptSchema.safeParse({ status: 'CONFIRMED' }).success).toBe(false);
  });

  it('dòng cọc theo người giữ cọc và dấu của deposit_adjustment', () => {
    expect(depositAdjustmentLine('MANAGER', 300_000)).toEqual({ label: '+ Cọc của khách ở sổ chủ nhà', sub: 'quản lý giữ cọc → chủ nhà bàn giao cho quản lý', amount: 300_000 });
    expect(depositAdjustmentLine('MANAGER', -200_000).label).toBe('− Cọc chủ nhà đã chi trả khách thay quản lý');
    expect(depositAdjustmentLine('LANDLORD', -5_400_000)).toEqual({ label: '− Cọc của khách ở sổ quản lý', sub: 'chủ nhà giữ cọc → quản lý bàn giao cho chủ nhà', amount: 5_400_000 });
    expect(depositAdjustmentLine('LANDLORD', 0).sub).toBe('chủ nhà giữ cọc · tháng này sổ quản lý không có cọc');
  });

  it('tỷ lệ chỉ để vẽ / hiển thị: kẹp 0–100, tổng ≤ 0 thì không có', () => {
    expect(barPercent(2_700_000, 18_000_000)).toBe(15);
    expect(barPercent(5_000_000, 1_000_000)).toBe(100);
    expect(barPercent(5_000_000, -2_000_000)).toBe(0);
    expect(shareText(18, 20)).toBe('90%');
    expect(shareText(1, 12)).toBe('8,3%');
    expect(shareText(1, 0)).toBeNull();
  });

  it('giờ Việt Nam, năm, trạng thái xác nhận, chữ viết tắt', () => {
    expect(vnDateTime('2026-11-01T01:30:00Z')).toBe('08:30 · 01/11/2026');
    expect(vnDate('2026-10-31T18:00:00Z')).toBe('01/11/2026');
    expect(settlementYears([{ period_month: '2025-12-01' }, { period_month: '2026-01-01' }, { period_month: '2026-02-01' }])).toEqual(['2026', '2025']);
    expect(monthConfirmState({ status: 'OPEN', is_current_month: true, confirmed_at: null }, true)).toEqual({ kind: 'OPEN', text: 'Đang chạy' });
    expect(monthConfirmState({ status: 'CLOSED', is_current_month: false, confirmed_at: null }, true)).toEqual({ kind: 'WAITING', text: 'Chờ xác nhận' });
    expect(monthConfirmState({ status: 'CLOSED', is_current_month: false, confirmed_at: null }, false)).toEqual({ kind: 'WAITING', text: 'Chưa xác nhận' });
    expect(monthConfirmState({ status: 'CLOSED', is_current_month: false, confirmed_at: 'x' }, false)).toEqual({ kind: 'CONFIRMED', at: 'x' });
    expect([initialsOf('Tiền điện'), initialsOf('Internet'), initialsOf(null)]).toEqual(['TĐ', 'IN', '—']);
  });

  it('lịch sử cài đặt: nói được đổi người giữ cọc (kể cả mốc mới); ảnh cũ không có trường thì im', () => {
    const vnd = (n: number) => `${n}đ`;
    const truoc = { terms: [{ valid_from: '2025-01-01', manager_percent: 30, landlord_account_ids: ['s1'], deposit_holder: 'MANAGER' }] };
    const sau = { terms: [...truoc.terms, { valid_from: '2025-03-01', manager_percent: 30, landlord_account_ids: ['s1'], deposit_holder: 'LANDLORD' }] };
    expect(describeOperationChange(truoc, sau, vnd)).toEqual([
      'Phần quản lý / sổ chủ nhà: từ 01/2025: 30% · 1 sổ chủ nhà · quản lý giữ cọc → từ 01/2025: 30% · 1 sổ chủ nhà · quản lý giữ cọc; từ 03/2025: 30% · 1 sổ chủ nhà · chủ nhà giữ cọc',
      'Người giữ cọc từ 03/2025: Quản lý → Chủ nhà',
    ]);
    const cu = { terms: [{ valid_from: '2025-01-01', manager_percent: 30, landlord_account_ids: ['s1'] }] };
    const moi = { terms: [{ ...cu.terms[0]!, deposit_holder: 'LANDLORD' }] };
    expect(describeOperationChange(cu, moi, vnd)).toEqual([
      'Phần quản lý / sổ chủ nhà: từ 01/2025: 30% · 1 sổ chủ nhà → từ 01/2025: 30% · 1 sổ chủ nhà · chủ nhà giữ cọc',
    ]);
  });
});

describe('dòng "Cách tính"', () => {
  const vnd = (n: number) => `${n.toLocaleString('vi-VN')} đ`;
  const base = {
    managerPercent: 30, managerFixedAmount: 0, managerShare: 3_000_000, fixedShare: 0, percentShare: 3_000_000, profit: 10_000_000,
    managerPaid: 1, managerCollected: 2, depositHolder: 'LANDLORD' as const, depositAdjustment: -5, extraCash: 7,
  };
  it('đủ trường: phần quản lý, chi hộ, thu hộ, cọc theo người giữ, tiền thối', () => {
    expect(calcLines(base, vnd).map((l) => [l.key, l.label, l.amount])).toEqual([
      ['share', 'Phần quản lý', 3_000_000], ['paid', '+ Quản lý đã chi hộ', 1], ['collected', '− Quản lý đã thu hộ', 2],
      ['deposit', '− Cọc của khách ở sổ quản lý', 5], ['extra', '+ Tiền thối của khách nằm ở sổ chủ nhà', 7],
    ]);
  });
  it('tháng cũ thiếu số tách mà điều khoản có tiền cố định: một dòng, chữ phụ là thoả thuận; trường null thì ẩn', () => {
    const l = calcLines({
      ...base, managerFixedAmount: 5_000_000, fixedShare: null, percentShare: null, managerPaid: null,
      managerCollected: null, depositHolder: null, depositAdjustment: null, extraCash: null,
    }, vnd);
    expect(l).toEqual([{ key: 'share', label: 'Phần quản lý', sub: '5.000.000 đ/tháng + 30% lợi nhuận', amount: 3_000_000, muted: false }]);
  });
});
