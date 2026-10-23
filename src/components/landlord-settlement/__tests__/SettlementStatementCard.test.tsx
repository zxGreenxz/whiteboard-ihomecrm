// @vitest-environment jsdom
// Bảng quyết toán tháng (màn quản trị và link chủ nhà /qt/:token): phí quản lý cố định và phần % tách dòng
// khi có; tháng lỗ có phí cố định thì nói rõ chủ nhà phải bù. Số liệu giả.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { settlementMonthSchema } from '@/lib/landlordSettlement';
import { SettlementStatementCard } from '../SettlementStatementCard';

afterEach(() => cleanup());

const thang = (p: { pct: number; coDinh: number; profit: number; phanTram: number }) => {
  const share = p.coDinh + p.phanTram;
  return settlementMonthSchema.parse({
    building_name: 'Toà A', landlord_name: 'Chủ nhà A', period_month: '2025-02-01', status: 'OPEN',
    effective_from: '2025-01-01', is_current_month: false, live_hash: 'h', is_stale: false, closed: null,
    can_close: false, close_blockers: [], warnings: null, kqkd_bridge: null,
    statement: {
      period_month: '2025-02-01', manager_percent: p.pct, manager_fixed_amount: p.coDinh, terms_from: '2025-01-01',
      totals: {
        landlord_collected: 1_000_000, manager_collected: 0, revenue: 1_000_000, landlord_paid: 0,
        manager_paid: 1_000_000 - p.profit, expense: 1_000_000 - p.profit, profit: p.profit,
        manager_fixed_share: p.coDinh, manager_percent_share: p.phanTram, manager_share: share,
        landlord_share: p.profit - share, landlord_held_deposits: 0, landlord_extra_cash: 0,
        landlord_owes_manager: share + 1_000_000 - p.profit,
      },
      reversed_voucher_count: 0, unposted_voucher_count: 0, foreign_account_voucher_count: 0,
      deposits: { received: 0, paid_out: 0, landlord_received: 0, landlord_paid_out: 0 },
      termination: { revenue_from_deposit: 0, forfeit_revenue: 0, extra_receipt: 0, refund_beyond_deposit: 0, deposit_refunded: 0, deposit_offset: 0, pending_refund: 0 },
      pending: { voucher_count: 0, income: 0, expense: 0, landlord_deposit: 0 },
      excluded: { voucher_count: 0, income: 0, expense: 0 },
      vouchers: [],
      source_hash: 'h',
    },
  });
};
const khoiQuyetToan = () => within(screen.getByTestId('settlement-net'));

it.each(['admin', 'public'] as const)('tháng lỗ, phí cố định 5tr + 30%% (%s): tách hai dòng và nói rõ chủ nhà bù', (mode) => {
  render(<SettlementStatementCard month={thang({ pct: 30, coDinh: 5_000_000, profit: -2_000_000, phanTram: 0 })} mode={mode} />);
  expect(screen.getByText(/Quản lý nhận 5\.000\.000.*\/tháng \+ 30% lợi nhuận/)).toBeTruthy();
  const net = khoiQuyetToan();
  expect(net.getByText('Phí quản lý cố định').nextElementSibling?.textContent).toMatch(/5\.000\.000/);
  expect(net.getByText(/\+ Phần quản lý \(30% lợi nhuận — lỗ hoặc hoà nên 0đ\)/).nextElementSibling?.textContent).toMatch(/^0/);
  const bu = screen.getByTestId('settlement-landlord-shortfall').textContent ?? '';
  expect(bu).toMatch(/lỗ 2\.000\.000/);
  expect(bu).toMatch(/chủ nhà phải bù 7\.000\.000/);
});

it('lãi ít hơn phí cố định: vẫn báo chủ nhà bù phần thiếu', () => {
  render(<SettlementStatementCard month={thang({ pct: 0, coDinh: 5_000_000, profit: 1_000_000, phanTram: 0 })} mode="public" />);
  expect(screen.getByTestId('settlement-landlord-shortfall').textContent).toMatch(/không đủ trả phí quản lý 5\.000\.000.*bù 4\.000\.000/);
  // chỉ cố định: không có dòng %
  expect(khoiQuyetToan().queryByText(/Phần quản lý \(/)).toBeNull();
});

it('chỉ %: một dòng như cũ, không có dòng phí cố định; tháng lỗ không có câu "chủ nhà bù"', () => {
  render(<SettlementStatementCard month={thang({ pct: 30, coDinh: 0, profit: -2_000_000, phanTram: 0 })} mode="admin" />);
  expect(khoiQuyetToan().queryByText('Phí quản lý cố định')).toBeNull();
  expect(khoiQuyetToan().getByText(/^Phần quản lý \(30% lợi nhuận/)).toBeTruthy();
  expect(screen.queryByTestId('settlement-landlord-shortfall')).toBeNull();
  expect(screen.getByText(/Quản lý nhận 30% lợi nhuận tháng \(lỗ thì không tính\)/)).toBeTruthy();
});
