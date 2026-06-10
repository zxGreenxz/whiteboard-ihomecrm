import { fmtFull, remainingOf } from '@/lib/collect';
import type { CollectorEntry } from '@/hooks/useInvoiceCollectors';
import type { InvoiceWithRelations } from '@/types/invoice';

const fmtDate = (d?: string | null) =>
  d ? d.slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '';

interface Props {
  invoice: InvoiceWithRelations;
  /** Lịch sử ai thu bao nhiêu (phiếu thu theo payment) — [] nếu chưa thu/không có dữ liệu. */
  collectors?: CollectorEntry[];
}

/** Thẻ số tiền (.is-amount) + chi tiết invoice_items (.is-break) + ai thu bao nhiêu. */
export function InvoiceDetailCard({ invoice, collectors = [] }: Props) {
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

      {collectors.length > 0 && (
        <div className="is-break">
          <div className="ib-lbl">Ai thu bao nhiêu</div>
          <div className="ib-list">
            {collectors.map((c, i) => (
              <div className="ib-item" key={c.payment_id ?? i}>
                <span className="ib-name">
                  {(c.creator_name ?? '').trim() || '—'}
                  <span className="ib-when"> · {fmtDate(c.date)}</span>
                </span>
                <span className="ib-val paid">{fmtFull(c.amount)}</span>
              </div>
            ))}
            {collectors.length > 1 && (
              <div className="ib-item total">
                <span className="ib-name">Tổng đã thu</span>
                <span className="ib-val">
                  {fmtFull(collectors.reduce((s, c) => s + c.amount, 0))}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

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
