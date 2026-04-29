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
  DollarSign,
  Printer,
  AlertCircle,
  Image,
  ExternalLink,
  Pencil,
  XCircle,
} from 'lucide-react';
import { useInvoice, useCancelInvoice } from '@/hooks/useInvoices';
import { canEditInvoice } from '@/lib/invoiceUtils';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useState } from 'react';
import RecordPaymentDialog from '@/components/invoices/RecordPaymentDialog';
import PrintInvoiceDialog from '@/components/invoices/PrintInvoiceDialog';
import EditInvoiceDialog from '@/components/invoices/EditInvoiceDialog';

const InvoiceDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const { data: invoice, isLoading } = useInvoice(id || '');
  const cancelMutation = useCancelInvoice();

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

  const handleCancel = () => {
    if (confirm('Bạn có chắc chắn muốn hủy hóa đơn này? Hành động này không thể hoàn tác.')) {
      cancelMutation.mutate(invoice.id);
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

        {canEditInvoice(invoice) && (
          <Button
            variant="outline"
            onClick={() => setEditDialogOpen(true)}
          >
            <Pencil className="h-4 w-4 mr-2" />
            Chỉnh sửa
          </Button>
        )}

        {(invoice.status === 'DRAFT' || invoice.status === 'APPROVED') && (
          <Button
            variant="destructive"
            onClick={handleCancel}
            disabled={cancelMutation.isPending}
          >
            <XCircle className="h-4 w-4 mr-2" />
            {cancelMutation.isPending ? 'Đang hủy...' : 'Hủy hóa đơn'}
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
                  <div className="text-gray-600">Khách hàng</div>
                  <div className="font-medium">{invoice.contract?.tenant?.full_name || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Số điện thoại</div>
                  <div className="font-medium">{invoice.contract?.tenant?.phone || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Căn hộ</div>
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
                      <TableHead>Chứng từ</TableHead>
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
                        <TableCell>
                          {payment.receipt_image_url ? (
                            <a
                              href={payment.receipt_image_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              <Image className="h-4 w-4" />
                              <span>Xem ảnh</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-gray-400 text-sm">Không có</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Receipt Images Gallery */}
                {invoice.payments.some(p => p.receipt_image_url) && (
                  <div className="mt-4 pt-4 border-t">
                    <h4 className="text-sm font-medium text-gray-700 mb-3">Ảnh chứng từ thanh toán</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {invoice.payments
                        .filter(p => p.receipt_image_url)
                        .map((payment) => (
                          <a
                            key={payment.id}
                            href={payment.receipt_image_url!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group relative aspect-video rounded-lg overflow-hidden border bg-gray-100 hover:ring-2 hover:ring-blue-500 transition-all"
                          >
                            <img
                              src={payment.receipt_image_url!}
                              alt={`Chứng từ thanh toán ${format(new Date(payment.payment_date), 'dd/MM/yyyy', { locale: vi })}`}
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                              <ExternalLink className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                              <p className="text-white text-xs">
                                {format(new Date(payment.payment_date), 'dd/MM/yyyy', { locale: vi })} - {formatCurrency(payment.amount)}
                              </p>
                            </div>
                          </a>
                        ))}
                    </div>
                  </div>
                )}
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

      {/* Edit Dialog */}
      <EditInvoiceDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        invoice={invoice}
      />
    </MainLayout>
  );
};

export default InvoiceDetailPage;
