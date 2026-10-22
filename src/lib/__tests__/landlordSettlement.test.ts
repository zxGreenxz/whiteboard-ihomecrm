import { describe, expect, it } from 'vitest';
import {
  describeNet,
  describeOperationChange,
  landlordErrorMessage,
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
        building_name: 'Toà A', landlord_name: 'Chủ nhà A', manager_percent: 30, effective_from: '2025-01-01',
        is_active: true, opening_confirmed: true, current_month: '2025-02-01',
        months: [{
          period_month: '2025-01-01', status: 'OPEN', is_stale: false, is_current_month: false, manager_percent: 30, revenue: 1, expense: 0,
          profit: 1, manager_share: 0, landlord_owes_manager: 0, pending_count: 0,
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
      'Tỷ lệ / sổ chủ nhà: từ 01/2025: 30% · 1 sổ chủ nhà → từ 01/2025: 30% · 1 sổ chủ nhà; từ 03/2025: 40% · 2 sổ chủ nhà',
      'Số dư đầu kỳ: 0đ → 300000đ',
      'Xác nhận số dư đầu kỳ với chủ nhà',
      'Ngừng áp dụng',
    ]);
    expect(describeOperationChange(after, { ...after, opening_confirmed_at: null }, vnd)).toEqual(['Bỏ xác nhận số dư đầu kỳ']);
    expect(describeOperationChange(base, { ...base, effective_from: '2024-12-01' }, vnd)).toEqual(['Áp dụng từ: 01/2025 → 12/2024']);
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
