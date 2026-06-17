import { Card, CardContent } from '@/components/ui/card';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { formatCurrency } from '@/lib/utils';
import type { InvoiceWithRelations } from '@/types/invoice';

/** Tab "Thanh toán" — gom payments từ các hoá đơn, hiển thị thẻ dọc. Mã phương
 *  thức giữ NGUYÊN TM/TK/TT (không dịch, không icon) theo quy ước dự án. */
export function ContractPaymentsTab({ invoices }: { invoices: InvoiceWithRelations[] }) {
  const payments = invoices
    .flatMap((inv) =>
      (inv.payments || []).map((p) => ({
        ...p,
        invoiceLabel: (inv as { title?: string | null }).title || inv.invoice_number || inv.id.slice(0, 8),
      })),
    )
    .sort((a, b) => new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime());

  if (!payments.length) {
    return <div className="text-center py-10 text-sm text-muted-foreground">Chưa có thanh toán nào</div>;
  }
  return (
    <div className="space-y-2.5">
      {payments.map((p) => (
        <Card key={p.id}>
          <CardContent className="p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-green-600 text-sm">{formatCurrency(p.amount)}</span>
              <span className="text-xs font-semibold rounded bg-muted px-1.5 py-0.5">{p.payment_method}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">{p.invoiceLabel}</span>
              <span className="shrink-0">{format(new Date(p.payment_date), 'dd/MM/yyyy HH:mm', { locale: vi })}</span>
            </div>
            {p.notes && <div className="mt-1 text-xs text-muted-foreground">{p.notes}</div>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
