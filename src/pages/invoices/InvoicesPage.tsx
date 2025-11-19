import { useState } from 'react';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import {
  Receipt,
  Plus,
  Search,
  MoreVertical,
  CheckCircle,
  DollarSign,
  Eye,
  Trash2,
  Gauge,
} from 'lucide-react';
import { useInvoices, useApproveInvoice, useDeleteInvoice, type InvoiceWithRelations } from '@/hooks/useInvoices';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import GenerateInvoiceDialog from '@/components/invoices/GenerateInvoiceDialog';
import MeterReadingDialog from '@/components/invoices/MeterReadingDialog';
import RecordPaymentDialog from '@/components/invoices/RecordPaymentDialog';

const InvoicesPage = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceWithRelations | null>(null);

  // Dialog states (to be implemented)
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false);
  const [meterReadingDialogOpen, setMeterReadingDialogOpen] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);

  const { data: invoices, isLoading } = useInvoices({
    status: statusFilter || undefined,
  });

  const approveMutation = useApproveInvoice();
  const deleteMutation = useDeleteInvoice();

  // Filter invoices based on search term
  const filteredInvoices = invoices?.filter((invoice) => {
    const searchLower = searchTerm.toLowerCase();
    return (
      invoice.title?.toLowerCase().includes(searchLower) ||
      invoice.contract?.contract_number?.toLowerCase().includes(searchLower) ||
      invoice.contract?.tenant?.full_name.toLowerCase().includes(searchLower) ||
      invoice.contract?.tenant?.phone.includes(searchTerm)
    );
  });

  const getStatusBadge = (status: string) => {
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

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getOutstandingAmount = (invoice: InvoiceWithRelations) => {
    return (invoice.total_amount || 0) - (invoice.paid_amount || 0);
  };

  const handleApproveInvoice = (invoiceId: string) => {
    if (confirm('Xác nhận duyệt hóa đơn này?')) {
      approveMutation.mutate(invoiceId);
    }
  };

  const handleDeleteInvoice = (invoiceId: string) => {
    if (confirm('Xác nhận xóa hóa đơn nháp này?')) {
      deleteMutation.mutate(invoiceId);
    }
  };

  return (
    <MainLayout
      title="Quản lý Hóa đơn"
      subtitle="Quản lý hóa đơn và thanh toán"
      icon={Receipt}
    >
      {/* Header Actions */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Tìm theo tiêu đề, mã HĐ, tên khách, SĐT..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2 border rounded-md bg-white"
        >
          <option value="">Tất cả trạng thái</option>
          <option value="DRAFT">Nháp</option>
          <option value="APPROVED">Đã duyệt</option>
          <option value="PARTIAL_PAID">Trả 1 phần</option>
          <option value="PAID">Đã thanh toán</option>
          <option value="OVERDUE">Quá hạn</option>
        </select>

        <Button
          variant="outline"
          onClick={() => setMeterReadingDialogOpen(true)}
        >
          <Gauge className="h-4 w-4 mr-2" />
          Ghi chỉ số
        </Button>

        <Button onClick={() => setGenerateDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Tạo hóa đơn
        </Button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border">
        {isLoading ? (
          <div className="p-8 text-center text-gray-500">
            Đang tải dữ liệu...
          </div>
        ) : !filteredInvoices || filteredInvoices.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {searchTerm || statusFilter
              ? 'Không tìm thấy hóa đơn nào phù hợp'
              : 'Chưa có hóa đơn nào. Nhấn "Tạo hóa đơn" để bắt đầu.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tiêu đề</TableHead>
                <TableHead>Hợp đồng/Khách</TableHead>
                <TableHead>Kỳ thanh toán</TableHead>
                <TableHead>Tổng tiền</TableHead>
                <TableHead>Đã trả</TableHead>
                <TableHead>Còn lại</TableHead>
                <TableHead>Hạn TT</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredInvoices.map((invoice) => {
                const outstanding = getOutstandingAmount(invoice);
                const isOverdue =
                  invoice.status !== 'PAID' &&
                  invoice.due_date &&
                  new Date(invoice.due_date) < new Date();

                return (
                  <TableRow key={invoice.id}>
                    <TableCell>
                      <div>
                        <div className="font-medium">{invoice.title}</div>
                        <div className="text-xs text-gray-500">
                          {invoice.issue_date && format(new Date(invoice.issue_date), 'dd/MM/yyyy', { locale: vi })}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="text-sm">
                          {invoice.contract?.contract_number || 'N/A'}
                        </div>
                        <div className="text-xs text-gray-500">
                          {invoice.contract?.tenant?.full_name}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {invoice.billing_period_start && invoice.billing_period_end && (
                          <>
                            {format(new Date(invoice.billing_period_start), 'dd/MM', { locale: vi })}
                            {' - '}
                            {format(new Date(invoice.billing_period_end), 'dd/MM/yyyy', { locale: vi })}
                          </>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatCurrency(invoice.total_amount || 0)}
                    </TableCell>
                    <TableCell className="text-green-600">
                      {formatCurrency(invoice.paid_amount || 0)}
                    </TableCell>
                    <TableCell className={outstanding > 0 ? 'text-orange-600 font-medium' : 'text-gray-500'}>
                      {formatCurrency(outstanding)}
                    </TableCell>
                    <TableCell>
                      {invoice.due_date && (
                        <div className={isOverdue ? 'text-red-600 font-medium' : ''}>
                          {format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi })}
                          {isOverdue && (
                            <div className="text-xs">Quá hạn</div>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{getStatusBadge(invoice.status)}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Thao tác</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              setSelectedInvoice(invoice);
                              setViewDialogOpen(true);
                            }}
                          >
                            <Eye className="h-4 w-4 mr-2" />
                            Xem chi tiết
                          </DropdownMenuItem>

                          {invoice.status === 'DRAFT' && (
                            <DropdownMenuItem
                              onClick={() => handleApproveInvoice(invoice.id)}
                            >
                              <CheckCircle className="h-4 w-4 mr-2" />
                              Duyệt hóa đơn
                            </DropdownMenuItem>
                          )}

                          {(invoice.status === 'APPROVED' || invoice.status === 'PARTIAL_PAID') && (
                            <DropdownMenuItem
                              onClick={() => {
                                setSelectedInvoice(invoice);
                                setPaymentDialogOpen(true);
                              }}
                            >
                              <DollarSign className="h-4 w-4 mr-2" />
                              Ghi nhận thanh toán
                            </DropdownMenuItem>
                          )}

                          {invoice.status === 'DRAFT' && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-red-600"
                                onClick={() => handleDeleteInvoice(invoice.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Xóa hóa đơn nháp
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Summary Stats */}
      {invoices && invoices.length > 0 && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-5 gap-4">
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Tổng hóa đơn</div>
            <div className="text-2xl font-bold mt-1">{invoices.length}</div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Chờ duyệt</div>
            <div className="text-2xl font-bold mt-1 text-orange-600">
              {invoices.filter((i) => i.status === 'DRAFT').length}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Chưa thanh toán</div>
            <div className="text-2xl font-bold mt-1 text-blue-600">
              {invoices.filter((i) => i.status === 'APPROVED').length}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Đã thanh toán</div>
            <div className="text-2xl font-bold mt-1 text-green-600">
              {invoices.filter((i) => i.status === 'PAID').length}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg border">
            <div className="text-sm text-gray-500">Tổng doanh thu</div>
            <div className="text-lg font-bold mt-1 text-green-600">
              {formatCurrency(
                invoices
                  .filter((i) => i.status === 'PAID')
                  .reduce((sum, i) => sum + (i.total_amount || 0), 0)
              )}
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <GenerateInvoiceDialog
        open={generateDialogOpen}
        onOpenChange={setGenerateDialogOpen}
      />

      <MeterReadingDialog
        open={meterReadingDialogOpen}
        onOpenChange={setMeterReadingDialogOpen}
      />

      <RecordPaymentDialog
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        invoice={selectedInvoice}
      />
    </MainLayout>
  );
};

export default InvoicesPage;
