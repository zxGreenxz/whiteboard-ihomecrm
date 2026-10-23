// Gói giả cho test giao diện Quyết toán vận hành v3 — tên / số tiền / mã đều giả. Gói đi qua đúng zod của
// app (settlementMonthSchema / settlementOverviewSchema) như dữ liệu server thật.
import {
  settlementMonthSchema,
  settlementOverviewSchema,
  type SettlementMonth,
  type SettlementOverview,
} from '@/lib/landlordSettlement';

type Obj = Record<string, unknown>;

const phieu = (p: Obj): Obj => ({
  code: 'PT', voucher_date: '2026-10-05', type: 'INCOME', name: 'Thu tiền phòng', account_name: 'Sổ chủ nhà',
  side: 'LANDLORD', group: 'PNL', source: null, cash_reversed: false, cash_unposted: false, restricted: false,
  excluded_reason: null, status: 'APPROVED', amount: 0, room_name: null, invoice: null, lines: null,
  ...p,
});

export const VOUCHERS_V3: Obj[] = [
  phieu({ code: 'PT1', name: 'Thu tiền phòng 101', amount: 12_000_000, room_name: '101',
    lines: [{ category: 'Tiền phòng', amount: 10_000_000 }, { category: 'Tiền điện', amount: 2_000_000 }] }),
  phieu({ code: 'PT2', name: 'Thu tiền phòng 102', amount: 8_000_000, room_name: '102', lines: [{ category: 'Tiền phòng', amount: 8_000_000 }] }),
  phieu({ code: 'PT3', name: 'Thu tiền phòng 103', amount: 3_000_000, room_name: '103', side: 'MANAGER', account_name: 'Sổ quản lý',
    lines: [{ category: 'Tiền phòng', amount: 3_000_000 }] }),
  phieu({ code: 'PC1', type: 'EXPENSE', name: 'Đóng tiền điện', amount: 5_000_000, side: 'MANAGER', account_name: 'Sổ quản lý',
    lines: [{ category: 'Tiền điện', amount: 5_000_000 }] }),
  phieu({ code: 'PT9', group: 'DEPOSIT', name: 'Thu cọc phòng 502', amount: 5_400_000, side: 'MANAGER', account_name: 'Sổ quản lý' }),
];

export function statementV3(over: Obj = {}, totals: Obj = {}): Obj {
  return {
    period_month: '2026-10-01', manager_percent: 15, manager_fixed_amount: 0, terms_from: '2026-07-01', deposit_holder: 'MANAGER',
    totals: {
      landlord_collected: 20_000_000, manager_collected: 3_000_000, revenue: 23_000_000,
      landlord_paid: 0, manager_paid: 5_000_000, expense: 5_000_000, profit: 18_000_000,
      manager_fixed_share: 0, manager_percent_share: 2_700_000, manager_share: 2_700_000, landlord_share: 15_300_000,
      landlord_held_deposits: 0, landlord_extra_cash: 0, landlord_owes_manager: 4_700_000,
      manager_held_deposits: 5_400_000, deposit_adjustment: 0,
      ...totals,
    },
    reversed_voucher_count: 0, unposted_voucher_count: 0, foreign_account_voucher_count: 0,
    deposits: { received: 5_400_000, paid_out: 0, landlord_received: 0, landlord_paid_out: 0, manager_received: 5_400_000, manager_paid_out: 0 },
    termination: { revenue_from_deposit: 0, forfeit_revenue: 0, extra_receipt: 0, refund_beyond_deposit: 0, deposit_refunded: 0, deposit_offset: 0, pending_refund: 0 },
    pending: { voucher_count: 0, income: 0, expense: 0, landlord_deposit: 0, deposit: 0 },
    excluded: { voucher_count: 0, income: 0, expense: 0 },
    vouchers: VOUCHERS_V3,
    categories: {
      income: [
        { name: 'Tiền phòng', amount: 21_000_000, landlord_amount: 18_000_000, manager_amount: 3_000_000 },
        { name: 'Tiền điện', amount: 2_000_000, landlord_amount: 2_000_000, manager_amount: 0 },
      ],
      expense: [{ name: 'Tiền điện', amount: 5_000_000, landlord_amount: 0, manager_amount: 5_000_000 }],
    },
    source_hash: 'h',
    ...over,
  };
}

export const CLOSED_V3 = {
  revision: 3, closed_at: '2026-11-01T01:30:00Z', note: 'P.103 chuyển khoản vào sổ quản lý.\nĐã sửa máy lạnh 301.',
  closed_by_name: 'Quản trị A', note_updated_at: null,
};

export function monthV3(over: Obj = {}, st: Obj = {}): SettlementMonth {
  return settlementMonthSchema.parse({
    building_name: 'Toà A', landlord_name: 'Chủ nhà A', period_month: '2026-10-01', status: 'OPEN',
    effective_from: '2025-12-01', is_current_month: false, statement: statementV3(st), live_hash: 'h', is_stale: false,
    closed: null, can_close: true, close_blockers: [], warnings: null, kqkd_bridge: null, confirmation: null,
    ...over,
  });
}

export const closedMonth = (over: Obj = {}, st: Obj = {}) => monthV3({ status: 'CLOSED', closed: CLOSED_V3, can_close: false, ...over }, st);

const thangTk = (period: string, p: Obj = {}): Obj => ({
  period_month: period, status: 'CLOSED', is_stale: false, is_current_month: false, manager_percent: 15, manager_fixed_amount: 0,
  revenue: 23_000_000, expense: 5_000_000, profit: 18_000_000, manager_share: 2_700_000, landlord_owes_manager: 4_700_000, pending_count: 0,
  ...p,
});

export function overviewV3(over: Obj = {}): SettlementOverview {
  return settlementOverviewSchema.parse({
    building_name: 'Toà A', landlord_name: 'Chủ nhà A', manager_percent: 15, manager_fixed_amount: 0, effective_from: '2025-12-01',
    is_active: true, opening_confirmed: true, current_month: '2026-11-01', deposit_holder: 'MANAGER',
    months: [
      // ảnh/server cũ: không có trường v3 ⇒ "Cách tính" chỉ còn dòng phần quản lý
      thangTk('2025-12-01'),
      thangTk('2026-09-01', {
        manager_fixed_share: 0, manager_percent_share: 2_700_000, manager_paid: 5_000_000, manager_collected: 3_000_000,
        deposit_holder: 'LANDLORD', deposit_adjustment: -1_000_000, extra_cash: 0, close_revision: 2, confirmed_at: '2026-10-02T03:00:00Z',
      }),
      thangTk('2026-10-01', { close_revision: 3, confirmed_at: null }),
      thangTk('2026-11-01', { status: 'OPEN', is_current_month: true, pending_count: 2 }),
    ],
    payments: [{ id: '00000000-0000-4000-8000-0000000000a1', paid_on: '2026-10-10', direction: 'LANDLORD_TO_MANAGER', amount: 1_000_000, note: 'CK', voided: false }],
    totals: {
      opening_balance: 0, closed_month_count: 3, closed_net: 14_100_000, open_net: 4_700_000, paid_by_landlord: 1_000_000,
      paid_by_manager: 0, balance_closed: 13_100_000, balance_with_open: 17_800_000,
    },
    ...over,
  });
}
