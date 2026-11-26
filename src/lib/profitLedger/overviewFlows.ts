import { formatISODateVN } from '@/lib/vnDate';
import { formatCurrency } from '@/lib/utils';
import type { MyLedgerPayout, MyProfitLedger, HistoricalAdvance } from './ledgerReaders';
import type { ShareholderPosition, ProfitSettlementRow } from './positionReaders';
import { adjacentPeriod, payoutStatusLabel, periodLabel } from './selfView';

export type OverviewFlow = {
  key: string;
  period: string;
  date?: string | null;
  title: string;
  note: string;
  amount: number;
  counted: boolean;
};
export const inOverviewPeriod = (period: string, year: number, month: number | null) =>
  Number(period.slice(0, 4)) === year && (month === null || Number(period.slice(5, 7)) === month);
export const flowTotal = (rows: OverviewFlow[]) =>
  rows.reduce((sum, row) => sum + (row.counted ? row.amount : 0), 0);

export function overviewVouchers(
  payouts: readonly (MyLedgerPayout & { settlementMonth?: string })[],
  history: readonly HistoricalAdvance[],
  settlements: readonly ProfitSettlementRow[],
) {
  const profit: OverviewFlow[] = [];
  const advances: OverviewFlow[] = [];
  const byVoucher = new Map(settlements.filter((s) => s.cash_voucher_id).map((s) => [s.cash_voucher_id, s]));
  for (const v of payouts) {
    const settlement = byVoucher.get(v.voucher_id);
    const settledMonth = settlement?.through_month ?? v.settlementMonth;
    const advance = v.is_advance && !settledMonth;
    const period =
      settledMonth ??
      (v.voucher_date && (advance ? adjacentPeriod(v.voucher_date, -1) : v.voucher_date.slice(0, 7) + '-01'));
    (advance ? advances : profit).push({
      key: v.voucher_id,
      period: period ?? '',
      date: v.voucher_date,
      title: v.voucher_code ?? 'Phiếu chưa có mã',
      note: [period && 'Kỳ ' + periodLabel(period), payoutStatusLabel(v), v.excluded_by_marker && 'trước mốc đối chiếu'].filter(Boolean).join(' · '),
      amount: v.amount,
      counted: v.status === 'APPROVED' && (advance || v.posting_status === 'POSTED'),
    });
    byVoucher.delete(v.voucher_id);
  }
  for (const s of byVoucher.values()) {
    profit.push({
      key: s.cash_voucher_id!,
      period: s.through_month,
      date: null,
      title: s.cash_voucher_code ?? 'Phiếu chốt lợi nhuận',
      note: 'Chốt hết ' + periodLabel(s.through_month),
      amount: s.cash_amount,
      counted: s.cash_voucher_status === 'APPROVED' && s.cash_voucher_posting_status === 'POSTED',
    });
  }
  for (const r of history)
    advances.push({
      key: r.id,
      period: r.period_month,
      title: r.code,
      note: ['Kỳ ' + periodLabel(r.period_month), 'Tháng chi ' + periodLabel(adjacentPeriod(r.period_month, 1)),
        r.evidence, ...(r.sources ?? []).map(s => s.code + ' ngày ' + formatISODateVN(s.date) + ' · ' + formatCurrency(s.amount)
          + (s.live ? '' : ' · bút toán nguồn đã thay đổi'))].join(' · '),
      amount: r.amount,
      counted: true,
    });
  return { profit, advances };
}

export function overviewProfit(ledger: Pick<MyProfitLedger, 'months' | 'historical_advances'>) {
  const rows: OverviewFlow[] = ledger.months.map((m) => ({
    key: m.period_month,
    period: m.period_month,
    title: periodLabel(m.period_month),
    note: 'Phân bổ đã chốt',
    amount: m.amount,
    counted: true,
  }));
  const observed = new Set(rows.map((r) => r.period));
  for (const r of ledger.historical_advances ?? []) {
    if (!observed.has(r.period_month) && r.external_profit != null) {
      rows.push({
        key: r.period_month,
        period: r.period_month,
        title: periodLabel(r.period_month),
        note: 'Theo chứng từ đối chiếu',
        amount: r.external_profit,
        counted: true,
      });
      observed.add(r.period_month);
    }
  }
  return rows.sort((a, b) => b.period.localeCompare(a.period));
}

/** Chỉ tái hiện số dư từng kỳ khi tổng dòng giải thích đúng mốc hoặc vị thế đã xác minh. */
export function overviewBalances(
  ledger: {
    marker: { settled_through_month: string | null } | null;
    salary: MyProfitLedger['salary'];
    historical_advances?: HistoricalAdvance[];
  },
  position: ShareholderPosition | null,
  allocations: OverviewFlow[],
  cash: OverviewFlow[],
  advances: OverviewFlow[],
) {
  const result = new Map<string, number>();
  if (!position) return result;
  const marker = ledger.marker?.settled_through_month ?? position.marker_month;
  const opening = position.components?.opening_advance;
  const movements = new Map<string, number>();
  for (const rows of [allocations, cash, advances]) {
    for (const row of rows) {
      if (!row.counted) continue;
      if (!row.period) return result;
      movements.set(
        row.period,
        (movements.get(row.period) ?? 0) + (rows === allocations ? row.amount : -row.amount),
      );
    }
  }
  for (const s of ledger.salary)
    movements.set(s.period_month, (movements.get(s.period_month) ?? 0) - s.investment + s.advance_offset);
  const keys = [...movements.keys()].sort();
  function reconcile(periods: string[], start: number, end: number) {
    let running = start;
    const candidates = periods.map((k) => {
      running += movements.get(k) ?? 0;
      return [k, running] as const;
    });
    if (Math.abs(running - end) < 0.005) for (const [k, n] of candidates) result.set(k, n);
  }
  if (marker && opening != null) {
    const history = keys.filter((k) => k <= marker);
    const allocatedMonths = new Set(allocations.map((r) => r.period));
    const complete = history.at(-1) === marker && history.every((k, i) =>
      allocatedMonths.has(k) && (i === 0 || adjacentPeriod(history[i - 1]!, 1) === k)
    );
    if (ledger.historical_advances?.length && complete) reconcile(history, 0, -opening);
    result.set(marker, -opening);
  }
  if (
    (!marker || opening != null) &&
    !position.components?.shared_fund_payable &&
    !position.components?.shared_fund_offset &&
    !position.settlement_cash_pending &&
    !position.advance_pending &&
    !position.components?.payouts_pending
  ) {
    reconcile(
      keys.filter((k) => !marker || k > marker),
      marker ? -(opening ?? 0) : 0,
      position.balance,
    );
  }
  return result;
}

/** Phân tích phần thiếu ở kỳ đã khớp sổ, dùng chứng từ đến chính kỳ đó. */
export function closingExplanation(
  net: number | undefined,
  period: string | undefined,
  marker: string | null | undefined,
  opening: number | undefined,
  advances: OverviewFlow[],
  allocations: OverviewFlow[],
  cash: OverviewFlow[],
  otherMovements: readonly string[],
) {
  if (net == null || net >= 0 || !period) return null;
  const afterMarker = !!marker && period > marker;
  const inRange = (k: string) => k <= period && (!afterMarker || k > marker!);
  const relevant = (r: OverviewFlow) => r.counted && inRange(r.period);
  const hasAdvance = ((afterMarker || period === marker) && (opening ?? 0) > 0) || advances.some(relevant);
  const negativeProfit = allocations.some(r => relevant(r) && r.amount < 0);
  const hasOther = cash.some(relevant) || negativeProfit;
  // Khi đã cấn hoặc nhiều nguyên nhân cùng tác động, từng phần cần sổ chi tiết để tách.
  if (otherMovements.some(inRange) || (hasAdvance && hasOther) || (!hasAdvance && !hasOther)) return null;
  return { fromAdvance: hasAdvance ? -net : 0, fromOther: hasOther ? -net : 0, negativeProfit };
}
