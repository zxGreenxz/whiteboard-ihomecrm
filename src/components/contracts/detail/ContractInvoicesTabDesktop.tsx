import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Receipt, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import { formatCurrency } from './formatCurrency';

const getInvoiceStatusBadge = (status: string) => {
  const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
    DRAFT: { variant: 'outline', label: 'Nháp' },
    APPROVED: { variant: 'default', label: 'Đã duyệt' },
    PARTIAL_PAID: { variant: 'secondary', label: 'Trả 1 phần' },
    PAID: { variant: 'default', label: 'Đã thanh toán' },
    OVERDUE: { variant: 'destructive', label: 'Quá hạn' },
    CANCELLED: { variant: 'destructive', label: 'Đã hủy' },
  };
  const config = variants[status] || { variant: 'outline' as const, label: status };
  return <Badge variant={config.variant}>{config.label}</Badge>;
};

interface ContractInvoicesTabDesktopProps {
  invoices: InvoiceWithRelations[] | undefined;
  loading: boolean;
}

/** Tab "Hóa đơn" (desktop) — tách nguyên văn từ ContractDetailView (Phase 10D).
 *  (Tên có hậu tố Desktop vì ContractInvoicesTab.tsx là bản mobile.) */
export function ContractInvoicesTabDesktop({ invoices, loading }: ContractInvoicesTabDesktopProps) {
  const navigate = useNavigate();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Hóa đơn</CardTitle>
            <CardDescription>
              Danh sách hóa đơn của hợp đồng ({invoices?.length || 0} hóa đơn)
            </CardDescription>
          </div>
          <Button variant="outline" onClick={() => navigate('/invoices')}>
            <Receipt className="h-4 w-4 mr-2" />
            Tạo hóa đơn
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-gray-500">
            Đang tải...
          </div>
        ) : !invoices || invoices.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            Chưa có hóa đơn nào
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Số hóa đơn</TableHead>
                <TableHead>Kỳ thanh toán</TableHead>
                <TableHead>Hạn thanh toán</TableHead>
                <TableHead className="text-right">Tổng tiền</TableHead>
                <TableHead className="text-right">Đã thu</TableHead>
                <TableHead className="text-right">Còn lại</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((invoice) => {
                const remaining = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
                return (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-medium">
                      {invoice.invoice_number || invoice.id.slice(0, 8)}
                    </TableCell>
                    {/* Cột kỳ thanh toán: schema không có billing_period_start/end
                        (code cũ tham chiếu cột ma → luôn rỗng); giữ ô trống như trước. */}
                    <TableCell></TableCell>
                    <TableCell>
                      {invoice.due_date && format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi })}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(invoice.total_amount || 0)}
                    </TableCell>
                    <TableCell className="text-right text-green-600">
                      {formatCurrency(invoice.paid_amount || 0)}
                    </TableCell>
                    <TableCell className={`text-right ${remaining > 0 ? 'text-orange-600' : ''}`}>
                      {formatCurrency(remaining)}
                    </TableCell>
                    <TableCell>
                      {getInvoiceStatusBadge(invoice.status)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/invoices/${invoice.id}`)}
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
