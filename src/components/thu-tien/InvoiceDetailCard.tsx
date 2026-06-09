import { fmtFull, remainingOf } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

/** Thẻ số tiền (Tổng / Đã thu / Còn phải thu) + chi tiết invoice_items. */
export function InvoiceDetailCard({ invoice }: { invoice: InvoiceWithRelations }) {
  const items = invoice.invoice_items ?? [];
  const remaining = remainingOf(invoice);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-zinc-200 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-zinc-500">Tổng hóa đơn</span>
          <span className="font-mono text-lg font-bold tabular-nums">
            {fmtFull(invoice.total_amount)}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-emerald-50 p-2">
            <div className="text-xs text-zinc-500">Đã thu</div>
            <div className="font-mono font-semibold tabular-nums text-emerald-700">
              {fmtFull(invoice.paid_amount)}
            </div>
          </div>
          <div className="rounded-lg bg-red-50 p-2">
            <div className="text-xs text-zinc-500">Còn phải thu</div>
            <div className="font-mono font-semibold tabular-nums text-red-600">
              {fmtFull(remaining)}
            </div>
          </div>
        </div>
      </div>

      {items.length > 0 && (
        <div className="rounded-xl border border-zinc-200 p-3">
          <div className="mb-1 text-xs font-medium uppercase text-zinc-400">Chi tiết hóa đơn</div>
          <div className="divide-y divide-zinc-100">
            {items.map((it) => (
              <div key={it.id} className="flex justify-between gap-2 py-1.5 text-sm">
                <span className="text-zinc-600">{it.description}</span>
                <span className="font-mono tabular-nums text-zinc-800">{fmtFull(it.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between py-1.5 text-sm font-semibold">
              <span>Tổng cộng</span>
              <span className="font-mono tabular-nums">{fmtFull(invoice.total_amount)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default InvoiceDetailCard;
