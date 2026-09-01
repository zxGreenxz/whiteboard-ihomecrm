import { useState, Suspense, lazy } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import {
  ArrowLeft,
  DollarSign,
  Printer,
  AlertCircle,
  CheckCircle,
  Image,
  ExternalLink,
  Pencil,
  QrCode,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import { useInvoice, useCancelInvoice, useRestoreInvoice } from '@/hooks/useInvoices';
import { useMyContext } from '@/hooks/useMyContext';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { canEditInvoice, canCancelInvoice } from '@/lib/invoiceUtils';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { StorageImage } from '@/components/ui/storage-image';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import RecordPaymentDialog from '@/components/invoices/RecordPaymentDialog';
import RecordRefundDialog from '@/components/invoices/RecordRefundDialog';
import PrintInvoiceDialog from '@/components/invoices/PrintInvoiceDialog';
import EditInvoiceDialog from '@/components/invoices/EditInvoiceDialog';
import ContractQRDialog from '@/components/contracts/ContractQRDialog';

const InvoiceDetailMobile = lazy(() =>
  import('@/components/invoices/InvoiceDetailMobile').then((m) => ({
    default: m.InvoiceDetailMobile,
  })),
);

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

// 'YYYY-MM-DD' → 'dd/MM/yyyy'; rỗng/không hợp lệ → null (để khỏi hiển thị dòng kỳ).
const fmtItemDay = (iso?: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : format(d, 'dd/MM/yyyy');
};

interface InvoiceDetailViewProps {
  /** ID hoá đơn cần hiển thị (đã đảm bảo có giá trị bởi nơi gọi). */
  id: string;
  /** Quay lại danh sách / đóng modal. */
  onBack: () => void;
  /** Ẩn nút quay lại đầu thanh thao tác (modal đã có nút X riêng). */
  showBackButton?: boolean;
}

/**
 * Nội dung chi tiết hoá đơn — KHÔNG kèm khung (MainLayout / Dialog).
 * Dùng chung cho:
 *  - Route /invoices/:id (bọc MainLayout) — deep-link, thông báo, HĐ trong HĐ thuê…
 *  - Modal full-screen mở từ danh sách hoá đơn (giữ nguyên bộ lọc đang dò).
 */
const InvoiceDetailView = ({ id, onBack, showBackButton = true }: InvoiceDetailViewProps) => {
  const isPhone = usePhoneViewport();
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  // Xem ảnh chứng từ thanh toán bằng lightbox tại chỗ (không mở tab mới).
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const { data: invoice, isLoading } = useInvoice(id || '');
  const cancelMutation = useCancelInvoice();
  const restoreMutation = useRestoreInvoice();
  const { data: ctx } = useMyContext();
  const { data: perms } = useMyPermissions();
  const canEditPerm = canUse(perms, 'invoices', 'edit');
  const canRecordPaymentPerm = canUse(perms, 'invoices', 'record_payment');
  // Gôm nút Xoá về nút Huỷ (09/2026): nhận cả quyền invoices.delete cũ trong
  // giai đoạn chuyển tiếp để role cũ không mất nút.
  const canCancelPerm =
    canUse(perms, 'invoices', 'cancel') || canUse(perms, 'invoices', 'delete');

  // Lấy danh sách phiếu thu/chi APPROVED gắn với hoá đơn (declared trước early
  // returns để giữ thứ tự hooks ổn định giữa các render).
  const { data: relatedVouchers = [] } = useQuery({
    queryKey: ['invoice-vouchers', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('income_expenses' as any)
        .select(
          'id, code, type, name, voucher_date, approval_status, items:income_expense_items(unit_price, quantity)',
        )
        .eq('invoice_id', id!)
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        .order('voucher_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  if (!id) return null;

  if (isLoading) {
    return (
      <div className="text-center py-12 text-gray-500">
        Đang tải thông tin hóa đơn...
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Không tìm thấy hóa đơn với ID này</p>
        <Button onClick={onBack} className="mt-4">
          Quay lại danh sách
        </Button>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    // Mặc định mọi hoá đơn = APPROVED → không hiển thị badge cho trạng thái này.
    if (status === 'APPROVED') return null;
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      PARTIAL_PAID: { variant: 'secondary', label: 'Trả 1 phần' },
      PAID: { variant: 'default', label: 'Đã thanh toán' },
      OVERDUE: { variant: 'destructive', label: 'Quá hạn' },
      CANCELLED: { variant: 'destructive', label: 'Đã hủy' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const outstandingAmount = (invoice.total_amount || 0) - (invoice.paid_amount || 0);

  const voucherAmount = (v: any): number =>
    (v.items ?? []).reduce(
      (sum: number, it: any) =>
        sum + Number(it.unit_price || 0) * Number(it.quantity || 0),
      0,
    );
  const totalReceived = relatedVouchers
    .filter((v) => v.type === 'INCOME')
    .reduce((s, v) => s + voucherAmount(v), 0);
  const totalRefunded = relatedVouchers
    .filter((v) => v.type === 'EXPENSE')
    .reduce((s, v) => s + voucherAmount(v), 0);
  const isOverdue = invoice.status !== 'PAID' && invoice.due_date && new Date(invoice.due_date) < new Date();

  const handleCancel = () => {
    if (confirm('Huỷ hoá đơn này? Hoá đơn sẽ chuyển vào mục "Đã huỷ" và có thể phục hồi khi cần.')) {
      cancelMutation.mutate(invoice.id);
    }
  };

  const handleRestore = () => {
    if (confirm(`Phục hồi hoá đơn ${invoice.invoice_number} về trạng thái Đã duyệt?`)) {
      restoreMutation.mutate(invoice.id);
    }
  };

  const buildingName = invoice.building?.name?.trim() || '';
  const roomName = invoice.room?.name?.trim() || '';
  const billingLabel = invoice.billing_month
    ? (() => {
        const [y, m] = invoice.billing_month.split('-');
        return m && y ? `${parseInt(m, 10)}/${y}` : invoice.billing_month;
      })()
    : '';

  // Khách đại diện (đặt theo contract_customers; ưu tiên is_representative,
  // fallback khách đầu tiên).
  const contractCustomers = invoice.contract?.contract_customers ?? [];
  const representativeCustomer =
    contractCustomers.find((cc) => cc.is_representative)?.customer ??
    contractCustomers[0]?.customer ??
    null;

  // Hiển thị "Toà - Phòng" cho ô Căn hộ.
  const apartmentLabel = [buildingName, roomName]
    .filter((s) => s.trim())
    .join(' - ');

  // Điều kiện hiển thị nút thao tác (dùng chung desktop + mobile).
  const payTotal = invoice.total_amount || 0;
  const payPaid = invoice.paid_amount || 0;
  const payIsRefund = payTotal < 0 || payPaid > payTotal;
  const showPay =
    canRecordPaymentPerm &&
    (invoice.status === 'APPROVED' ||
      invoice.status === 'PARTIAL_PAID' ||
      invoice.status === 'OVERDUE');
  const showEditBtn = canEditPerm && canEditInvoice(invoice);
  // canCancelInvoice thêm điều kiện paid_amount=0 — RPC cancel KHÔNG guard ở DB.
  const showCancelBtn = canCancelPerm && canCancelInvoice(invoice);
  // Phục hồi mở cho ai có quyền huỷ (RPC restore chỉ đòi invoices.edit) —
  // bài học vụ Joey 31/08: tự bấm nhầm phải tự cứu được.
  const showRestoreBtn =
    invoice.status === 'CANCELLED' && (!!ctx?.isSuper || canCancelPerm);
  const showQR = !!invoice.contract_id && invoice.contract?.status !== 'TERMINATED';

  // Dialog thanh toán / in / sửa / QR — dùng chung cả 2 layout.
  const dialogs = (
    <>
      {payIsRefund ? (
        <RecordRefundDialog
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          invoice={invoice}
        />
      ) : (
        <RecordPaymentDialog
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          invoice={invoice}
        />
      )}
      <PrintInvoiceDialog
        open={printDialogOpen}
        onOpenChange={setPrintDialogOpen}
        invoice={invoice}
      />
      <EditInvoiceDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        invoice={invoice}
      />
      {invoice.contract?.public_code && (
        <ContractQRDialog
          open={qrDialogOpen}
          onOpenChange={setQrDialogOpen}
          publicCode={invoice.contract.public_code}
          contractLabel={
            invoice.contract?.contract_number || apartmentLabel || invoice.contract_id?.slice(0, 8) || ''
          }
          buildingName={invoice.building?.name}
          roomName={invoice.room?.name}
        />
      )}
    </>
  );

  // Mobile (≤767px): trang chi tiết app full-screen (warm-neutral).
  if (isPhone) {
    return (
      <Suspense fallback={null}>
        <InvoiceDetailMobile
          invoice={invoice}
          relatedVouchers={relatedVouchers as never}
          onBack={onBack}
          showPay={showPay}
          payIsRefund={payIsRefund}
          onRecordPayment={() => setPaymentDialogOpen(true)}
          showEdit={showEditBtn}
          onEdit={() => setEditDialogOpen(true)}
          showCancel={showCancelBtn}
          onCancel={handleCancel}
          showRestore={showRestoreBtn}
          onRestore={handleRestore}
          showQR={showQR}
          onShowQR={() => setQrDialogOpen(true)}
        />
        {dialogs}
      </Suspense>
    );
  }

  // Ảnh chứng từ thanh toán — gom các phiếu có ảnh để xem bằng lightbox tại chỗ
  // (không mở tab mới làm rời trang). Index = vị trí trong danh sách ảnh.
  const receiptPayments = (invoice.payments ?? []).filter((p) => p.receipt_image_url);
  const receiptUrls = receiptPayments.map((p) => p.receipt_image_url as string);
  const receiptIdxById = new Map(receiptPayments.map((p, i) => [p.id, i]));

  return (
    <>
      {/* Header Actions: 3 nút phụ icon-only (gọn, không che nút thanh toán),
          2 nút action chính giữ nguyên label */}
      <div className="flex items-center gap-2 mb-6 flex-wrap">
        {showBackButton && (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={onBack}
            title="Quay lại danh sách"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}

        {canEditPerm && canEditInvoice(invoice) && (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setEditDialogOpen(true)}
            title="Chỉnh sửa"
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}

        {showCancelBtn && (
          <Button
            variant="destructive"
            size="icon"
            className="h-9 w-9"
            onClick={handleCancel}
            disabled={cancelMutation.isPending}
            title={cancelMutation.isPending ? 'Đang hủy...' : 'Hủy hóa đơn'}
          >
            <XCircle className="h-4 w-4" />
          </Button>
        )}

        {showRestoreBtn && (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 bg-amber-100 text-amber-700 hover:bg-amber-200 border-amber-300"
            onClick={handleRestore}
            disabled={restoreMutation.isPending}
            title={restoreMutation.isPending ? 'Đang phục hồi...' : 'Phục hồi hoá đơn'}
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        )}

        <div className="flex-1" />

        {canRecordPaymentPerm && (invoice.status === 'APPROVED' ||
          invoice.status === 'PARTIAL_PAID' ||
          invoice.status === 'OVERDUE') &&
          (() => {
            const total = invoice.total_amount || 0;
            const paid = invoice.paid_amount || 0;
            const isRefund = total < 0 || paid > total;
            return (
              <Button
                variant="default"
                className={isRefund ? 'bg-orange-600 hover:bg-orange-700' : ''}
                onClick={() => setPaymentDialogOpen(true)}
              >
                <DollarSign className="h-4 w-4 mr-2" />
                {isRefund ? 'Hoàn trả khách' : 'Ghi nhận thanh toán'}
              </Button>
            );
          })()}

        <Button variant="outline" onClick={() => setPrintDialogOpen(true)}>
          <Printer className="h-4 w-4 mr-2" />
          In hóa đơn
        </Button>

        {invoice.contract_id &&
          invoice.contract?.status !== 'TERMINATED' && (
            <Button
              variant="outline"
              onClick={() => setQrDialogOpen(true)}
              title="QR hợp đồng (khách quét để xem hoá đơn mới nhất)"
            >
              <QrCode className="h-4 w-4 mr-2" />
              QR hợp đồng
            </Button>
          )}
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
                  <div className="font-medium">{invoice.invoice_number || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Hợp đồng</div>
                  <div className="font-medium">{invoice.contract?.contract_number || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Khách hàng</div>
                  <div className="font-medium">{representativeCustomer?.full_name || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Số điện thoại</div>
                  <div className="font-medium">{representativeCustomer?.phone || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Căn hộ</div>
                  <div className="font-medium">{apartmentLabel || 'N/A'}</div>
                </div>
                <div>
                  <div className="text-gray-600">Kỳ thanh toán</div>
                  <div className="font-medium">{billingLabel || 'N/A'}</div>
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
                          {fmtItemDay(item.from_date) && fmtItemDay(item.to_date) && (
                            <div className="text-xs text-blue-600">
                              Tính từ {fmtItemDay(item.from_date)} → {fmtItemDay(item.to_date)}
                            </div>
                          )}
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
                  {invoice.discount_amount > 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-right text-gray-600">Giảm trừ</TableCell>
                      <TableCell className="text-right font-medium text-green-600">
                        −{formatCurrency(invoice.discount_amount)}
                      </TableCell>
                    </TableRow>
                  )}
                  {invoice.previous_debt > 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-right align-top">
                        <div className="font-medium text-orange-700">Nợ cũ kỳ trước</div>
                        {invoice.previous_debt_sources?.length > 0 && (
                          <div className="text-xs font-normal text-gray-500">
                            {invoice.previous_debt_sources
                              .map((s) => s.label)
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-medium text-orange-700">
                        {formatCurrency(invoice.previous_debt)}
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
                            <button
                              type="button"
                              onClick={() => setLightboxIdx(receiptIdxById.get(payment.id) ?? 0)}
                              className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 hover:underline"
                            >
                              <Image className="h-4 w-4" />
                              <span>Xem ảnh</span>
                            </button>
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
                      {receiptPayments.map((payment, idx) => (
                          <button
                            key={payment.id}
                            type="button"
                            onClick={() => setLightboxIdx(idx)}
                            className="group relative aspect-video rounded-lg overflow-hidden border bg-gray-100 hover:ring-2 hover:ring-blue-500 transition-all"
                          >
                            <StorageImage
                              value={payment.receipt_image_url!}
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
                          </button>
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
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Tổng tiền hoá đơn:</span>
                <span className="font-bold">{formatCurrency(invoice.total_amount || 0)}</span>
              </div>

              {/* Breakdown từng phiếu thu / chi */}
              {relatedVouchers.length > 0 && (
                <div className="border-t pt-3 space-y-1.5">
                  {relatedVouchers.map((v) => {
                    const isIncome = v.type === 'INCOME';
                    const amt = voucherAmount(v);
                    return (
                      <div
                        key={v.id}
                        className="flex justify-between items-start text-[13px] gap-2"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-zinc-800">{v.code}</div>
                          <div className="text-[11px] text-zinc-500">
                            {isIncome ? 'Phiếu thu' : 'Phiếu chi tiền thối'}
                            {v.voucher_date
                              ? ` · ${format(new Date(v.voucher_date), 'dd/MM/yyyy')}`
                              : ''}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 font-medium tabular-nums ${
                            isIncome ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {isIncome ? '+' : '−'}
                          {formatCurrency(amt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Tổng đã thu net */}
              <div className="border-t pt-3 space-y-1.5 text-sm">
                {totalReceived > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tổng thu (+):</span>
                    <span className="font-medium text-green-600 tabular-nums">
                      {formatCurrency(totalReceived)}
                    </span>
                  </div>
                )}
                {totalRefunded > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tổng thối (−):</span>
                    <span className="font-medium text-red-600 tabular-nums">
                      {formatCurrency(totalRefunded)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-600">Đã thanh toán net:</span>
                  <span className="font-medium text-green-700 tabular-nums">
                    {formatCurrency(invoice.paid_amount || 0)}
                  </span>
                </div>
                <div className="border-t pt-2 flex justify-between">
                  <span className="text-gray-900 font-medium">Còn lại:</span>
                  <span
                    className={`font-bold text-lg tabular-nums ${
                      outstandingAmount > 0 ? 'text-orange-600' : 'text-gray-500'
                    }`}
                  >
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

      {/* Dialog thanh toán / in / sửa / QR (dùng chung) */}
      {dialogs}

      {/* Lightbox xem ảnh chứng từ — overlay tại chỗ, không mở tab mới */}
      <AttachmentLightbox
        attachments={receiptUrls}
        index={lightboxIdx}
        onIndexChange={setLightboxIdx}
      />
    </>
  );
};

export default InvoiceDetailView;
