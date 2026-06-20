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
import { openStoredFile } from '@/lib/storage';
import { supabase } from '@/integrations/supabase/client';
import { useFirstInvoiceDetails } from '@/hooks/useInvoices';
import { useUpdatePaymentMethod } from '@/hooks/useUpdatePaymentMethod';
import { useUploadPaymentReceipt } from '@/hooks/useUploadPaymentReceipt';
import { useDeletePayment } from '@/hooks/useDeletePayment';
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

interface PaymentRow {
  id: string;
  amount: number;
  payment_method: PaymentMethod | string;
  payment_date: string;
  receipt_image_url: string | null;
  created_at: string;
}

const METHOD_OPTIONS: PaymentMethod[] = ['TM', 'TT', 'TK'];

/** Slot upload ảnh chứng từ cho 1 phiếu thu chưa có ảnh.
 *  - Click → mở file picker
 *  - Hover + Ctrl/Cmd+V → paste ảnh từ clipboard
 *  Sau upload sẽ append vào income_expenses.attachments của phiếu Thu/Chi
 *  liên kết. */
const ReceiptUploadSlot = ({ paymentId }: { paymentId: string }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadPaymentReceipt();
  const handleFile = (file: File) => upload.mutate({ payment_id: paymentId, file });
  const paste = useClipboardImagePaste({
    enabled: !upload.isPending,
    onFiles: (files) => {
      if (files[0]) handleFile(files[0]);
    },
  });

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
  const { data: payments, isLoading } = useQuery({
    queryKey: ['invoice-payments-summary', invoiceId],
    enabled: open && !!invoiceId,
    queryFn: async (): Promise<PaymentRow[]> => {
      const { data, error } = await (supabase as any)
        .from('payments')
        .select('id, amount, payment_method, payment_date, receipt_image_url, created_at')
        .eq('invoice_id', invoiceId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []) as PaymentRow[];
    },
  });

  // Phiếu thu sổ quỹ liên kết với từng payment (income_expenses.payment_id).
  // 1 query .in() cho cả danh sách payment — không N+1. Payment KHÔNG có phiếu
  // thu liên kết là dấu hiệu lệch sổ → hiện badge cảnh báo.
  const paymentIds = (payments ?? []).map((p) => p.id);
  const { data: ieByPayment } = useQuery({
    queryKey: ['invoice-payments-ie-links', invoiceId, paymentIds],
    enabled: open && paymentIds.length > 0,
    queryFn: async (): Promise<Map<string, { id: string; code: string }>> => {
      const { data, error } = await (supabase as any)
        .from('income_expenses')
        .select('id, code, payment_id')
        .in('payment_id', paymentIds)
        .is('deleted_at', null);
      if (error) throw error;
      const map = new Map<string, { id: string; code: string }>();
      for (const row of (data ?? []) as Array<{
        id: string;
        code: string;
        payment_id: string;
      }>) {
        map.set(row.payment_id, { id: row.id, code: row.code });
      }
      return map;
    },
  });

  const updateMethod = useUpdatePaymentMethod();
  const deletePayment = useDeletePayment();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleChangeMethod = (paymentId: string, newMethod: PaymentMethod) => {
    setEditingId(paymentId);
    updateMethod.mutate(
      { payment_id: paymentId, new_method: newMethod },
      { onSettled: () => setEditingId(null) },
    );
  };

  const handleConfirmDelete = () => {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    setDeletingId(id);
    deletePayment.mutate(
      { payment_id: id },
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

  if (!invoice) return null;

  const total = (payments ?? []).reduce(
    (sum, p) => sum + (Number(p.amount) || 0),
    0,
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
          const invFull = fd.invoiceTotal - fd.invoicePaid < 1;
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
                    {fmtVND(fd.invoicePaid)}
                  </b>{' '}
                  / {fmtVND(fd.invoiceTotal)}
                </span>
                {fd.depositTotal > 0 && (
                  <span>
                    Cọc: đã đóng{' '}
                    <b className={depFull ? 'text-emerald-700' : 'text-rose-700'}>
                      {fmtVND(fd.depositPaid)}
                    </b>{' '}
                    / {fmtVND(fd.depositTotal)}
                  </span>
                )}
              </div>
            </div>
          );
        })()}

        {isLoading ? (
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
                const ieLink = ieByPayment?.get(p.id);

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
                        <div className="text-base font-semibold text-emerald-600">
                          +{fmtVND(Number(p.amount) || 0)}
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            disabled={editingId === p.id}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold transition hover:opacity-80 hover:shadow-sm disabled:opacity-60 disabled:cursor-not-allowed ${badgeCls}`}
                            title="Click để đổi phương thức thanh toán"
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
                                  if (m !== p.payment_method) {
                                    handleChangeMethod(p.id, m);
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
                      {/* Deep-link sang phiếu thu sổ quỹ liên kết — chỉ render
                          sau khi query link đã có kết quả để tránh chớp badge
                          "không có phiếu thu" lúc đang tải. */}
                      {ieByPayment &&
                        (ieLink ? (
                          <a
                            href={`/income-expense/print/${ieLink.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 hover:border-blue-300 transition"
                            title="Mở phiếu thu trong sổ Thu/Chi (trang in — xem chi tiết)"
                          >
                            <Receipt className="h-3 w-3" />
                            Phiếu thu {ieLink.code}
                          </a>
                        ) : (
                          <span
                            className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                            title="Payment này chưa có phiếu thu trong sổ Thu/Chi — có thể lệch sổ"
                          >
                            <Receipt className="h-3 w-3" />
                            Không có phiếu thu
                          </span>
                        ))}
                    </div>

                    {/* Chứng từ */}
                    {p.receipt_image_url ? (
                      <HoverCard openDelay={120} closeDelay={80}>
                        <HoverCardTrigger asChild>
                          <button
                            type="button"
                            onClick={() => openStoredFile(p.receipt_image_url!)}
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
                      <ReceiptUploadSlot paymentId={p.id} />
                    )}

                    {/* Nút xoá phiếu thanh toán — đặt ngoài cùng bên phải */}
                    <button
                      type="button"
                      title="Xoá phiếu thanh toán này (xoá luôn phiếu thu liên kết)"
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

            <div className="mt-2 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2">
              <span className="text-sm font-medium text-emerald-900">
                Tổng đã thanh toán ({payments.length} lần)
              </span>
              <span className="text-base font-bold text-emerald-700">
                {fmtVND(total)}
              </span>
            </div>
          </>
        )}
      </DialogContent>

      <AlertDialog
        open={!!confirmDeleteId}
        onOpenChange={(v) => {
          if (!v && !deletePayment.isPending) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xoá phiếu thanh toán?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget ? (
                <>
                  Bạn sắp xoá phiếu thanh toán
                  {confirmIdx >= 0 ? ` #${confirmIdx + 1}` : ''}{' '}
                  <span className="font-semibold text-emerald-700">
                    {fmtVND(Number(confirmTarget.amount) || 0)}
                  </span>{' '}
                  ({confirmTarget.payment_method}). Phiếu Thu liên kết trong sổ
                  Thu/Chi cũng sẽ bị xoá. Thao tác này không thể hoàn tác.
                </>
              ) : (
                'Phiếu Thu liên kết trong sổ Thu/Chi cũng sẽ bị xoá. Thao tác này không thể hoàn tác.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePayment.isPending}>
              Huỷ
            </AlertDialogCancel>
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
                  Đang xoá...
                </>
              ) : (
                'Xoá phiếu'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
};

export default PaymentsSummaryDialog;
