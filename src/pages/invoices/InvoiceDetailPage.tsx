import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Receipt,
  ArrowLeft,
  CheckCircle,
  DollarSign,
  Printer,
  AlertCircle,
} from 'lucide-react';
import { useInvoice, useApproveInvoice } from '@/hooks/useInvoices';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useState } from 'react';
import RecordPaymentDialog from '@/components/invoices/RecordPaymentDialog';
import PrintInvoiceDialog from '@/components/invoices/PrintInvoiceDialog';

const InvoiceDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);

  const { data: invoice, isLoading } = useInvoice(id || '');
  const approveMutation = useApproveInvoice();

  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy hóa đơn" icon={Receipt}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID hóa đơn không hợp lệ</p>
          <Button onClick={() => navigate('/invoices')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  if (isLoading) {
    return (
      <MainLayout title="Đang tải..." subtitle="Vui lòng đợi" icon={Receipt}>
        <div className="text-center py-12 text-gray-500">
          Đang tải thông tin hóa đơn...
        </div>
      </MainLayout>
    );
  }

  if (!invoice) {
    return (
      <MainLayout title="Không tìm thấy" subtitle="Hóa đơn không tồn tại" icon={Receipt}>
        <div className="text-center py-12">
          <p className="text-gray-500">Không tìm thấy hóa đơn với ID này</p>
          <Button onClick={() => navigate('/invoices')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

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

  const outstandingAmount = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
  const isOverdue = invoice.status !== 'PAID' && invoice.due_date && new Date(invoice.due_date) < new Date();

  const handleApprove = () => {
    if (confirm('Xác nhận duyệt hóa đơn này?')) {
      approveMutation.mutate(invoice.id);
    }
  };

  return (
    <MainLayout
      title={`Hóa đơn ${invoice.title || invoice.id.slice(0, 8)}`}
      subtitle="Chi tiết hóa đơn"
      icon={Receipt}
    >
      {/* Header Actions */}
      <div className="flex items-center gap-2 mb-6">
        <Button
          variant="outline"
          onClick={() => navigate('/invoices')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>

        <div className="flex-1" />

        {invoice.status === 'DRAFT' && (
          <Button
            variant="default"
            onClick={handleApprove}
            disabled={approveMutation.isPending}
          >
            <CheckCircle className="h-4 w-4 mr-2" />
            {approveMutation.isPending ? 'Đang duyệt...' : 'Duyệt hóa đơn'}
          </Button>
        )}

        {(invoice.status === 'APPROVED' || invoice.status === 'PARTIAL_PAID') && (
          <Button
            variant="default"
            onClick={() => setPaymentDialogOpen(true)}
          >
            <DollarSign className="h-4 w-4 mr-2" />
            Ghi nhận thanh toán
          </Button>
        )}

        <Button variant="outline" onClick={() => setPrintDialogOpen(true)}>
          <Printer className="h-4 w-4 mr-2" />
          In hóa đơn
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Invoice Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Invoice Details Card */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Thông tin hóa đơn</CardTitle>
                {getStatusBadge(invoice.status)}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-gray-600">Số hóa đơn</div>
                  <div className="font-medium">{invoice.title || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Hợp đồng</div>
                  <div className="font-medium">{invoice.contract?.contract_number || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Khách thuê</div>
                  <div className="font-medium">{invoice.contract?.tenant?.full_name || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Số điện thoại</div>
                  <div className="font-medium">{invoice.contract?.tenant?.phone || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Phòng</div>
                  <div className="font-medium">
                    {invoice.contract?.room?.name || invoice.contract?.bed?.name || 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="text-gray-600">Kỳ thanh toán</div>
                  <div className="font-medium">
                    {invoice.billing_period_start && invoice.billing_period_end && (
                      <>
                        {format(new Date(invoice.billing_period_start), 'dd/MM', { locale: vi })}
                        {' - '}
                        {format(new Date(invoice.billing_period_end), 'dd/MM/yyyy', { locale: vi })}
                      </>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-gray-600">Ngày phát hành</div>
                  <div className="font-medium">
                    {invoice.issue_date && format(new Date(invoice.issue_date), 'dd/MM/yyyy', { locale: vi })}
                  </div>
                </div>
                <div>
                  <div className="text-gray-600">Hạn thanh toán</div>
                  <div className={`font-medium ${isOverdue ? 'text-red-600' : ''}`}>
                    {invoice.due_date && format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi })}
                    {isOverdue && <span className="ml-2 text-xs">(Quá hạn)</span>}
                  </div>
                </div>
              </div>

              {invoice.notes && (
                <div>
                  <div className="text-gray-600 text-sm mb-1">Ghi chú</div>
                  <div className="text-sm bg-gray-50 p-3 rounded">{invoice.notes}</div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Invoice Items Card */}
          <Card>
            <CardHeader>
              <CardTitle>Chi tiết các khoản thu</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mô tả</TableHead>
                    <TableHead className="text-right">Số lượng</TableHead>
                    <TableHead className="text-right">Đơn giá</TableHead>
                    <TableHead className="text-right">Thành tiền</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.invoice_items && invoice.invoice_items.length > 0 ? (
                    invoice.invoice_items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>
                          <div className="font-medium">{item.description}</div>
                          <div className="text-xs text-gray-500 capitalize">{item.type?.toLowerCase()}</div>
                        </TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.unit_price)}</TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(item.amount)}</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-gray-500">
                        Không có khoản thu nào
                      </TableCell>
                    </TableRow>
                  )}
                  <TableRow className="bg-gray-50 font-bold">
                    <TableCell colSpan={3} className="text-right">Tổng cộng</TableCell>
                    <TableCell className="text-right">{formatCurrency(invoice.total_amount || 0)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Payments Card */}
          {invoice.payments && invoice.payments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Lịch sử thanh toán</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ngày thanh toán</TableHead>
                      <TableHead>Số tiền</TableHead>
                      <TableHead>Phương thức</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoice.payments.map((payment) => (
                      <TableRow key={payment.id}>
                        <TableCell>
                          {format(new Date(payment.payment_date), 'dd/MM/yyyy HH:mm', { locale: vi })}
                        </TableCell>
                        <TableCell className="font-medium text-green-600">
                          {formatCurrency(payment.amount)}
                        </TableCell>
                        <TableCell className="capitalize">{payment.payment_method?.toLowerCase()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Column - Summary */}
        <div className="space-y-6">
          {/* Payment Summary Card */}
          <Card>
            <CardHeader>
              <CardTitle>Tóm tắt thanh toán</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Tổng tiền:</span>
                  <span className="font-bold">{formatCurrency(invoice.total_amount || 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Đã thanh toán:</span>
                  <span className="font-medium text-green-600">{formatCurrency(invoice.paid_amount || 0)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between">
                  <span className="text-gray-900 font-medium">Còn lại:</span>
                  <span className={`font-bold text-lg ${outstandingAmount > 0 ? 'text-orange-600' : 'text-gray-500'}`}>
                    {formatCurrency(outstandingAmount)}
                  </span>
                </div>
              </div>

              {invoice.status === 'PAID' && (
                <Alert className="bg-green-50 border-green-200">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-green-800 text-sm">
                    Hóa đơn đã được thanh toán đầy đủ
                  </AlertDescription>
                </Alert>
              )}

              {isOverdue && outstandingAmount > 0 && (
                <Alert className="bg-red-50 border-red-200">
                  <AlertCircle className="h-4 w-4 text-red-600" />
                  <AlertDescription className="text-red-800 text-sm">
                    Hóa đơn đã quá hạn thanh toán
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Payment Dialog */}
      <RecordPaymentDialog
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        invoice={invoice}
      />

      {/* Print Dialog */}
      <PrintInvoiceDialog
        open={printDialogOpen}
        onOpenChange={setPrintDialogOpen}
        invoice={invoice}
      />
    </MainLayout>
  );
};

export default InvoiceDetailPage;
