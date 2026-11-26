import type { HistoricalAdvance } from '@/lib/profitLedger/ledgerReaders';
import { adjacentPeriod, periodLabel } from '@/lib/profitLedger/selfView';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';

function ReceiptDetails({ receipt }: { receipt: HistoricalAdvance }) {
  return <details className="mt-1 max-w-lg text-xs">
    <summary className="cursor-pointer">Chứng từ của kỳ {periodLabel(receipt.period_month)}</summary>
    <p className="my-2 whitespace-normal">{receipt.evidence}</p>
    {receipt.sources?.map(s => <p key={s.code} className="whitespace-normal">
      {formatISODateVN(s.date)} · {s.code} · {formatCurrency(s.amount)}{s.live ? '' : ' · Bút toán đã thay đổi'}
    </p>)}
  </details>;
}

export function HistoricalAdvanceList({ receipts = [], table = false }: { receipts?: HistoricalAdvance[]; table?: boolean }) {
  return <>{[...receipts].sort((a,b) => b.period_month.localeCompare(a.period_month)).map(receipt => {
    const paymentMonth = periodLabel(adjacentPeriod(receipt.period_month, 1));
    if (table) return <tr key={receipt.id}>
      <td>Tháng {paymentMonth}</td>
      <td><span>{receipt.code}</span><span className="ph-inline ph-inline--first">Tạm ứng</span>
        <ReceiptDetails receipt={receipt} /></td>
      <td>Đã đối chiếu</td>
      <td className="num neg strong">{formatCurrency(receipt.amount)}</td><td />
    </tr>;
    return <div key={receipt.id} className="flex items-start justify-between gap-2 border-b px-4 py-3 text-sm">
      <div className="min-w-0"><strong>{receipt.code} · Tạm ứng</strong>
        <div className="text-xs text-muted-foreground">Tháng chi {paymentMonth} · Đã đối chiếu</div>
        <ReceiptDetails receipt={receipt} /></div>
      <span className="whitespace-nowrap font-semibold tabular-nums">{formatCurrency(receipt.amount)}</span>
    </div>;
  })}</>;
}
