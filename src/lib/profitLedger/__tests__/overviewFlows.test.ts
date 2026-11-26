import { describe, expect, it } from 'vitest';
import {
  closingExplanation,
  flowTotal,
  overviewBalances,
  overviewVouchers,
  type OverviewFlow,
} from '../overviewFlows';
import type { MyLedgerPayout } from '../ledgerReaders';
import type { ShareholderPosition, ProfitSettlementRow } from '../positionReaders';

const row = (amount: number, period = '2026-02-01'): OverviewFlow => ({
  amount,
  period,
  key: period,
  title: 'Phiếu',
  note: '',
  counted: true,
});
const position = (balance: number) => ({ balance, components: {} }) as ShareholderPosition;
describe('Tổng quan và nguồn số dư', () => {
  it('đọc phiếu chốt đúng kỳ một lần, ứng tháng sau và chưa ghi sổ', () => {
    const p = {
      voucher_code: 'PC',
      voucher_date: '2026-03-22',
      status: 'APPROVED',
      posting_status: 'POSTED',
      is_advance: true,
      amount: 6,
    } as MyLedgerPayout;
    const s = { cash_voucher_id: 'settled', through_month: '2026-01-01' } as ProfitSettlementRow;
    const v = overviewVouchers(
      [
        { ...p, voucher_id: 'settled' },
        { ...p, voucher_id: 'advance' },
        { ...p, voucher_id: 'pending', is_advance: false, posting_status: 'UNPOSTED' },
      ],
      [],
      [s],
    );
    expect(v.profit.map((r) => [r.period, r.counted])).toEqual([
      ['2026-01-01', true],
      ['2026-03-01', false],
    ]);
    expect(v.advances.map((r) => r.period)).toEqual(['2026-02-01']);
    expect(flowTotal(v.profit)).toBe(6);
  });
  it('hiện nguồn dư từ cả chi vượt và ứng, dừng khi chênh sổ', () => {
    const alloc = [row(10)],
      cash = [row(14)],
      adv = [row(6)];
    const ledger = { marker: null, salary: [] };
    const end = overviewBalances(ledger, position(-10), alloc, cash, adv).get('2026-02-01');
    expect(end).toBe(-10);
    expect(closingExplanation(end, '2026-02-01', null, undefined, adv, alloc, cash, [])).toBeNull();
    expect(closingExplanation(-4, '2026-02-01', null, undefined, [], alloc, cash, [])?.fromOther).toBe(4);
    expect(closingExplanation(-6, '2026-02-01', null, undefined, adv, alloc, [], ['2026-02-01'])).toBeNull();
    expect(overviewBalances(ledger, position(-9), alloc, cash, adv).size).toBe(0);
  });
  it('chuyển số dư qua mốc đúng một lần', () => {
    const marker = '2026-01-01';
    const p = { ...position(-2), components: { opening_advance: 5 } } as ShareholderPosition;
    const balances = overviewBalances(
      { marker: { settled_through_month: marker }, salary: [] },
      p,
      [row(3)],
      [],
      [row(12, marker)],
    );
    expect([...balances]).toEqual([
      [marker, -5],
      ['2026-02-01', -2],
    ]);
    expect(closingExplanation(-2, '2026-02-01', marker, 5, [row(12, marker)], [row(3)], [], [])?.fromAdvance).toBe(2);
  });
});
