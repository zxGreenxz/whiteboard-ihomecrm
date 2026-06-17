import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { formatCurrency } from '@/lib/utils';
import type { InvoiceWithRelations } from '@/types/invoice';

const INV_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Nháp', cls: 'bg-gray-100 text-gray-700' },
  APPROVED: { label: 'Đã duyệt', cls: 'bg-blue-100 text-blue-700' },
  PARTIAL_PAID: { label: 'Trả 1 phần', cls: 'bg-amber-100 text-amber-700' },
  PAID: { label: 'Đã thanh toán', cls: 'bg-green-100 text-green-700' },
  OVERDUE: { label: 'Quá hạn', cls: 'bg-red-100 text-red-700' },
  CANCELLED: { label: 'Đã hủy', cls: 'bg-zinc-200 text-zinc-600' },
};

/** Tab "Hoá đơn" — danh sách thẻ dọc, chạm mở chi tiết hoá đơn. */
export function ContractInvoicesTab({ invoices }: { invoices: InvoiceWithRelations[] }) {
  const navigate = useNavigate();
  if (!invoices.length) {
    return <div className="text-center py-10 text-sm text-muted-foreground">Chưa có hóa đơn nào</div>;
  }
  return (
    <div className="space-y-2.5">
      {invoices.map((inv) => {
        const remaining = (inv.total_amount || 0) - (inv.paid_amount || 0);
        const st = INV_STATUS[inv.status] ?? { label: inv.status, cls: 'bg-gray-100 text-gray-700' };
        return (
          <Card
            key={inv.id}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/invoices/${inv.id}`)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/invoices/${inv.id}`); }}
            className="cursor-pointer active:scale-[0.99] transition-transform"
          >
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm truncate">
                  {(inv as { title?: string | null }).title || inv.invoice_number || inv.id.slice(0, 8)}
                </span>
                <Badge variant="outline" className={`shrink-0 ${st.cls}`}>{st.label}</Badge>
              </div>
              <div className="mt-1.5 flex items-center justify-between text-sm">
                <span className="font-semibold">{formatCurrency(inv.total_amount || 0)}</span>
                <span className="text-xs text-muted-foreground">
                  {inv.due_date ? `Hạn ${format(new Date(inv.due_date), 'dd/MM/yyyy', { locale: vi })}` : ''}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-xs">
                <span className="text-green-600">Đã thu {formatCurrency(inv.paid_amount || 0)}</span>
                {remaining > 0 && <span className="text-orange-600">Còn {formatCurrency(remaining)}</span>}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
