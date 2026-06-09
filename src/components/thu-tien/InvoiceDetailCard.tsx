import { fmtFull, remainingOf } from '@/lib/collect';
import type { InvoiceWithRelations } from '@/types/invoice';

/** Thẻ số tiền (.is-amount) + chi tiết invoice_items (.is-break). */
export function InvoiceDetailCard({ invoice }: { invoice: InvoiceWithRelations }) {
  const items = invoice.invoice_items ?? [];
  const remaining = remainingOf(invoice);

  return (
    <>
      <div className="is-amount">
        <div className="ia-row">
          <span className="ia-lbl">Tổng hóa đơn</span>
          <span className="ia-total">{fmtFull(invoice.total_amount)}</span>
        </div>
        <div className="ia-split">
          <div className="ia-cell paid">
            <div className="ic-l">Đã thu</div>
            <div className="ic-v">{fmtFull(invoice.paid_amount)}</div>
          </div>
          <div className="ia-cell due">
            <div className="ic-l">Còn phải thu</div>
            <div className="ic-v">{fmtFull(remaining)}</div>
          </div>
        </div>
      </div>

      {items.length > 0 && (
        <div className="is-break">
          <div className="ib-lbl">Chi tiết hóa đơn</div>
          <div className="ib-list">
            {items.map((it) => (
              <div className="ib-item" key={it.id}>
                <span className="ib-name">{it.description}</span>
                <span className="ib-val">{fmtFull(it.amount)}</span>
              </div>
            ))}
            <div className="ib-item total">
              <span className="ib-name">Tổng cộng</span>
              <span className="ib-val">{fmtFull(invoice.total_amount)}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default InvoiceDetailCard;
