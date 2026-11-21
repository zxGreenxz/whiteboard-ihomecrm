import type { MyLedgerPayout, MyProfitLedger } from './ledgerReaders';
import type { MyShareholderPosition, ProfitSettlementRow } from './positionReaders';
import { periodLabel } from './selfView';

/** The payment run in January belongs to the previous December. */
export function adjacentPeriod(date: string, delta: number): string {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + delta;
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}-01`;
}

export function postedCash(payouts: readonly MyLedgerPayout[]) {
  return payouts.filter(p => !p.excluded_by_marker && p.status === 'APPROVED' && p.posting_status === 'POSTED')
    .reduce((total, p) => total + p.amount, 0);
}

function emptyPeriod(period: string) {
  return {
    period, allocation: null as number | null, approved: 0, pending: 0, offset: 0, cash: 0,
    balance: null as number | null, vouchers: [] as MyLedgerPayout[], settlements: [] as ProfitSettlementRow[],
    excluded: false, status: 'Chưa có phân bổ', salary: 0, awaitingCash: 0,
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
  // The position API treats all live payouts outside settlements as advances, including legacy vouchers.
  let canReconcile = !position.components?.opening_advance && !position.components?.shared_fund_offset;
  for (const p of ledger.payouts) {
    if (p.excluded_by_marker || settlementVouchers.has(p.voucher_id)) continue;
    if (!p.voucher_date) { canReconcile = false; continue; }
    const row = at(adjacentPeriod(p.voucher_date, -1));
    row.vouchers.push(p);
    if (p.status === 'APPROVED') row.approved += p.amount;
    else if (p.status === 'UNAPPROVED') row.pending += p.amount;
    else canReconcile = false;
  }
  for (const salary of ledger.salary) {
    if (salary.excluded_by_marker) continue;
    const row = at(salary.period_month);
    row.salary += salary.investment;
    row.offset += salary.advance_offset;
  }
  for (const s of activeSettlements) {
    const row = at(s.through_month);
    row.settlements.push(s);
    row.offset += s.advance_offset_amount;
    if (s.cash_voucher_status === 'APPROVED' && s.cash_voucher_posting_status === 'POSTED') row.cash += s.cash_amount;
    else row.awaitingCash += s.cash_amount;
  }
  const keys = [...periods.keys()].sort();
  if (keys.length > 1) {
    for (let key = keys[0]; key < keys[keys.length - 1]; key = adjacentPeriod(key, 1)) at(key);
  }
  const sorted = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period));
  const closing = sorted.reduce((sum, row) => sum + row.approved - row.offset, 0);
  canReconcile &&= Math.abs(Math.max(0, closing) - position.advance_outstanding) < 0.005;
  let balance = 0;
  const cutoffs = [...new Set(activeSettlements.map(s => s.through_month))].sort();
  for (const row of sorted) {
    balance += row.approved - row.offset;
    if (canReconcile && !row.excluded) row.balance = Math.max(0, balance);
    const cutoff = cutoffs.find(end => end >= row.period);
    if (row.settlements.length) {
      const cash = row.settlements.reduce((sum, s) => sum + s.cash_amount, 0);
      row.status = cash === 0 ? 'Lần chốt đã cấn hết' : row.cash >= cash ? 'Lần chốt đã chi' :
        row.settlements.some(s => s.cash_voucher_status === 'UNAPPROVED') ? 'Chờ duyệt chi' : 'Chờ ghi chi';
    } else if (row.excluded) row.status = 'Đã trả đủ theo mốc';
    else if (cutoff && row.allocation !== null) row.status = 'Chốt gộp đến ' + periodLabel(cutoff);
    else if (row.allocation !== null) row.status = 'Chưa chốt chi';
  }
  return { periods, canReconcile };
}
