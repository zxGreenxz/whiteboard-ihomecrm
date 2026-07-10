import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import { formatCurrency } from './formatCurrency';

interface ContractPaymentsTabDesktopProps {
  invoices: InvoiceWithRelations[] | undefined;
  loading: boolean;
}

/** Tab "Thanh toán" (desktop) — tách nguyên văn từ ContractDetailView (Phase 10D).
 *  (Tên có hậu tố Desktop vì ContractPaymentsTab.tsx là bản mobile.) */
export function ContractPaymentsTabDesktop({ invoices, loading }: ContractPaymentsTabDesktopProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lịch sử thanh toán</CardTitle>
        <CardDescription>
          Các khoản thanh toán đã ghi nhận
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-gray-500">
            Đang tải...
          </div>
        ) : (
          <>
            {/* Collect all payments from all invoices */}
            {(() => {
              const allPayments = invoices?.flatMap(inv =>
                (inv.payments || []).map(p => ({ ...p, invoice: inv }))
              ) || [];

              if (allPayments.length === 0) {
                return (
                  <div className="text-center py-8 text-gray-500">
                    Chưa có thanh toán nào
                  </div>
                );
              }

              // Sort by payment date descending
              allPayments.sort((a, b) =>
                new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()
              );

              return (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ngày thanh toán</TableHead>
                      <TableHead>Hóa đơn</TableHead>
                      <TableHead className="text-right">Số tiền</TableHead>
                      <TableHead>Phương thức</TableHead>
                      <TableHead>Ghi chú</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allPayments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell>
                          {format(new Date(payment.payment_date), 'dd/MM/yyyy HH:mm', { locale: vi })}
                        </TableCell>
                        <TableCell className="font-medium">
                          {payment.invoice.invoice_number}
                        </TableCell>
                        <TableCell className="text-right font-medium text-green-600">
                          {formatCurrency(payment.amount)}
                        </TableCell>
                        <TableCell className="capitalize">
                          {payment.payment_method?.toLowerCase().replace('_', ' ')}
                        </TableCell>
                        <TableCell className="text-gray-500 text-sm">
                          {payment.notes || '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              );
            })()}
          </>
        )}
      </CardContent>
    </Card>
  );
}
