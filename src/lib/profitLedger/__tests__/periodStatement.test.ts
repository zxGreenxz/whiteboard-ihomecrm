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
  it('phiếu chi lợi nhuận riêng thuộc tháng chi và chỉ vào cột chi một lần, kể cả trước mốc', () => {
    const cash = { ...payout('profit', 23, '2025-12-05'), is_advance:false, excluded_by_marker:true };
    const record = periodStatement({...base,payouts:[cash]} as MyProfitLedger, {settlements:[],components:{opening_advance:0}} as MyShareholderPosition);
    expect(record.periods.get('2025-12-01')).toMatchObject({approved:0,cash:23});
    expect(record.periods.get('2025-11-01')).toMatchObject({approved:0,cash:0});
  });
  it('không suy ngược dư ứng khi còn số đầu kỳ ngoài các sự kiện theo tháng', () => {
    expect(run([settlement()], { advance_outstanding: 1000 }).periods.get('2025-12-01')?.balance).toBeNull();
  });
  it('hiện bảy phiếu lịch sử và ba phiếu trước mốc đúng mười kỳ nhưng không cộng lại vào dư hiện tại', () => {
    const month = (n: number) => `2025-${String(n).padStart(2,'0')}-01`;
    const history = Array.from({length:7},(_,i)=>({id:'h'+i,code:'LS'+i,period_month:month(i+1),amount:i+1,
      evidence:'Đối chiếu kỳ',external_profit:i<4 ? 1 : null}));
    const ledger = { marker:{settled_through_month:month(10)}, salary:[], historical_advances:history,
      months:Array.from({length:6},(_,i)=>({period_month:month(i+5),amount:1,excluded_by_marker:true,buildings:[]})),
      payouts:[8,9,10].map(n=>({...payout(String(n),n,month(n+1)),excluded_by_marker:true})) } as MyProfitLedger;
    const result = periodStatement(ledger,{settlements:[],advance_outstanding:45,components:{opening_advance:45}} as MyShareholderPosition);
    expect(Array.from({length:10},(_,i)=>result.periods.get(month(i+1))?.approved)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(result.periods.get(month(1))).toMatchObject({allocation:1,excluded:true,balance:0,netClosing:0});
    expect(result.periods.get(month(9))).toMatchObject({approved:9,netClosing:-36,balance:36});
    expect(result.periods.get(month(10))).toMatchObject({approved:10,netClosing:-45,balance:45});
    expect(result.periods.get(month(8))?.vouchers).toHaveLength(1);
    expect(postedCash(ledger.payouts)).toBe(0);
  });
});
