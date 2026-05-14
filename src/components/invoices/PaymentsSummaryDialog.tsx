import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceWithRelations } from '@/types/invoice';
import { Image as ImageIcon } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
}

interface PaymentRow {
  id: string;
  amount: number;
  payment_method: 'TM' | 'TT' | 'TK' | string;
  payment_date: string;
  receipt_image_url: string | null;
  created_at: string;
}

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const METHOD_LABEL: Record<string, string> = {
  TM: 'Tiền mặt',
  TT: 'Thanh toán',
  TK: 'Chuyển khoản',
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

  if (!invoice) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Các lần thanh toán</DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground -mt-2">
          Hoá đơn: <span className="font-medium text-foreground">{invoice.invoice_number}</span>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !payments || payments.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Chưa có phiếu thanh toán nào.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200">
            {payments.map((p) => {
              const method = METHOD_LABEL[p.payment_method] ?? p.payment_method;
              const dateStr = p.payment_date
                ? format(new Date(p.payment_date), 'dd/MM/yyyy')
                : '—';
              const timeStr = p.created_at
                ? format(new Date(p.created_at), 'HH:mm')
                : '';
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-emerald-600">
                      +{fmtVND(Number(p.amount) || 0)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {method} · {dateStr}
                      {timeStr ? ` · ${timeStr}` : ''}
                    </div>
                  </div>
                  {p.receipt_image_url ? (
                    <a
                      href={p.receipt_image_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 group relative block"
                      title="Click mở ảnh lớn"
                    >
                      <img
                        src={p.receipt_image_url}
                        alt="Chứng từ"
                        className="h-10 w-10 object-cover rounded border border-zinc-200 transition-transform duration-200 group-hover:scale-[6] group-hover:z-50 group-hover:shadow-2xl group-hover:relative"
                      />
                    </a>
                  ) : (
                    <div className="shrink-0 h-10 w-10 grid place-items-center rounded border border-dashed border-zinc-200 text-zinc-300">
                      <ImageIcon className="h-4 w-4" />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default PaymentsSummaryDialog;
