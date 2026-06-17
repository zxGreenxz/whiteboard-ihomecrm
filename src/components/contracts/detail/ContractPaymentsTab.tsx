import { Wallet, Coins } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { InvoiceWithRelations } from '@/types/invoice';

const fmtNum = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));

/** Tab "Thanh toán" — gom payments từ các hoá đơn (không truy vấn lại); danh
 *  sách .cd-pay. Mã phương thức giữ NGUYÊN TM/TK/TT theo quy ước dự án. */
export function ContractPaymentsTab({ invoices }: { invoices: InvoiceWithRelations[] }) {
  const payments = invoices
    .flatMap((inv) =>
      (inv.payments || []).map((p) => ({
        ...p,
        invLabel: (inv as { title?: string | null }).title || inv.invoice_number || inv.id.slice(0, 8),
      })),
    )
    .sort((a, b) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime());

  if (!payments.length) return <div className="stub">Chưa có thanh toán nào.</div>;
  return (
    <div className="cd-card" style={{ marginBottom: 4 }}>
      <div className="cd-card-h"><span className="cd-card-t"><Wallet size={16} />Lịch sử thanh toán</span><span className="cd-count">{payments.length}</span></div>
      <div className="cd-pay-list">
        {payments.map((p) => (
          <div className="cd-pay" key={p.id}>
            <span className="cd-pay-ic"><Coins size={16} /></span>
            <div className="cd-pay-body">
              <div className="cd-pay-note">{p.invLabel}</div>
              <div className="cd-pay-sub">
                {p.receipt_number ? `${p.receipt_number} · ` : ''}{p.payment_method} · {format(new Date(p.payment_date), 'dd/MM/yyyy', { locale: vi })}
              </div>
            </div>
            <span className="cd-pay-amt">+{fmtNum(p.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
