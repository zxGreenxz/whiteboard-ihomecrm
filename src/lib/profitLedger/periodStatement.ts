import type { HistoricalAdvance, MyLedgerPayout, MyProfitLedger } from './ledgerReaders';
import type { MyShareholderPosition, ProfitSettlementRow } from './positionReaders';
import { adjacentPeriod, periodLabel } from './selfView';
import { overviewBalances, overviewProfit, overviewVouchers } from './overviewFlows';
export { adjacentPeriod } from './selfView';

export function postedCash(payouts: readonly MyLedgerPayout[]) {
  return payouts.filter(p => !p.excluded_by_marker && p.status === 'APPROVED' && p.posting_status === 'POSTED')
    .reduce((total, p) => total + p.amount, 0);
}

function emptyPeriod(period: string) {
  return {
    period, allocation: null as number | null, approved: 0, pending: 0, offset: 0, cash: 0,
    balance: null as number | null, netClosing: null as number | null, vouchers: [] as MyLedgerPayout[], settlements: [] as ProfitSettlementRow[],
    excluded: false, status: 'Chưa có phân bổ', salary: 0, salaryOffset: 0, awaitingCash: 0,
    historical: null as HistoricalAdvance | null, approvedBeforeMarker: 0,
  };
}

export function periodStatement(ledger: MyProfitLedger, position: MyShareholderPosition) {
  const periods = new Map<string, ReturnType<typeof emptyPeriod>>();
  const at = (period: string) => {
    const row = periods.get(period) ?? emptyPeriod(period);
    periods.set(period, row);
    return row;
  };
  const activeSettlements = position.settlements.filter(s => !s.excluded_by_marker);
  const settlementVouchers = new Set(position.settlements.map(s => s.cash_voucher_id));
  for (const month of ledger.months) {
    const row = at(month.period_month);
    row.allocation = (row.allocation ?? 0) + month.amount;
    row.excluded ||= month.excluded_by_marker;
  }
  let canReconcile = !position.components?.opening_advance && !position.components?.shared_fund_offset;
  for (const p of ledger.payouts) {
    if (settlementVouchers.has(p.voucher_id)) continue;
    if (!p.voucher_date) { canReconcile = false; continue; }
    if (!p.is_advance) {
      const row = at(p.voucher_date.slice(0, 7) + '-01');
      row.vouchers.push(p);
      row.excluded ||= p.excluded_by_marker;
      if (p.status === 'APPROVED' && p.posting_status === 'POSTED') row.cash += p.amount;
      else if (p.status === 'UNAPPROVED' || p.status === 'APPROVED') row.awaitingCash += p.amount;
      continue;
    }
    const row = at(adjacentPeriod(p.voucher_date, -1));
    row.vouchers.push(p);
    if (p.excluded_by_marker) {
      row.excluded = true;
      if (p.status === 'APPROVED') {
        row.approved += p.amount;
        row.approvedBeforeMarker += p.amount;
      }
      continue;
    }
    if (p.status === 'APPROVED') row.approved += p.amount;
    else if (p.status === 'UNAPPROVED') row.pending += p.amount;
    else canReconcile = false;
  }
  for (const receipt of ledger.historical_advances ?? []) {
    const row = at(receipt.period_month);
    row.historical = receipt;
    row.excluded = true;
    row.allocation ??= receipt.external_profit;
    row.approved += receipt.amount;
    row.approvedBeforeMarker += receipt.amount;
  }
  for (const salary of ledger.salary) {
    const row = at(salary.period_month);
    row.excluded ||= salary.excluded_by_marker;
    row.salaryOffset += salary.advance_offset;
    row.salary += salary.investment;
    row.offset += salary.advance_offset;
  }
  for (const s of position.settlements) {
    const row = at(s.through_month);
    row.settlements.push(s);
    row.excluded ||= s.excluded_by_marker;
    row.offset += s.advance_offset_amount;
    if (s.cash_voucher_status === 'APPROVED' && s.cash_voucher_posting_status === 'POSTED') row.cash += s.cash_amount;
    else row.awaitingCash += s.cash_amount;
  }
  const flows = overviewVouchers(ledger.payouts, ledger.historical_advances ?? [], position.settlements);
  const net = overviewBalances(ledger, position, overviewProfit(ledger), flows.profit, flows.advances);
  for (const [period, amount] of net) at(period).netClosing = amount;
  const keys = [...periods.keys()].sort();
  if (keys.length > 1) {
    for (let key = keys[0]; key < keys[keys.length - 1]; key = adjacentPeriod(key, 1)) at(key);
  }
  const sorted = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period));
  const closing = sorted.reduce((sum, row) => sum + row.approved - row.approvedBeforeMarker - (row.excluded ? 0 : row.offset), 0);
  canReconcile &&= Math.abs(Math.max(0, closing) - position.advance_outstanding) < 0.005;
  let balance = 0;
  const cutoffs = [...new Set(activeSettlements.map(s => s.through_month))].sort();
  for (const row of sorted) {
    balance += row.approved - row.approvedBeforeMarker - (row.excluded ? 0 : row.offset);
    if (canReconcile && !row.excluded) row.balance = Math.max(0, balance);
    if (row.excluded && row.netClosing !== null && ledger.historical_advances?.length
        && !flows.profit.some(p => p.counted && p.period <= row.period)
        && !ledger.salary.some(s => s.period_month <= row.period && (s.investment || s.advance_offset))
        && ![...periods.values()].some(p => p.period <= row.period && p.allocation !== null && p.allocation < 0)) {
      row.balance = Math.max(0, -row.netClosing);
    }
    const cutoff = cutoffs.find(end => end >= row.period);
    if (row.settlements.length) {
      const cash = row.settlements.reduce((sum, s) => sum + s.cash_amount, 0);
      row.status = cash === 0 ? 'Lần chốt đã cấn hết' : row.cash >= cash ? 'Lần chốt đã chi' :
        row.settlements.some(s => s.cash_voucher_status === 'UNAPPROVED') ? 'Chờ duyệt chi' : 'Chờ ghi chi';
    } else if (row.excluded) row.status = row.historical || row.vouchers.some(p => p.is_advance) ? 'Đã đối chiếu ứng tháng' : 'Đã đối chiếu theo mốc';
    else if (cutoff && row.allocation !== null) row.status = 'Chốt gộp đến ' + periodLabel(cutoff);
    else if (row.allocation !== null) row.status = 'Chưa chốt chi';
  }
  return { periods, canReconcile };
}
