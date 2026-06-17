import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { InvoiceWithRelations } from '@/types/invoice';

const fmtNum = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n || 0));
const INV: Record<string, { label: string; c: string; bg: string; line: string }> = {
  DRAFT: { label: 'Nháp', c: '#8d8678', bg: '#efece6', line: '#ddd8cd' },
  APPROVED: { label: 'Đã duyệt', c: '#2563eb', bg: '#e7eefc', line: '#c9dafa' },
  PARTIAL_PAID: { label: 'Trả 1 phần', c: '#c97a10', bg: '#fbf1da', line: '#f0dca8' },
  PAID: { label: 'Đã thanh toán', c: '#1f9d57', bg: '#e6f5ec', line: '#bfe6cd' },
  OVERDUE: { label: 'Quá hạn', c: '#d6453f', bg: '#fcebe9', line: '#f2c8c4' },
  CANCELLED: { label: 'Đã huỷ', c: '#8d8678', bg: '#efece6', line: '#ddd8cd' },
};

/** Tab "Hoá đơn" — thẻ dọc .cd-inv, chạm mở chi tiết hoá đơn. */
export function ContractInvoicesTab({ invoices }: { invoices: InvoiceWithRelations[] }) {
  const navigate = useNavigate();
  if (!invoices.length) return <div className="stub">Chưa có hoá đơn nào.</div>;
  return (
    <div className="rowlist" style={{ marginBottom: 4 }}>
      {invoices.map((inv) => {
        const st = INV[inv.status] ?? { label: inv.status, c: '#8d8678', bg: '#efece6', line: '#ddd8cd' };
        const ps = (inv as { billing_period_start?: string | null }).billing_period_start;
        const pe = (inv as { billing_period_end?: string | null }).billing_period_end;
        const period = ps && pe
          ? `${format(new Date(ps), 'dd/MM', { locale: vi })} - ${format(new Date(pe), 'dd/MM/yyyy', { locale: vi })}`
          : inv.billing_month ? `Kỳ ${inv.billing_month}` : '';
        const date = inv.due_date ? format(new Date(inv.due_date), 'dd/MM/yyyy', { locale: vi }) : '';
        return (
          <div className="cd-inv" key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)}>
            <div className="cd-inv-l1">
              <span className="lrow-code">{(inv as { title?: string | null }).title || inv.invoice_number || inv.id.slice(0, 8)}</span>
              <span className="pill" style={{ color: st.c, background: st.bg, borderColor: st.line }}><span className="bd" style={{ background: st.c }} />{st.label}</span>
            </div>
            <div className="cd-inv-period">{period}{period && date ? ' · ' : ''}{date}</div>
            <div className="cd-inv-foot">
              <span className="cd-inv-amt">{fmtNum(inv.total_amount || 0)} ₫</span>
              <span className="cd-inv-paid">Đã trả {fmtNum(inv.paid_amount || 0)} ₫</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
