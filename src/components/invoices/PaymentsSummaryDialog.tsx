import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { supabase } from '@/integrations/supabase/client';
import { useUpdatePaymentMethod } from '@/hooks/useUpdatePaymentMethod';
import type { InvoiceWithRelations } from '@/types/invoice';
import { getInvoiceTitle } from '@/lib/invoiceUtils';
import { Image as ImageIcon, Calendar, Clock, Loader2, Check } from 'lucide-react';

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

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const METHOD_BADGE: Record<string, string> = {
  TM: 'bg-amber-50 text-amber-700 border-amber-200',
  TK: 'bg-blue-50 text-blue-700 border-blue-200',
  TT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

const PaymentsSummaryDialog = ({ open, onOpenChange, invoice }: Props) => {
  const invoiceId = invoice?.id ?? '';
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

  const updateMethod = useUpdatePaymentMethod();
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleChangeMethod = (paymentId: string, newMethod: PaymentMethod) => {
    setEditingId(paymentId);
    updateMethod.mutate(
      { payment_id: paymentId, new_method: newMethod },
      { onSettled: () => setEditingId(null) },
    );
  };

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
                    </div>

                    {/* Chứng từ */}
                    {p.receipt_image_url ? (
                      <HoverCard openDelay={120} closeDelay={80}>
                        <HoverCardTrigger asChild>
                          <a
                            href={p.receipt_image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 block"
                            title="Click mở ảnh lớn"
                          >
                            <img
                              src={p.receipt_image_url}
                              alt="Chứng từ"
                              className="h-14 w-14 object-cover rounded-md border border-zinc-200 hover:border-emerald-400 transition-colors"
                            />
                          </a>
                        </HoverCardTrigger>
                        <HoverCardContent
                          side="left"
                          align="center"
                          sideOffset={12}
                          className="p-1 w-auto border-zinc-200 shadow-2xl"
                        >
                          <img
                            src={p.receipt_image_url}
                            alt="Chứng từ"
                            className="max-w-[min(80vw,720px)] max-h-[80vh] object-contain rounded"
                          />
                        </HoverCardContent>
                      </HoverCard>
                    ) : (
                      <div className="shrink-0 h-14 w-14 grid place-items-center rounded-md border border-dashed border-zinc-200 text-zinc-300">
                        <ImageIcon className="h-5 w-5" />
                      </div>
                    )}
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
    </Dialog>
  );
};

export default PaymentsSummaryDialog;
