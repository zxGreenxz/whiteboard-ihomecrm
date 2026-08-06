import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { StorageImage } from '@/components/ui/storage-image';
import { AttachmentLightbox } from '@/components/ui/attachment-lightbox';
import { supabase } from '@/integrations/supabase/client';
import { useFirstInvoiceDetails, useContractDepositVouchers } from '@/hooks/useInvoices';
import { useUpdatePaymentMethod } from '@/hooks/useUpdatePaymentMethod';
import { useUploadPaymentReceipt } from '@/hooks/useUploadPaymentReceipt';
import {
  useDeletePayment,
  useCollectionReversalEligibility,
  COLLECTION_BLOCK_TEXT,
} from '@/hooks/useDeletePayment';
import { useClipboardImagePaste } from '@/hooks/useClipboardImagePaste';
import type { InvoiceWithRelations } from '@/types/invoice';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import { Image as ImageIcon, Calendar, Clock, Loader2, Check, Upload, Trash2, Receipt } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

type PaymentMethod = 'TM' | 'TT' | 'TK';

interface PaymentReceiptRow {
  id: string;
  source_kind: 'COLLECTION_TENDER' | 'LEGACY_PAYMENT' | string;
  payment_id: string | null;
  collection_id: string | null;
  voucher_id: string | null;
  account_id: string | null;
  collected_amount: number;
  applied_amount: number;
  credit_amount: number;
  payment_method: PaymentMethod | string;
  payment_date: string;
  receipt_number: string | null;
  receipt_image_url: string | null;
  created_at: string;
}

const METHOD_OPTIONS: PaymentMethod[] = ['TM', 'TT', 'TK'];

/** Slot upload ảnh chứng từ cho 1 phiếu thu chưa có ảnh.
 *  - Click → mở file picker
 *  - Hover + Ctrl/Cmd+V → paste ảnh từ clipboard
 *  Sau upload sẽ append vào income_expenses.attachments của phiếu Thu/Chi
 *  liên kết. */
const ReceiptUploadSlot = ({
  paymentId,
  disabledReason,
}: {
  paymentId: string;
  disabledReason?: string;
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadPaymentReceipt();
  const handleFile = (file: File) => upload.mutate({ payment_id: paymentId, file });
  const paste = useClipboardImagePaste({
    enabled: !disabledReason && !upload.isPending,
    onFiles: (files) => {
      if (files[0]) handleFile(files[0]);
    },
  });

  if (disabledReason) {
    return (
      <div
        className="shrink-0 h-14 w-14 grid place-items-center rounded-md border border-zinc-200 bg-zinc-50 text-zinc-400 cursor-not-allowed"
        title={disabledReason}
      >
        <ImageIcon className="h-5 w-5" />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => fileInputRef.current?.click()}
      onMouseEnter={paste.onMouseEnter}
      onMouseLeave={paste.onMouseLeave}
      className="shrink-0 h-14 w-14 grid place-items-center rounded-md border border-dashed border-zinc-300 text-zinc-400 hover:border-emerald-400 hover:text-emerald-500 hover:bg-emerald-50 transition cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-200"
      title="Click để chọn ảnh, hoặc hover + Ctrl/Cmd+V để dán ảnh từ clipboard"
    >
      {upload.isPending ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <div className="relative">
          <ImageIcon className="h-5 w-5" />
          <Upload className="absolute -bottom-1 -right-1 h-3 w-3 bg-white rounded-full" />
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
};

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const fmtDay = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'dd/MM/yyyy');
};

const METHOD_BADGE: Record<string, string> = {
  TM: 'bg-amber-50 text-amber-700 border-amber-200',
  TK: 'bg-blue-50 text-blue-700 border-blue-200',
  TT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CT: 'bg-violet-50 text-violet-700 border-violet-200',
};

const PaymentsSummaryDialog = ({ open, onOpenChange, invoice }: Props) => {
  const invoiceId = invoice?.id ?? '';
  // Chi tiết "hoá đơn tháng đầu" (ký HĐ): kỳ tiền phòng + đã thu/tổng HĐ & cọc.
  // Trả map rỗng nếu HĐ này không phải hoá đơn tháng đầu.
  const { data: firstInvoiceDetails } = useFirstInvoiceDetails(
    invoiceId ? [invoiceId] : [],
  );
  // Phiếu thu cọc RIÊNG (ngoài HĐ) của hợp đồng — hiện ở ô tách dưới cùng popup
  // để không lẫn với các lần thu của hoá đơn.
  const firstDetail = firstInvoiceDetails?.get(invoiceId);
  const { data: depositVouchers } = useContractDepositVouchers(
    firstDetail?.contractId ?? null,
  );
  const { data: payments, isLoading, isError } = useQuery({
    // Keep this distinct from SuperAdminForceDeleteDialog, whose similarly
    // named query intentionally returns raw payment rows with a different shape.
    queryKey: ['invoice-payments-summary', 'active-receipts', invoiceId],
    enabled: open && !!invoiceId,
    queryFn: async (): Promise<PaymentReceiptRow[]> => {
      const { data, error } = await supabase
        .from('active_payment_receipts')
        .select('id, source_kind, payment_id, collection_id, voucher_id, account_id, collected_amount, applied_amount, credit_amount, payment_method, payment_date, receipt_number, receipt_image_url, created_at')
        .eq('invoice_id', invoiceId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []) as PaymentReceiptRow[];
    },
  });

  const updateMethod = useUpdatePaymentMethod();
  const deletePayment = useDeletePayment();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Xem ảnh chứng từ bằng lightbox tại chỗ (không mở tab mới). images = nhóm ảnh
  // đang xem (các lần thu, hoặc ảnh của 1 phiếu cọc); index null = đóng.
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number | null }>({
    images: [],
    index: null,
  });
  const paymentReceiptUrls = (payments ?? [])
    .filter((p) => p.receipt_image_url)
    .map((p) => p.receipt_image_url as string);

  const handleChangeMethod = (paymentId: string, newMethod: PaymentMethod) => {
    setEditingId(paymentId);
    updateMethod.mutate(
      { payment_id: paymentId, new_method: newMethod },
      { onSettled: () => setEditingId(null) },
    );
  };

  const handleConfirmDelete = () => {
    if (!confirmDeleteId) return;
    const target = (payments ?? []).find((payment) => payment.id === confirmDeleteId);
    if (!target) return;
    setDeletingId(target.id);
    deletePayment.mutate(
      {
        payment_id: target.payment_id,
        collection_id: target.collection_id,
      },
      {
        onSettled: () => {
          setDeletingId(null);
          setConfirmDeleteId(null);
        },
      },
    );
  };

  const confirmTarget = (payments ?? []).find((p) => p.id === confirmDeleteId);
  const confirmIdx = (payments ?? []).findIndex((p) => p.id === confirmDeleteId);
  const confirmCollectionPayments = confirmTarget?.collection_id
    ? (payments ?? []).filter((payment) => payment.collection_id === confirmTarget.collection_id)
    : confirmTarget
      ? [confirmTarget]
      : [];
  const confirmAmount = confirmCollectionPayments.reduce(
    (sum, payment) => sum + (Number(payment.collected_amount) || 0),
    0,
  );

  // Đợt 5: hỏi server TRƯỚC để hộp xác nhận nói đúng chuyện sắp xảy ra — huỷ
  // tại chỗ (không sinh phiếu) hay sinh phiếu đối ứng — và để chặn ngay tại
  // giao diện khi kỳ đã đóng, thay vì bấm rồi mới ăn lỗi.
  const { data: reversalEligibility } = useCollectionReversalEligibility(
    (payments ?? []).map((p) => p.collection_id).filter(Boolean) as string[],
  );
  const confirmEligibility = confirmTarget?.collection_id
    ? reversalEligibility?.[confirmTarget.collection_id]
    : undefined;
  const confirmBlocked = confirmEligibility?.mode === 'BLOCKED';
  const confirmInPlace = confirmEligibility?.mode === 'IN_PLACE_CANCEL';

  if (!invoice) return null;

  const totals = (payments ?? []).reduce(
    (sum, payment) => ({
      collected: sum.collected + (Number(payment.collected_amount) || 0),
      applied: sum.applied + (Number(payment.applied_amount) || 0),
      credit: sum.credit + (Number(payment.credit_amount) || 0),
    }),
    { collected: 0, applied: 0, credit: 0 },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Các lần thanh toán</DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground -mt-2">
          Hoá đơn:{' '}
          <span className="font-medium text-foreground">
            {getInvoiceTitle(invoice)}
          </span>
        </div>

        {(() => {
          const fd = firstInvoiceDetails?.get(invoiceId);
          if (!fd) return null;
          const invFull = fd.rentServiceTotal - fd.rentServicePaid < 1;
          const depFull = fd.depositTotal - fd.depositPaid < 1;
          const full = invFull && depFull;
          // Nền NHẠT theo trạng thái: xanh khi HĐ & cọc đều đủ, đỏ khi còn thiếu.
          const tone = full
            ? { box: 'border-emerald-200 bg-emerald-50/70', title: 'text-emerald-900', sub: 'text-emerald-900/80' }
            : { box: 'border-rose-200 bg-rose-50/70', title: 'text-rose-900', sub: 'text-rose-900/80' };
          return (
            <div className={`rounded-lg border px-3 py-2 text-sm space-y-1 ${tone.box}`}>
              <div className={`font-medium ${tone.title}`}>
                Hoá đơn tháng đầu (ký hợp đồng)
              </div>
              {(fd.rentFrom || fd.rentTo) && (
                <div className={tone.sub}>
                  Kỳ tiền phòng: {fmtDay(fd.rentFrom)} → {fmtDay(fd.rentTo)}
                </div>
              )}
              <div className={`flex flex-wrap gap-x-5 gap-y-0.5 ${tone.sub}`}>
                <span>
                  Tiền Phòng + Dịch Vụ: đã thu{' '}
                  <b className={invFull ? 'text-emerald-700' : 'text-rose-700'}>
                    {fmtVND(fd.rentServicePaid)}
                  </b>{' '}
                  / {fmtVND(fd.rentServiceTotal)}
                </span>
                {fd.depositTotal > 0 && (
                  <span>
                    Cọc: đã đóng{' '}
                    <b className={depFull ? 'text-emerald-700' : 'text-rose-700'}>
                      {fmtVND(fd.depositPaid)}
                    </b>{' '}
                    / {fmtVND(fd.depositTotal)}
                    {fd.depositInInvoice > 0 && (
                      <span className="opacity-80">
                        {' '}({fmtVND(fd.depositInInvoice)} trong HĐ)
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          );
        })()}

        {isError ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-3 text-center text-sm text-red-700"
          >
            Không thể tải các lần thu đang hoạt động. Hệ thống đã khóa thao tác cập nhật và hoàn tác.
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : !payments || payments.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Chưa có phiếu thanh toán nào.
          </p>
        ) : (
          <>
            <ul className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {payments.map((p, idx) => {
                const badgeCls =
                  METHOD_BADGE[p.payment_method] ??
                  'bg-zinc-100 text-zinc-700 border-zinc-200';
                const dateStr = p.payment_date
                  ? format(new Date(p.payment_date), 'dd/MM/yyyy')
                  : '—';
                const timeStr = p.created_at
                  ? format(new Date(p.created_at), 'HH:mm')
                  : '';
                const collectedAmount = Number(p.collected_amount) || 0;
                const appliedAmount = Number(p.applied_amount) || 0;
                const creditAmount = Number(p.credit_amount) || 0;
                const isPureCredit = appliedAmount < 0.01 && creditAmount > 0;
                const canEditLegacyPayment = !p.collection_id && !!p.payment_id;

                return (
                  <li
                    key={p.id}
                    className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white p-3 hover:border-emerald-200 hover:shadow-sm transition"
                  >
                    {/* Số lần */}
                    <div className="shrink-0 h-9 w-9 grid place-items-center rounded-full bg-emerald-50 text-emerald-700 text-sm font-bold">
                      #{idx + 1}
                    </div>

                    {/* Thông tin */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-base font-semibold text-emerald-600">
                            +{fmtVND(collectedAmount)}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                            <span>Áp vào HĐ: {fmtVND(appliedAmount)}</span>
                            <span>Credit: {fmtVND(creditAmount)}</span>
                          </div>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            disabled={editingId === p.id || !canEditLegacyPayment}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold transition hover:opacity-80 hover:shadow-sm disabled:opacity-60 disabled:cursor-not-allowed ${badgeCls}`}
                            title={p.collection_id
                              ? 'Collection V5 đã khóa phương thức; hoàn tác rồi ghi lại nếu cần sửa'
                              : p.payment_id
                                ? 'Click để đổi phương thức thanh toán'
                                : 'Dòng thu không có payment legacy để cập nhật'}
                          >
                            {editingId === p.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : null}
                            {p.payment_method}
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                              Đổi phương thức
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {METHOD_OPTIONS.map((m) => (
                              <DropdownMenuItem
                                key={m}
                                onSelect={() => {
                                  if (p.payment_id && m !== p.payment_method) {
                                    handleChangeMethod(p.payment_id, m);
                                  }
                                }}
                                className="flex items-center justify-between"
                              >
                                <span className="font-semibold">{m}</span>
                                {p.payment_method === m && (
                                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                                )}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {p.collection_id && (
                          <span className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                            V5 khóa sổ
                          </span>
                        )}
                        {isPureCredit && (
                          <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold text-cyan-700">
                            Chỉ giữ credit
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {dateStr}
                        </span>
                        {timeStr && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {timeStr}
                          </span>
                        )}
                      </div>
                      {p.voucher_id ? (
                        <a
                          href={`/income-expense/print/${p.voucher_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition"
                          title="Mở phiếu thu trong sổ Thu/Chi (trang in — xem chi tiết)"
                        >
                          <Receipt className="h-3 w-3" />
                          Phiếu thu{p.receipt_number ? ` ${p.receipt_number}` : ''}
                        </a>
                      ) : (
                        <span
                          className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                          title="Dòng receipt chưa có phiếu thu liên kết — có thể lệch sổ"
                        >
                          <Receipt className="h-3 w-3" />
                          Không có phiếu thu
                        </span>
                      )}
                    </div>

                    {/* Chứng từ */}
                    {p.receipt_image_url ? (
                      <HoverCard openDelay={120} closeDelay={80}>
                        <HoverCardTrigger asChild>
                          <button
                            type="button"
                            onClick={() =>
                              setLightbox({
                                images: paymentReceiptUrls,
                                index: paymentReceiptUrls.indexOf(p.receipt_image_url!),
                              })
                            }
                            className="shrink-0 block"
                            title="Click mở ảnh lớn"
                          >
                            <StorageImage
                              value={p.receipt_image_url}
                              alt="Chứng từ"
                              className="h-14 w-14 object-cover rounded-md border border-zinc-200 hover:border-emerald-400 transition-colors"
                            />
                          </button>
                        </HoverCardTrigger>
                        <HoverCardContent
                          side="left"
                          align="center"
                          sideOffset={12}
                          className="p-1 w-auto border-zinc-200 shadow-2xl"
                        >
                          <StorageImage
                            value={p.receipt_image_url}
                            alt="Chứng từ"
                            className="max-w-[min(80vw,720px)] max-h-[80vh] object-contain rounded"
                          />
                        </HoverCardContent>
                      </HoverCard>
                    ) : (
                      <ReceiptUploadSlot
                        paymentId={p.payment_id ?? ''}
                        disabledReason={p.collection_id
                          ? 'Collection V5 đã khóa chứng từ; chưa có RPC metadata được ủy quyền'
                          : !p.payment_id
                            ? 'Dòng receipt không có payment legacy để gắn chứng từ'
                            : undefined}
                      />
                    )}

                    {/* Nút xoá phiếu thanh toán — đặt ngoài cùng bên phải */}
                    <button
                      type="button"
                      title={p.collection_id
                        ? 'Hoàn tác toàn bộ lần thu V5 (mọi dòng TM/TK/TT)'
                        : 'Hoàn tác phiếu thanh toán cũ'}
                      disabled={deletingId === p.id}
                      onClick={() => setConfirmDeleteId(p.id)}
                      className="shrink-0 grid place-items-center h-9 w-9 rounded-md text-red-600 hover:text-red-700 hover:bg-red-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {deletingId === p.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-emerald-900">
                  Tổng receipt đang hoạt động ({payments.length} dòng)
                </span>
                <span className="text-base font-bold text-emerald-700">
                  {fmtVND(totals.collected)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap justify-end gap-x-4 gap-y-0.5 text-xs text-emerald-900/80">
                <span>Áp vào HĐ: <b>{fmtVND(totals.applied)}</b></span>
                <span>Giữ credit: <b>{fmtVND(totals.credit)}</b></span>
              </div>
            </div>
          </>
        )}

        {/* Ô TÁCH RIÊNG dưới cùng: cọc đóng bằng phiếu thu riêng (ngoài HĐ),
            để không nhầm với các lần thu của hoá đơn ở trên. */}
        {depositVouchers && depositVouchers.length > 0 && (
          <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 space-y-2">
            <div className="text-sm font-medium text-violet-900">
              Cọc bổ sung bằng phiếu thu (ngoài HĐ)
            </div>
            <ul className="space-y-2">
              {depositVouchers.map((v) => (
                <li key={v.id} className="text-sm">
                  <div className="flex items-center gap-3">
                    <a
                      href={`/income-expense/voucher/${v.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-white px-2 py-0.5 text-xs font-medium text-violet-700 hover:bg-violet-100 transition"
                      title="Mở chi tiết phiếu thu cọc"
                    >
                      <Receipt className="h-3 w-3" />
                      {v.code ?? 'Phiếu thu'}
                    </a>
                    <span className="ml-auto font-semibold text-violet-700">
                      {fmtVND(v.totalAmount)}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {v.voucherDate
                      ? format(new Date(v.voucherDate), 'dd/MM/yyyy')
                      : '—'}
                    {v.creatorName ? ` · ${v.creatorName}` : ''}
                    {v.accountName ? ` · sổ ${v.accountName}` : ''}
                  </div>
                  {v.images.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {v.images.map((img, i) => (
                        <HoverCard key={i} openDelay={120} closeDelay={80}>
                          <HoverCardTrigger asChild>
                            <button
                              type="button"
                              onClick={() => setLightbox({ images: v.images, index: i })}
                              className="block shrink-0"
                              title="Click mở ảnh lớn"
                            >
                              <StorageImage
                                value={img}
                                alt="Chứng từ cọc"
                                className="h-10 w-10 object-cover rounded border border-violet-200 hover:border-violet-400 transition-colors"
                              />
                            </button>
                          </HoverCardTrigger>
                          <HoverCardContent
                            side="left"
                            align="center"
                            sideOffset={12}
                            className="p-1 w-auto border-zinc-200 shadow-2xl"
                          >
                            <StorageImage
                              value={img}
                              alt="Chứng từ cọc"
                              className="max-w-[min(80vw,720px)] max-h-[80vh] object-contain rounded"
                            />
                          </HoverCardContent>
                        </HoverCard>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-violet-200 pt-1.5 text-sm">
              <span className="font-medium text-violet-900">Tổng cọc ngoài HĐ</span>
              <span className="font-bold text-violet-700">
                {fmtVND(depositVouchers.reduce((s, v) => s + v.totalAmount, 0))}
              </span>
            </div>
          </div>
        )}

        {/* Lightbox xem ảnh chứng từ — overlay tại chỗ, không mở tab mới */}
        <AttachmentLightbox
          attachments={lightbox.images}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox((s) => ({ ...s, index }))}
        />
      </DialogContent>

      <AlertDialog
        open={!!confirmDeleteId}
        onOpenChange={(v) => {
          if (!v && !deletePayment.isPending) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmBlocked ? 'Không hoàn tác được khoản thu này' : 'Hoàn tác lần thu tiền?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBlocked ? (
                COLLECTION_BLOCK_TEXT[confirmEligibility?.reason_code ?? 'UNKNOWN']
              ) : confirmTarget ? (
                <>
                  Bạn sắp hoàn tác {confirmTarget.collection_id ? 'toàn bộ lần thu chứa phiếu' : 'phiếu thanh toán cũ'}
                  {confirmIdx >= 0 ? ` #${confirmIdx + 1}` : ''}{' '}
                  <span className="font-semibold text-emerald-700">
                    {fmtVND(confirmAmount)}
                  </span>{' '}
                  {confirmTarget.collection_id
                    ? `tiền đã thu giữ (${confirmCollectionPayments.length} dòng TM/TK/TT). `
                    : `(${confirmTarget.payment_method}). `}
                  {confirmInPlace
                    ? 'Phiếu thu sẽ chuyển sang ĐÃ HUỶ và tiền trừ thẳng khỏi sổ quỹ — không sinh thêm phiếu đối ứng nào trong danh sách thu chi.'
                    : 'Hệ thống sẽ tạo phiếu chi đối ứng, giữ nguyên lịch sử gốc và tính lại số đã thu của hóa đơn.'}
                </>
              ) : (
                'Hệ thống sẽ hoàn tác khoản thu và tính lại số đã thu của hóa đơn.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePayment.isPending}>
              {confirmBlocked ? 'Đóng' : 'Huỷ'}
            </AlertDialogCancel>
            {!confirmBlocked && (
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  handleConfirmDelete();
                }}
                disabled={deletePayment.isPending}
                className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
              >
                {deletePayment.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Đang hoàn tác...
                  </>
                ) : (
                  'Hoàn tác'
                )}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};

export default PaymentsSummaryDialog;
