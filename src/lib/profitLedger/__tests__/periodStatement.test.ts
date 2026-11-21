import { describe, expect, it } from 'vitest';
import type { MyProfitLedger, MyLedgerPayout } from '../ledgerReaders';
import type { MyShareholderPosition, ProfitSettlementRow } from '../positionReaders';
import { adjacentPeriod, periodStatement, postedCash } from '../periodStatement';

const payout = (id: string, amount: number, month: string, status = 'APPROVED', posting = 'POSTED'): MyLedgerPayout => ({
  voucher_id: id, voucher_code: id, voucher_date: month, amount, status, posting_status: posting,
  excluded_by_marker: false, is_advance: true, is_mine: false, is_mine_pending: false,
});
const settlement = (changes: Partial<ProfitSettlementRow> = {}): ProfitSettlementRow => ({
  id: 's', through_month: '2025-12-01', recognized_amount: 140, advance_offset_amount: 100, cash_amount: 40,
  cash_voucher_id: 'cash', cash_voucher_code: 'cash', cash_voucher_status: 'APPROVED',
  cash_voucher_posting_status: 'UNPOSTED', excluded_by_marker: false, created_at: '2026-01-20T00:00:00Z', ...changes,
});
const base = {
  months: ['2025-11-01', '2025-12-01'].map(period_month => ({ period_month, amount: 70, excluded_by_marker: false, buildings: [] })),
  payouts: [payout('advance', 130, '2025-12-07'), payout('pending', 90, '2026-01-02', 'UNAPPROVED', 'UNPOSTED'),
    payout('cash', 40, '2026-01-20', 'APPROVED', 'UNPOSTED')], salary: [],
};
const run = (s: ProfitSettlementRow[], extra: Partial<MyShareholderPosition> = {}) => periodStatement(
  base as MyProfitLedger, { settlements: s, advance_outstanding: 30, ...extra } as MyShareholderPosition,
);
describe('đối chiếu kỳ lợi nhuận và đợt ứng tháng kế tiếp', () => {
  it('qua năm, tách ứng chờ và phiếu tiền của lần chốt', () => {
    expect(adjacentPeriod('2026-01-20', -1)).toBe('2025-12-01');
    const { periods } = run([settlement()]);
    expect(periods.get('2025-11-01')).toMatchObject({ approved: 130, offset: 0, balance: 130, status: 'Chốt gộp đến 12/2025' });
    expect(periods.get('2025-12-01')).toMatchObject({ approved: 0, pending: 90, offset: 100, balance: 30, cash: 0, status: 'Chờ ghi chi' });
    expect(postedCash(base.payouts)).toBe(130);
  });
  it('ghi tiền đúng một lần ở kỳ chốt cuối, chỉ sau khi ghi sổ', () => {
    expect(run([settlement({ cash_voucher_posting_status: 'POSTED' })]).periods.get('2025-12-01'))
      .toMatchObject({ cash: 40, status: 'Lần chốt đã chi', pending: 90 });
  });
  it('không suy ngược dư ứng khi còn số đầu kỳ ngoài các sự kiện theo tháng', () => {
    expect(run([settlement()], { advance_outstanding: 1000 }).periods.get('2025-12-01')?.balance).toBeNull();
  });
});
