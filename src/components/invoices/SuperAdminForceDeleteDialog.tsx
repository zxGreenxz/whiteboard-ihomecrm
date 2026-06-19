import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import type { InvoiceWithRelations } from '@/types/invoice';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations | null;
  onConfirm: () => void;
  isPending?: boolean;
}

interface PaymentRow {
  id: string;
  amount: number;
  payment_method: 'TM' | 'TT' | 'TK' | string;
  payment_date: string;
  receipt_number: string | null;
  created_at: string;
}

const fmtVND = (n: number) =>
  new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n);

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Nháp',
  APPROVED: 'Đã duyệt',
  PARTIAL_PAID: 'Thanh toán một phần',
  PAID: 'Đã thanh toán',
  OVERDUE: 'Quá hạn',
  CANCELLED: 'Đã huỷ',
};

const METHOD_BADGE: Record<string, string> = {
  TM: 'bg-amber-50 text-amber-700 border-amber-200',
  TK: 'bg-blue-50 text-blue-700 border-blue-200',
  TT: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CT: 'bg-violet-50 text-violet-700 border-violet-200',
};

const CONFIRM_WORD = 'XOA';

const SuperAdminForceDeleteDialog = ({
  open,
  onOpenChange,
  invoice,
  onConfirm,
  isPending,
}: Props) => {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const invoiceId = invoice?.id ?? '';
  const { data: payments, isLoading } = useQuery({
    queryKey: ['invoice-payments-summary', invoiceId],
    enabled: open && !!invoiceId,
    queryFn: async (): Promise<PaymentRow[]> => {
      const { data, error } = await (supabase as any)
        .from('payments')
        .select('id, amount, payment_method, payment_date, receipt_number, created_at')
        .eq('invoice_id', invoiceId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []) as PaymentRow[];
    },
  });

  if (!invoice) return null;

  const paymentList = payments ?? [];
  const totalPaid = paymentList.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const canConfirm = typed.trim().toUpperCase() === CONFIRM_WORD && !isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            Xoá vĩnh viễn hoá đơn
          </DialogTitle>
          <DialogDescription>
            Thao tác chỉ dành cho super admin. Hoá đơn sẽ chuyển sang trạng thái Đã huỷ và các
            payment liên quan sẽ bị xoá vĩnh viễn.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              <span className="text-muted-foreground">Số HĐ:</span>{' '}
              <span className="font-medium">{invoice.invoice_number || invoice.id.slice(0, 8)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Kỳ thanh toán:</span>{' '}
              <span className="font-medium">{invoice.billing_month || '—'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Phòng:</span>{' '}
              <span className="font-medium">
                {[invoice.building?.name, invoice.room?.name].filter(Boolean).join(' / ') || '—'}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Trạng thái:</span>{' '}
              <span className="font-medium">{STATUS_LABEL[invoice.status] || invoice.status}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Tổng tiền:</span>{' '}
              <span className="font-medium">{fmtVND(invoice.total_amount || 0)}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Đã thu:</span>{' '}
              <span className="font-medium text-emerald-700">
                {fmtVND(invoice.paid_amount || 0)}
              </span>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Payment sẽ bị xoá vĩnh viễn</div>
          {isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : paymentList.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-200 p-3 text-center text-sm text-muted-foreground">
              Hoá đơn chưa có payment nào.
            </div>
          ) : (
            <div className="rounded-md border border-zinc-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Ngày</th>
                    <th className="px-3 py-2 text-left">Số phiếu</th>
                    <th className="px-3 py-2 text-left">Phương thức</th>
                    <th className="px-3 py-2 text-right">Số tiền</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentList.map((p) => {
                    const badgeCls =
                      METHOD_BADGE[p.payment_method] ??
                      'bg-zinc-100 text-zinc-700 border-zinc-200';
                    return (
                      <tr key={p.id} className="border-t border-zinc-200">
                        <td className="px-3 py-2">
                          {p.payment_date
                            ? format(new Date(p.payment_date), 'dd/MM/yyyy')
                            : '—'}
                        </td>
                        <td className="px-3 py-2">{p.receipt_number || '—'}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeCls}`}
                          >
                            {p.payment_method}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium">
                          {fmtVND(Number(p.amount) || 0)}
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="bg-red-50 border-t border-red-200">
                    <td colSpan={3} className="px-3 py-2 text-right font-semibold text-red-700">
                      Tổng payment sẽ bị xoá ({paymentList.length} phiếu)
                    </td>
                    <td className="px-3 py-2 text-right font-bold text-red-700">
                      {fmtVND(totalPaid)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            Cảnh báo
          </div>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            <li>Các payment trên sẽ bị xoá <b>VĨNH VIỄN</b>, không thể phục hồi.</li>
            <li>Số tiền dư (excess credit) phát sinh từ HĐ này (nếu có) cũng sẽ bị xoá.</li>
            <li>
              Hoá đơn chuyển sang trạng thái <b>Đã huỷ</b>. Có thể phục hồi hoá đơn nhưng
              payment đã mất sẽ không quay lại.
            </li>
          </ul>
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor="confirm-input">
            Gõ <span className="font-mono text-red-700 font-bold">{CONFIRM_WORD}</span> để xác nhận
          </label>
          <Input
            id="confirm-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM_WORD}
            autoComplete="off"
            className="mt-1"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Huỷ bỏ
          </Button>
          <Button variant="destructive" disabled={!canConfirm} onClick={onConfirm}>
            {isPending ? 'Đang xoá...' : 'Xoá vĩnh viễn'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SuperAdminForceDeleteDialog;
