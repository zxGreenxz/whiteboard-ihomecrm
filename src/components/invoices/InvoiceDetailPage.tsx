import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  ArrowLeft,
  Send,
  Download,
  Printer,
  Pencil,
  DollarSign,
  Receipt,
  ExternalLink,
  Image,
  CheckCircle,
  AlertCircle,
} from 'lucide-react';
import MainLayout from '@/components/layout/MainLayout';
import InvoiceStatusBadge from './InvoiceStatusBadge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
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
import { Separator } from '@/components/ui/separator';
import { useInvoice } from '@/hooks/useInvoices';
import { useMyPermissions, can } from '@/hooks/useMyPermissions';
import { canEditInvoice } from '@/lib/invoiceUtils';
import type { InvoiceItem, Payment, PaymentMethod } from '@/types/invoice';
import RecordPaymentDialog from './RecordPaymentDialog';
import PrintInvoiceDialog from './PrintInvoiceDialog';
import EditInvoiceDialog from './EditInvoiceDialog';
import InvoiceSendActions from './InvoiceSendActions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatVND = (amount: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(amount)) + ' đ';

const formatDate = (dateStr: string | null | undefined) => {
  if (!dateStr) return '—';
  try {
    return format(new Date(dateStr), 'dd/MM/yyyy');
  } catch {
    return dateStr;
  }
};

const itemTypeLabels: Record<string, string> = {
  RENT: 'Tiền nhà',
  SERVICE: 'Dịch vụ',
  PENALTY: 'Phạt',
  DISCOUNT: 'Giảm giá',
  OTHER: 'Khác',
};

const paymentMethodLabels: Record<PaymentMethod, string> = {
  TM: 'TM',
  TK: 'TK',
  TT: 'TT',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const InvoiceDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);

  const { data: invoice, isLoading } = useInvoice(id);
  const { data: perms } = useMyPermissions();
  const canEditPerm = can(perms, 'invoices', 'edit');
  const canRecordPaymentPerm = can(perms, 'invoices', 'record_payment');

  // ---- Loading / Error states ----

  if (!id) {
    return (
      <MainLayout title="Lỗi" icon={Receipt}>
        <div className="text-center py-12">
          <p className="text-muted-foreground">ID hoá đơn không hợp lệ</p>
          <Button variant="outline" onClick={() => navigate('/invoices')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  if (isLoading) {
    return (
      <MainLayout title="Đang tải..." icon={Receipt}>
        <div className="text-center py-12 text-muted-foreground">
          Đang tải thông tin hoá đơn...
        </div>
      </MainLayout>
    );
  }

  if (!invoice) {
    return (
      <MainLayout title="Không tìm thấy" icon={Receipt}>
        <div className="text-center py-12">
          <p className="text-muted-foreground">Không tìm thấy hoá đơn</p>
          <Button variant="outline" onClick={() => navigate('/invoices')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  // ---- Derived values ----

  const items: InvoiceItem[] = invoice.invoice_items ?? [];
  const payments: Payment[] = invoice.payments ?? [];
  const remaining = invoice.remaining_amount ?? invoice.total_amount - (invoice.paid_amount ?? 0);
  const editable = canEditInvoice(invoice);

  // ---- Render ----

  return (
    <MainLayout
      title={`Hoá đơn ${invoice.invoice_number ?? ''}`}
      subtitle="Chi tiết hoá đơn"
      icon={Receipt}
    >
      {/* ===== Header: invoice number, status, action buttons ===== */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button variant="outline" size="sm" onClick={() => navigate('/invoices')}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Quay lại
        </Button>

        <div className="flex items-center gap-2 ml-2">
          <span className="text-lg font-semibold">{invoice.invoice_number ?? '—'}</span>
          <InvoiceStatusBadge status={invoice.status} />
        </div>

        <div className="flex-1" />

        {/* Action buttons per spec: Gửi, Tải, In, Sửa, Thu tiền */}
        <Button variant="outline" size="sm" onClick={() => setSendDialogOpen(true)}>
          <Send className="h-4 w-4 mr-1" />
          Gửi hoá đơn
        </Button>

        <Button variant="outline" size="sm" disabled>
          <Download className="h-4 w-4 mr-1" />
          Tải hoá đơn
        </Button>

        <Button variant="outline" size="sm" onClick={() => setPrintDialogOpen(true)}>
          <Printer className="h-4 w-4 mr-1" />
          In hoá đơn
        </Button>

        {canEditPerm && editable && (
          <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
            <Pencil className="h-4 w-4 mr-1" />
            Sửa
          </Button>
        )}

        {canRecordPaymentPerm && (invoice.status === 'APPROVED' || invoice.status === 'PARTIAL_PAID' || invoice.status === 'OVERDUE') && (
          <Button size="sm" onClick={() => setPaymentDialogOpen(true)}>
            <DollarSign className="h-4 w-4 mr-1" />
            Thu tiền
          </Button>
        )}
      </div>

      <div className="space-y-6">
        {/* ===== 1. General info card ===== */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Thông tin chung</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
              <InfoField label="Toà nhà" value={invoice.building?.name} />
              <InfoField label="Phòng" value={invoice.room?.name} />
              <InfoField label="Giường" value={invoice.bed?.name ?? '—'} />
              <InfoField label="Hợp đồng" value={invoice.contract?.contract_number} />
              <InfoField label="Khách thuê" value={invoice.tenant?.full_name} />
              <InfoField label="SĐT" value={invoice.tenant?.phone} />
              <InfoField label="Kỳ thanh toán" value={invoice.billing_month} />
              <InfoField label="Ngày lập" value={formatDate(invoice.issue_date)} />
              <InfoField label="Hạn thanh toán" value={formatDate(invoice.due_date)} />
              {invoice.paid_date && (
                <InfoField label="Ngày thanh toán" value={formatDate(invoice.paid_date)} />
              )}
            </div>
            {invoice.notes && (
              <div className="mt-4">
                <span className="text-xs text-muted-foreground">Ghi chú</span>
                <p className="text-sm bg-muted/50 rounded p-2 mt-1">{invoice.notes}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ===== 2. Items table ===== */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Dịch vụ &amp; Phí</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>Dịch vụ</TableHead>
                  <TableHead>Loại</TableHead>
                  <TableHead className="text-right">Đơn giá</TableHead>
                  <TableHead className="text-right">Số lượng</TableHead>
                  <TableHead className="text-right">Hệ số</TableHead>
                  <TableHead className="text-right">Thành tiền</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length > 0 ? (
                  items.map((item, idx) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                      <TableCell>
                        <div className="font-medium">{item.description}</div>
                        {item.previous_reading != null && item.current_reading != null && (
                          <div className="text-xs text-muted-foreground">
                            Chỉ số: {item.previous_reading} → {item.current_reading}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {itemTypeLabels[item.type] ?? item.type}
                      </TableCell>
                      <TableCell className="text-right">{formatVND(item.unit_price)}</TableCell>
                      <TableCell className="text-right">{item.quantity}</TableCell>
                      <TableCell className="text-right">{item.coefficient}</TableCell>
                      <TableCell className="text-right font-medium">{formatVND(item.amount)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      Không có dòng dịch vụ
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* ===== 3. Summary ===== */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tổng kết</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-w-sm ml-auto space-y-2 text-sm">
              <SummaryRow label="Tạm tính" value={formatVND(invoice.subtotal)} />
              <SummaryRow label="Giảm giá" value={`-${formatVND(invoice.discount_amount)}`} />
              {(invoice.previous_debt ?? 0) > 0 && (
                <SummaryRow
                  label="Nợ cũ"
                  value={`+${formatVND(invoice.previous_debt)}`}
                />
              )}
              <Separator />
              <SummaryRow label="Thành tiền" value={formatVND(invoice.total_amount)} bold />
              {invoice.prepaid_amount > 0 && (
                <SummaryRow label="Trả trước" value={`-${formatVND(invoice.prepaid_amount)}`} />
              )}
              <SummaryRow label="Đã thanh toán" value={formatVND(invoice.paid_amount)} className="text-green-600" />
              <Separator />
              <SummaryRow
                label="Còn lại"
                value={formatVND(remaining)}
                bold
                className={remaining > 0 ? 'text-orange-600' : 'text-green-600'}
              />
            </div>

            {invoice.status === 'PAID' && (
              <Alert className="mt-4 bg-green-50 border-green-200">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <AlertDescription className="text-green-800 text-sm">
                  Hoá đơn đã được thanh toán đầy đủ
                </AlertDescription>
              </Alert>
            )}

            {invoice.status === 'OVERDUE' && (
              <Alert className="mt-4 bg-red-50 border-red-200">
                <AlertCircle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800 text-sm">
                  Hoá đơn đã quá hạn thanh toán
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* ===== 4. Payment history ===== */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lịch sử thanh toán</CardTitle>
          </CardHeader>
          <CardContent>
            {payments.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ngày</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                    <TableHead>Phương thức</TableHead>
                    <TableHead>Ghi chú</TableHead>
                    <TableHead>Biên lai</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{formatDate(p.payment_date)}</TableCell>
                      <TableCell className="text-right font-medium text-green-600">
                        {formatVND(p.amount)}
                      </TableCell>
                      <TableCell>
                        {paymentMethodLabels[p.payment_method] ?? p.payment_method}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs max-w-[200px] truncate">
                        {p.notes || '—'}
                      </TableCell>
                      <TableCell>
                        {p.receipt_image_url ? (
                          <a
                            href={p.receipt_image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs"
                          >
                            <Image className="h-3.5 w-3.5" />
                            Xem ảnh
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">Không có</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-center text-muted-foreground text-sm py-6">
                Chưa có lịch sử thanh toán
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ===== Dialogs ===== */}
      <InvoiceSendActions
        invoiceId={id}
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
      />
      <RecordPaymentDialog
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        invoice={invoice}
      />
      <PrintInvoiceDialog
        open={printDialogOpen}
        onOpenChange={setPrintDialogOpen}
        invoice={invoice}
      />
      {editable && (
        <EditInvoiceDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          invoice={invoice}
        />
      )}
    </MainLayout>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function InfoField({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className="font-medium">{value || '—'}</p>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  bold,
  className,
}: {
  label: string;
  value: string;
  bold?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex justify-between ${bold ? 'font-semibold' : ''} ${className ?? ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default InvoiceDetailPage;
