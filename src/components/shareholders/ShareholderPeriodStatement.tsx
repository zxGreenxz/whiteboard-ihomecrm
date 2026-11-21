import { useMemo } from 'react';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';
import type { MyPositionView } from '@/hooks/profit-ledger/useMyPositionView';
import { adjacentPeriod, periodStatement } from '@/lib/profitLedger/periodStatement';
import { payoutStatusLabel, periodLabel } from '@/lib/profitLedger/selfView';
import { formatCurrency } from '@/lib/utils';
import { formatISODateVN } from '@/lib/vnDate';

export default function ShareholderPeriodStatement({ ledger, view, year, month, selection }: {
  ledger: MyProfitLedger; view: MyPositionView; year: number; month: number | null;
  selection?: { name: string; amounts: Map<string, number> };
}) {
  const data = useMemo(() => view.position ? periodStatement(ledger, view.position) : null, [ledger, view.position]);
  if (!data) return view.pending ? <p role="status">Đang tải bảng đối chiếu theo kỳ…</p> : null;
  const lastMonth = Math.max(0, ...[...data.periods.keys()].filter(k => k.startsWith(year + '-')).map(k => Number(k.slice(5, 7))));
  const months = month === null ? Array.from({ length: lastMonth }, (_, i) => i + 1) : [month];
  const money = (amount?: number | null) => amount == null ? '—' : formatCurrency(amount);
  const columns = ['Lợi nhuận phân bổ', 'Ứng đã duyệt', 'Ứng chờ duyệt', 'Cấn qua chốt chi và lương', 'Lợi nhuận thực chi', 'Chênh kỳ', 'Dư ứng chuyển kỳ'];
  return (
    <section className="rounded-xl border bg-card text-card-foreground" aria-label="Đối chiếu lợi nhuận và tạm ứng">
      <div className="border-b px-4 py-3">
        <h2 className="text-base font-semibold">Đối chiếu lợi nhuận và tạm ứng · {year}</h2>
        <p className="mt-1 text-xs text-muted-foreground">Kỳ lợi nhuận đi với đợt ứng tháng sau. Khoản cấn và thực chi của lần chốt gộp hiển thị một lần ở kỳ cuối. Chênh kỳ bằng lợi nhuận {selection ? `của nhóm ${selection.name}` : 'tất cả nhà'} trừ ứng đã duyệt trong đợt.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="block w-full text-sm md:table">
          <thead className="hidden bg-muted/40 text-xs text-muted-foreground md:table-header-group"><tr>
            <th scope="col" className="p-3 text-left">Kỳ LN / đợt ứng</th>
            {columns.map(c => <th scope="col" key={c} className="px-2 py-3 text-right">{c}</th>)}
            <th scope="col" className="p-3 text-left">Trạng thái kỳ</th>
          </tr></thead>
          <tbody className="block md:table-row-group">{months.length === 0 && <tr><td colSpan={9} className="p-4 text-muted-foreground">Chưa có dữ liệu CRM trong năm {year}.</td></tr>}{months.map(m => {
            const key = `${year}-${String(m).padStart(2, '0')}-01`;
            const r = data.periods.get(key);
            const allocated = selection ? selection.amounts.get(key) : r?.allocation;
            const difference = allocated != null && r ? allocated - r.approved : null;
            return <tr key={key} className="grid grid-cols-2 gap-x-4 gap-y-2 border-b p-3 last:border-0 md:table-row md:p-0">
              <th scope="row" className="col-span-2 px-1 text-left align-top md:p-3">
                <span className="whitespace-nowrap">T{m}/{year}</span>
                <span className="ml-2 whitespace-nowrap text-xs font-normal text-muted-foreground md:ml-0 md:block">Ứng {periodLabel(adjacentPeriod(key, 1))}</span>
              </th>
              {[allocated, r?.approved, r?.pending, r?.offset, r?.cash, difference, r?.balance].map((v, i) =>
                <td key={columns[i]} className={`${r ? '' : 'hidden md:table-cell'} px-1 align-top md:px-2 md:py-3 md:text-right`}>
                  <span className="block text-xs text-muted-foreground md:hidden">{columns[i]}</span>
                  <span className={`whitespace-nowrap tabular-nums ${v ? 'font-semibold' : 'text-muted-foreground'}`}>{money(v)}</span>
                  {i === 0 && selection && r?.allocation != null && <span className="block text-xs text-muted-foreground">Tất cả nhà · {money(r.allocation)}</span>}
                </td>)}
              <td className="col-span-2 px-1 align-top md:p-3">
                <span className={(r?.status.includes('đã ') || r?.excluded) ? 'font-semibold text-emerald-700' : 'text-muted-foreground'}>{r?.status ?? 'Chưa có dữ liệu CRM'}</span>
                {!!r?.awaitingCash && <span className="block text-xs text-amber-800">Còn phải chi {money(r.awaitingCash)}</span>}
                {r && (r.vouchers.length > 0 || r.settlements.length > 0 || r.salary !== 0) && <details className="mt-1 text-xs">
                  <summary className="cursor-pointer font-medium">Chi tiết kỳ</summary>
                  <ul className="mt-2 space-y-2">
                    {r.vouchers.map(v => <li key={v.voucher_id}>{formatISODateVN(v.voucher_date)} · {v.voucher_code ?? 'Phiếu ứng'} · {money(v.amount)} · {payoutStatusLabel(v)}</li>)}
                    {r.settlements.map(s => <li key={s.id}>Chốt đến {periodLabel(s.through_month)} · cấn {money(s.advance_offset_amount)} · tiền theo phiếu {money(s.cash_amount)} {s.cash_voucher_code}</li>)}
                    {r.salary !== 0 && <li>Qua lương {money(r.salary)}</li>}
                  </ul>
                </details>}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!data.canReconcile && <p className="border-t px-4 py-2 text-xs text-muted-foreground">Chưa đủ dữ liệu theo tháng để tách dư ứng chuyển kỳ. Dư ứng hiện tại hiển thị ở đầu trang.</p>}
    </section>
  );
}
