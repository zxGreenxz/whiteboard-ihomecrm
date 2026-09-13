import { useState, Suspense, lazy } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ArrowLeft,
  DollarSign,
  Printer,
  AlertCircle,
  CheckCircle,
  Image as ImageIcon,
  Pencil,
  QrCode,
  XCircle,
  RotateCcw,
  Receipt,
  Wallet,
  Ban,
} from 'lucide-react';
import { useInvoice, useCancelInvoice, useRestoreInvoice } from '@/hooks/useInvoices';
import { useMyContext } from '@/hooks/useMyContext';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { canCancelInvoice, canOpenInvoiceEditor } from '@/lib/invoiceUtils';
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
import InvoiceAdjustmentHistory from './InvoiceAdjustmentHistory';
import ContractQRDialog from '@/components/contracts/ContractQRDialog';

const InvoiceDetailMobile = lazy(() =>
  import('@/components/invoices/InvoiceDetailMobile').then((m) => ({
    default: m.InvoiceDetailMobile,
  })),
);

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

const formatQty = (value: number) => new Intl.NumberFormat('vi-VN').format(value || 0);

// 'YYYY-MM-DD' → 'dd/MM/yyyy'; rỗng/không hợp lệ → null (để khỏi hiển thị dòng kỳ).
const fmtItemDay = (iso?: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : format(d, 'dd/MM/yyyy');
};

/** Kỳ của dòng hoá đơn — bỏ năm ở vế đầu khi cùng năm cho gọn: 01/09 → 30/09/2026. */
const fmtItemPeriod = (from?: string | null, to?: string | null): string | null => {
  const a = fmtItemDay(from);
  const b = fmtItemDay(to);
  if (!a || !b) return null;
  return a.slice(-4) === b.slice(-4) ? `${a.slice(0, 5)} → ${b}` : `${a} → ${b}`;
};

const ITEM_TYPE_LABEL: Record<string, string> = {
  RENT: 'Tiền phòng',
  SERVICE: 'Dịch vụ',
  PENALTY: 'Phạt',
  DISCOUNT: 'Giảm trừ',
  OTHER: 'Khác',
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  TM: 'Tiền mặt',
  TK: 'Chuyển khoản',
  TT: 'Thanh toán',
  CT: 'Cấn trừ',
};

/** Pill trạng thái — APPROVED là mặc định của mọi hoá đơn nên không có pill. */
const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Nháp', cls: 'bg-[hsl(210_16%_93%)] text-[hsl(210_10%_34%)]' },
  PARTIAL_PAID: { label: 'Trả 1 phần', cls: 'bg-[#e7eefc] text-[#1d4ed8]' },
  PAID: { label: 'Đã thanh toán', cls: 'bg-primary text-primary-foreground' },
  OVERDUE: { label: 'Quá hạn', cls: 'bg-[#fcebe9] text-[#b91c1c]' },
  CANCELLED: { label: 'Đã hủy', cls: 'bg-[#fcebe9] text-[#b91c1c]' },
};

const CARD = 'overflow-hidden rounded-xl border border-border bg-white shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]';
const CARD_HEAD = 'flex items-center gap-2.5 border-b border-[hsl(210_20%_93%)] px-5 py-[15px]';
const CARD_TITLE = 'text-[15px] font-bold tracking-[-0.01em]';
const STAT_LABEL = 'text-[10.5px] font-bold uppercase tracking-[0.06em] text-[hsl(210_10%_38%)]';
const CHIP = 'inline-flex items-center rounded-md border border-[hsl(210_16%_92%)] bg-[#f3f5f6] px-[7px] py-[2px] text-[10.5px] text-[hsl(210_10%_36%)]';
const PILL_INFO = 'inline-flex items-baseline gap-[5px] rounded-full border border-[hsl(210_16%_92%)] bg-[#f3f5f6] px-[9px] py-[2px] text-[11px] text-[hsl(210_10%_38%)]';
const TH = 'h-auto px-3 py-[9px] text-[10.5px] font-bold uppercase tracking-[0.06em] text-[hsl(210_10%_38%)] bg-[#fafbfb]';
const TD = 'px-3 py-3 align-top';
const TR = 'border-[hsl(210_20%_95%)]';

interface RelatedVoucher {
  id: string;
  code: string | null;
  type: 'INCOME' | 'EXPENSE' | string;
  name?: string | null;
  voucher_date?: string | null;
  payment_id?: string | null;
  creator_name?: string | null;
  account?: { id: string; name: string | null } | null;
  items?: { unit_price?: number | null; quantity?: number | null }[];
}

/** Một dòng trong thẻ "Thanh toán & phiếu thu" — gộp payment với phiếu thu/chi của nó. */
interface PaymentRow {
  key: string;
  sortAt: string;
  dateLabel: string;
  methodLabel: string | null;
  amount: number;
  isRefund: boolean;
  code: string | null;
  voucherId: string | null;
  kind: string | null;
  fund: string | null;
  collector: string | null;
  receiptUrl: string | null;
  receiptIdx: number | null;
}

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
 *
 * Bố cục desktop theo handoff Claude Design "Hoá đơn - Thiết kế mới v2": một cột
 * dọc, thẻ đầu gộp trạng thái + thao tác + ba ô tiền + thông tin hoá đơn; thẻ
 * thanh toán gộp phiếu thu/chi vào từng lần thu thay cho cột tóm tắt bên phải.
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
  // returns để giữ thứ tự hooks ổn định giữa các render). payment_id là mối nối
  // phiếu ↔ lần thu; account/creator_name cho chip "Sổ quỹ" / "Người thu".
  const { data: relatedVouchers = [] } = useQuery({
    queryKey: ['invoice-vouchers', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('income_expenses' as any)
        .select(
          'id, code, type, name, voucher_date, approval_status, payment_id, creator_name, account:accounts!income_expenses_account_id_fkey ( id, name ), items:income_expense_items(unit_price, quantity)',
        )
        .eq('invoice_id', id!)
        .eq('approval_status', 'APPROVED')
        .is('deleted_at', null)
        .order('voucher_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as RelatedVoucher[];
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

  const total = invoice.total_amount || 0;
  const paid = invoice.paid_amount || 0;
  const outstandingAmount = total - paid;

  const voucherAmount = (v: RelatedVoucher): number =>
    (v.items ?? []).reduce(
      (sum, it) => sum + Number(it.unit_price || 0) * Number(it.quantity || 0),
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
  const payIsRefund = total < 0 || paid > total;
  const showPay =
    canRecordPaymentPerm &&
    (invoice.status === 'APPROVED' ||
      invoice.status === 'PARTIAL_PAID' ||
      invoice.status === 'OVERDUE');
  // HĐ chưa thu tiền dùng sửa thường; HĐ đã thu tiền dùng luồng điều chỉnh
  // bất biến. Cả hai đều cần quyền invoices.edit và không áp dụng cho HĐ huỷ.
  const showEditBtn =
    canEditPerm && canOpenInvoiceEditor(invoice);
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
  // useInvoice trả payments THÔ (khác useInvoices ở danh sách — hook đó đã lọc):
  // lần thu đã hoàn tác vẫn còn trong mảng. Bỏ chúng đi, nếu không thẻ thanh toán
  // cộng nhầm tiền đã bị đảo. Phiếu chi đối ứng (nếu có) vẫn hiện thành dòng −.
  const payments = (invoice.payments ?? []).filter(
    (p) => !(p as typeof p & { reversed_at?: string | null }).reversed_at,
  );
  const receiptPayments = payments.filter((p) => p.receipt_image_url);
  const receiptUrls = receiptPayments.map((p) => p.receipt_image_url as string);
  const receiptIdxById = new Map(receiptPayments.map((p, i) => [p.id, i]));

  // Gộp lần thu (payments) với phiếu thu/chi (income_expenses) theo payment_id.
  // Phiếu không nối được lần thu nào (vd phiếu chi tiền thối, phiếu cấn trừ) vẫn
  // hiện thành dòng riêng để không mất dấu tiền đã đi qua sổ.
  const voucherByPaymentId = new Map<string, RelatedVoucher>();
  for (const v of relatedVouchers) {
    if (v.payment_id && !voucherByPaymentId.has(v.payment_id)) {
      voucherByPaymentId.set(v.payment_id, v);
    }
  }
  const mergedVoucherIds = new Set<string>();
  const paymentRows: PaymentRow[] = payments.map((p) => {
    const v = voucherByPaymentId.get(p.id);
    if (v) mergedVoucherIds.add(v.id);
    return {
      key: `payment:${p.id}`,
      sortAt: p.payment_date || p.created_at || '',
      dateLabel: p.payment_date
        ? format(new Date(p.payment_date), 'dd/MM/yyyy HH:mm', { locale: vi })
        : '—',
      methodLabel: PAYMENT_METHOD_LABEL[p.payment_method] || p.payment_method || null,
      amount: Number(p.amount) || 0,
      isRefund: false,
      code: v?.code ?? p.receipt_number ?? null,
      voucherId: v?.id ?? null,
      kind: v ? 'Phiếu thu · đã duyệt' : 'Chưa nối phiếu thu',
      fund: v?.account?.name ?? null,
      collector: v?.creator_name ?? null,
      receiptUrl: p.receipt_image_url ?? null,
      receiptIdx: receiptIdxById.get(p.id) ?? null,
    };
  });
  for (const v of relatedVouchers) {
    if (mergedVoucherIds.has(v.id)) continue;
    const isIncome = v.type === 'INCOME';
    paymentRows.push({
      key: `voucher:${v.id}`,
      sortAt: v.voucher_date || '',
      dateLabel: v.voucher_date ? format(new Date(v.voucher_date), 'dd/MM/yyyy') : '—',
      methodLabel: null,
      amount: voucherAmount(v),
      isRefund: !isIncome,
      code: v.code ?? null,
      voucherId: v.id,
      kind: isIncome ? 'Phiếu thu · đã duyệt' : 'Phiếu chi tiền thối · đã duyệt',
      fund: v.account?.name ?? null,
      collector: v.creator_name ?? null,
      receiptUrl: null,
      receiptIdx: null,
    });
  }
  paymentRows.sort((a, b) => a.sortAt.localeCompare(b.sortAt));

  const statusPill = STATUS_PILL[invoice.status] ?? null;
  const dueLabel = invoice.due_date
    ? format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi })
    : '';
  const paidDayLabel = invoice.paid_date
    ? format(new Date(invoice.paid_date), 'dd/MM/yyyy', { locale: vi })
    : '';

  // Dòng trạng thái một câu — thay cho 2 hộp Alert ở cột tóm tắt cũ.
  const note: { text: string; cls: string; Icon: typeof CheckCircle } =
    invoice.status === 'CANCELLED'
      ? { text: 'Hoá đơn đã huỷ', cls: 'text-[#b91c1c]', Icon: Ban }
      : invoice.status === 'PAID'
        ? {
            text: paidDayLabel ? `Đã thu đủ ngày ${paidDayLabel}` : 'Đã thu đủ',
            cls: 'text-[hsl(152_60%_24%)]',
            Icon: CheckCircle,
          }
        : outstandingAmount < 0
          ? {
              text: `Đã thu vượt ${formatCurrency(-outstandingAmount)} — cần hoàn trả khách`,
              cls: 'text-[#c2410c]',
              Icon: AlertCircle,
            }
          : isOverdue
            ? {
                text: dueLabel ? `Đã quá hạn thanh toán ${dueLabel}` : 'Đã quá hạn thanh toán',
                cls: 'text-[#b91c1c]',
                Icon: AlertCircle,
              }
            : outstandingAmount > 0
              ? {
                  text: dueLabel ? `Còn thiếu, hạn ${dueLabel}` : 'Còn thiếu',
                  cls: 'text-[#1d4ed8]',
                  Icon: AlertCircle,
                }
              : { text: 'Đã thu đủ', cls: 'text-[hsl(152_60%_24%)]', Icon: CheckCircle };
  const NoteIcon = note.Icon;

  // Vạch tiến độ thu — theo tỉ lệ đã thu / tổng; HĐ hoàn trả (total < 0) thì đo
  // theo trị tuyệt đối để vạch không âm.
  const progressPct =
    total === 0
      ? paid !== 0
        ? 100
        : 0
      : Math.max(0, Math.min(100, Math.round((paid / total) * 100)));
  const progressCls =
    invoice.status === 'PAID' || outstandingAmount <= 0
      ? 'bg-primary'
      : isOverdue
        ? 'bg-[#dc2626]'
        : 'bg-[#2563eb]';
  const outstandingCls =
    outstandingAmount > 0
      ? isOverdue
        ? 'text-[#dc2626]'
        : 'text-[#c2410c]'
      : 'text-[hsl(210_10%_40%)]';

  const infoFields: { label: string; value: string; mono?: boolean; cls?: string }[] = [
    { label: 'Số hóa đơn', value: invoice.invoice_number || '—', mono: true },
    { label: 'Hợp đồng', value: invoice.contract?.contract_number || '—', mono: true },
    {
      label: 'Khách hàng',
      value: [representativeCustomer?.full_name, representativeCustomer?.phone]
        .filter(Boolean)
        .join(' · ') || '—',
    },
    { label: 'Căn hộ', value: apartmentLabel || '—' },
    { label: 'Kỳ thanh toán', value: billingLabel || '—', mono: true },
    {
      label: 'Ngày phát hành',
      value: invoice.issue_date
        ? format(new Date(invoice.issue_date), 'dd/MM/yyyy', { locale: vi })
        : '—',
      mono: true,
    },
    {
      label: 'Hạn thanh toán',
      value: dueLabel ? (isOverdue ? `${dueLabel} (Quá hạn)` : dueLabel) : '—',
      mono: true,
      cls: isOverdue ? 'text-[#b91c1c]' : undefined,
    },
  ];

  const items = invoice.invoice_items ?? [];

  return (
    <>
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-[18px] text-foreground">
        {/* Thẻ 1 — trạng thái, thao tác, ba ô tiền, thông tin hoá đơn */}
        <section className={CARD}>
          <div className="flex flex-wrap items-center gap-2.5 border-b border-[hsl(210_20%_93%)] px-5 py-3.5">
            {showBackButton && (
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 rounded-lg"
                onClick={onBack}
                title="Quay lại danh sách"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}

            {statusPill && (
              <span
                className={`inline-flex items-center rounded-full px-[11px] py-1 text-xs font-bold ${statusPill.cls}`}
              >
                {statusPill.label}
              </span>
            )}

            <span className={`inline-flex items-center gap-[7px] text-[12.5px] font-semibold ${note.cls}`}>
              <NoteIcon className="h-3.5 w-3.5 shrink-0" />
              {note.text}
            </span>

            <div className="min-w-[8px] flex-1" />

            <div className="flex flex-wrap items-center gap-2">
              {showPay && (
                <Button
                  variant="default"
                  className={`h-9 rounded-lg px-[15px] text-[13px] font-bold ${
                    payIsRefund ? 'bg-orange-600 hover:bg-orange-700' : ''
                  }`}
                  onClick={() => setPaymentDialogOpen(true)}
                >
                  <DollarSign className="mr-2 h-4 w-4" />
                  {payIsRefund ? 'Hoàn trả khách' : 'Ghi nhận thanh toán'}
                </Button>
              )}

              <Button
                variant="outline"
                className="h-9 rounded-lg px-[13px] text-[13px] font-semibold"
                onClick={() => setPrintDialogOpen(true)}
              >
                <Printer className="mr-[7px] h-4 w-4" />
                In hóa đơn
              </Button>

              {showQR && (
                <Button
                  variant="outline"
                  className="h-9 rounded-lg px-[13px] text-[13px] font-semibold"
                  onClick={() => setQrDialogOpen(true)}
                  title="QR hợp đồng (khách quét để xem hoá đơn mới nhất)"
                >
                  <QrCode className="mr-[7px] h-4 w-4" />
                  QR hợp đồng
                </Button>
              )}

              {showEditBtn && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 rounded-lg"
                  onClick={() => setEditDialogOpen(true)}
                  title={(invoice.paid_amount ?? 0) > 0 ? 'Điều chỉnh hóa đơn' : 'Chỉnh sửa'}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}

              {showCancelBtn && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 rounded-lg border-[#fbcfcb] text-[#b91c1c] hover:bg-[#fef2f2] hover:text-[#b91c1c]"
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
                  className="h-9 w-9 rounded-lg border-amber-300 bg-amber-100 text-amber-700 hover:bg-amber-200"
                  onClick={handleRestore}
                  disabled={restoreMutation.isPending}
                  title={restoreMutation.isPending ? 'Đang phục hồi...' : 'Phục hồi hoá đơn'}
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Ba ô tiền — đường kẻ mảnh giữa các ô bằng nền grid */}
          <div className="grid gap-px bg-[hsl(210_20%_93%)] [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
            <div className="bg-white px-5 py-4">
              <div className={STAT_LABEL}>Tổng hoá đơn</div>
              <div className="mt-[7px] font-numeric text-[21px] font-bold tracking-[-0.03em] tabular-nums">
                {formatCurrency(total)}
              </div>
            </div>
            <div className="bg-white px-5 py-4">
              <div className={STAT_LABEL}>Đã thu</div>
              <div className="mt-[7px] font-numeric text-[21px] font-bold tracking-[-0.03em] tabular-nums text-[hsl(152_69%_26%)]">
                {formatCurrency(paid)}
              </div>
            </div>
            <div className="bg-[#f6f9f7] px-5 py-4">
              <div className={STAT_LABEL}>
                {outstandingAmount < 0 ? 'Phải hoàn khách' : 'Còn phải thu'}
              </div>
              <div
                className={`mt-[5px] font-numeric text-[28px] font-bold leading-[1.05] tracking-[-0.04em] tabular-nums ${outstandingCls}`}
              >
                {formatCurrency(Math.abs(outstandingAmount))}
              </div>
              <div className="mt-[9px] h-[5px] overflow-hidden rounded-full bg-[hsl(210_16%_88%)]">
                <div
                  className={`h-full rounded-full ${progressCls}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>

          {/* Thông tin hoá đơn */}
          <div className="grid gap-x-7 gap-y-3.5 border-t border-[hsl(210_20%_93%)] bg-[#fcfdfc] px-5 py-[15px] [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
            {infoFields.map((f) => (
              <div key={f.label} className="min-w-0">
                <div className="text-[11.5px] text-[hsl(210_10%_38%)]">{f.label}</div>
                <div
                  className={`mt-[3px] text-[13.5px] font-semibold tracking-[-0.01em] ${
                    f.mono ? 'font-numeric tabular-nums' : ''
                  } ${f.cls ?? ''}`}
                >
                  {f.value}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Thẻ 2 — chi tiết các khoản thu */}
        <section className={CARD}>
          <div className={CARD_HEAD}>
            <Receipt className="h-[17px] w-[17px] text-primary" />
            <h3 className={CARD_TITLE}>Chi tiết các khoản thu</h3>
            <span className="ml-auto rounded-full border border-[#d2e8da] bg-[#e8f3ec] px-[9px] py-[2px] font-numeric text-[11.5px] font-bold text-[hsl(152_69%_26%)]">
              {items.length} khoản
            </span>
          </div>
          <Table className="text-[13.5px]">
            <TableHeader>
              <TableRow className="border-[hsl(210_20%_93%)] hover:bg-transparent">
                <TableHead className={`${TH} pl-5 text-left`}>Mô tả</TableHead>
                <TableHead className={`${TH} w-[90px] text-right`}>SL</TableHead>
                <TableHead className={`${TH} w-[150px] text-right`}>Đơn giá</TableHead>
                <TableHead className={`${TH} w-[170px] pr-5 text-right`}>Thành tiền</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length > 0 ? (
                items.map((item) => {
                  const period = fmtItemPeriod(item.from_date, item.to_date);
                  return (
                    <TableRow key={item.id} className={TR}>
                      <TableCell className={`${TD} pl-5`}>
                        <div className="text-sm font-semibold tracking-[-0.01em]">
                          {item.description}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {item.type && (
                            <span className={`${CHIP} font-semibold`}>
                              {ITEM_TYPE_LABEL[item.type] ?? item.type}
                            </span>
                          )}
                          {period && (
                            <span className="inline-flex items-center rounded-md border border-[#d8e4fb] bg-[#eef3fd] px-[7px] py-[2px] font-numeric text-[10.5px] text-[#1d4ed8]">
                              {period}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={`${TD} text-right font-numeric tabular-nums text-[hsl(160_12%_30%)]`}>
                        {formatQty(item.quantity)}
                      </TableCell>
                      <TableCell className={`${TD} text-right font-numeric tabular-nums text-[hsl(160_12%_30%)]`}>
                        {formatCurrency(item.unit_price)}
                      </TableCell>
                      <TableCell className={`${TD} pr-5 text-right font-numeric font-bold tabular-nums`}>
                        {formatCurrency(item.amount)}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow className={TR}>
                  <TableCell colSpan={4} className={`${TD} px-5 text-center text-gray-500`}>
                    Không có khoản thu nào
                  </TableCell>
                </TableRow>
              )}

              {invoice.discount_amount > 0 && (
                <TableRow className={TR}>
                  <TableCell colSpan={3} className={`${TD} pl-5 text-right`}>
                    <div className="text-[13px] font-semibold text-[hsl(210_10%_34%)]">Giảm trừ</div>
                    {invoice.discount_notes && (
                      <div className="text-[11px] text-[hsl(210_10%_38%)]">
                        {invoice.discount_notes}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={`${TD} pr-5 text-right font-numeric font-bold tabular-nums text-[#15803d]`}>
                    −{formatCurrency(invoice.discount_amount)}
                  </TableCell>
                </TableRow>
              )}

              {invoice.previous_debt > 0 && (
                <TableRow className={TR}>
                  <TableCell colSpan={3} className={`${TD} pl-5 text-right`}>
                    <div className="text-[13px] font-bold text-[#b45309]">Nợ cũ kỳ trước</div>
                    {invoice.previous_debt_sources?.length > 0 && (
                      <div className="text-[11px] text-[hsl(210_10%_38%)]">
                        {invoice.previous_debt_sources
                          .map((s) => s.label)
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={`${TD} pr-5 text-right font-numeric font-bold tabular-nums text-[#b45309]`}>
                    {formatCurrency(invoice.previous_debt)}
                  </TableCell>
                </TableRow>
              )}

              <TableRow className="bg-[#f5f9f6] hover:bg-[#f5f9f6]">
                <TableCell colSpan={3} className="px-5 py-3.5 text-right text-sm font-bold">
                  Tổng cộng
                </TableCell>
                <TableCell className="px-5 py-3.5 text-right font-numeric text-base font-bold tracking-[-0.02em] tabular-nums text-[hsl(152_69%_24%)]">
                  {formatCurrency(total)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </section>

        {/* Thẻ 3 — thanh toán & phiếu thu */}
        <section className={CARD}>
          <div className={CARD_HEAD}>
            <Wallet className="h-[17px] w-[17px] text-primary" />
            <h3 className={CARD_TITLE}>Thanh toán &amp; phiếu thu</h3>
            <span className="ml-auto text-[11.5px] text-[hsl(210_10%_38%)]">
              {paymentRows.length > 0
                ? `${paymentRows.length} lần ghi nhận`
                : 'Chưa có lần thanh toán nào'}
            </span>
          </div>

          {paymentRows.map((row) => (
            <div
              key={row.key}
              className="flex items-center gap-4 border-b border-[hsl(210_20%_95%)] px-5 py-3.5"
            >
              {row.receiptUrl ? (
                <button
                  type="button"
                  onClick={() => setLightboxIdx(row.receiptIdx ?? 0)}
                  className="h-[42px] w-[58px] shrink-0 overflow-hidden rounded-[7px] border border-border transition hover:border-primary"
                  title="Xem ảnh chứng từ"
                >
                  <StorageImage
                    value={row.receiptUrl}
                    alt={`Chứng từ thanh toán ${row.dateLabel}`}
                    className="h-full w-full object-cover"
                  />
                </button>
              ) : (
                <span
                  className="grid h-[42px] w-[58px] shrink-0 place-items-center rounded-[7px] border border-dashed border-border text-[hsl(210_10%_60%)]"
                  title="Không có ảnh chứng từ"
                >
                  <ImageIcon className="h-4 w-4" />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="font-numeric text-[13.5px] font-bold tracking-[-0.02em] tabular-nums">
                    {row.dateLabel}
                  </span>
                  {row.methodLabel && (
                    <span className="rounded-full border border-[hsl(210_16%_92%)] bg-[#f3f5f6] px-2 py-[2px] text-[11px] font-bold text-[hsl(210_10%_34%)]">
                      {row.methodLabel}
                    </span>
                  )}
                  {row.fund && (
                    <span className={PILL_INFO}>
                      Sổ quỹ <b className="font-bold text-[hsl(160_25%_16%)]">{row.fund}</b>
                    </span>
                  )}
                  {row.collector && (
                    <span className={PILL_INFO}>
                      Người thu <b className="font-bold text-[hsl(160_25%_16%)]">{row.collector}</b>
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-[7px] text-[11.5px] text-[hsl(210_10%_38%)]">
                  {row.code &&
                    (row.voucherId ? (
                      <a
                        href={`/income-expense/print/${row.voucherId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-numeric text-xs font-bold text-primary hover:underline"
                        title="Mở phiếu trong sổ Thu/Chi"
                      >
                        {row.code}
                      </a>
                    ) : (
                      <span className="font-numeric text-xs font-bold">{row.code}</span>
                    ))}
                  {row.kind && <span>{row.kind}</span>}
                </div>
              </div>

              <div
                className={`shrink-0 text-right font-numeric text-[15px] font-bold tracking-[-0.02em] tabular-nums ${
                  row.isRefund ? 'text-[#dc2626]' : 'text-[hsl(152_69%_26%)]'
                }`}
              >
                {row.isRefund ? '−' : '+'}
                {formatCurrency(row.amount)}
              </div>
            </div>
          ))}

          {paymentRows.length === 0 && (
            <div className="border-b border-[hsl(210_20%_95%)] px-5 py-6 text-center text-[13px] text-[hsl(210_10%_45%)]">
              Chưa ghi nhận lần thanh toán nào cho hoá đơn này.
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-x-[26px] gap-y-2 bg-[#f5f9f6] px-5 py-[13px]">
            {totalReceived > 0 && (
              <span className="inline-flex items-baseline gap-2 text-[12.5px] text-[hsl(210_10%_34%)]">
                Tổng thu (+)
                <b className="font-numeric text-[13.5px] tabular-nums text-[hsl(152_69%_26%)]">
                  {formatCurrency(totalReceived)}
                </b>
              </span>
            )}
            {totalRefunded > 0 && (
              <span className="inline-flex items-baseline gap-2 text-[12.5px] text-[hsl(210_10%_34%)]">
                Tổng thối (−)
                <b className="font-numeric text-[13.5px] tabular-nums text-[#dc2626]">
                  {formatCurrency(totalRefunded)}
                </b>
              </span>
            )}
            <span className="inline-flex items-baseline gap-2 text-[12.5px] text-[hsl(210_10%_34%)]">
              Đã thanh toán net
              <b className="font-numeric text-[13.5px] tabular-nums">{formatCurrency(paid)}</b>
            </span>
            <span className="inline-flex items-baseline gap-2 text-[13px] font-bold">
              {outstandingAmount < 0 ? 'Phải hoàn khách' : 'Còn lại'}
              <b
                className={`font-numeric text-[17px] tracking-[-0.02em] tabular-nums ${outstandingCls}`}
              >
                {formatCurrency(Math.abs(outstandingAmount))}
              </b>
            </span>
          </div>
        </section>

        {/* Lịch sử điều chỉnh (bản gốc bất biến + từng phiên bản) */}
        <InvoiceAdjustmentHistory invoice={invoice} />

        {/* Ghi chú hoá đơn */}
        {invoice.notes && (
          <section className={`${CARD} px-5 py-[15px]`}>
            <div className={`${STAT_LABEL} mb-[7px]`}>Ghi chú hoá đơn</div>
            <p className="m-0 text-[13.5px] leading-[1.55] text-[hsl(160_15%_20%)]">
              {invoice.notes}
            </p>
          </section>
        )}
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
