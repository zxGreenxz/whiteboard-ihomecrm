import { useState } from 'react';
import { format } from 'date-fns';
import { History, Loader2, Unlock } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { QueryRegion } from '@/components/errors/QueryRegion';
import { useOperationFormFeedback } from '@/hooks/useOperationFormFeedback';
import { useCashbookReopeningState, useReopenCashbook } from '@/hooks/useCashbookReopening';
import { CASHBOOK_REOPENING_RULES } from '@/lib/cashbookReopening';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cashbookId: string | null;
  cashbookName?: string | null;
}

const displayDate = (value: string) => format(new Date(`${value}T00:00:00`), 'dd/MM/yyyy');

function ReopeningContent({ onOpenChange, cashbookId, cashbookName }: Props & { cashbookId: string }) {
  const state = useCashbookReopeningState(cashbookId);
  const reopen = useReopenCashbook();
  const [reason, setReason] = useState('');
  const feedback = useOperationFormFeedback('mở khóa sổ quỹ', {rules: CASHBOOK_REOPENING_RULES});
  const ready = !state.isLoading && !state.isError && !!state.data;
  const canReopen = ready && state.data?.can_reopen === true && !!state.data.lock_date;
  const pendingClosure = state.data?.blocked_reason === 'PENDING_CLOSURE';
  const busy = feedback.saving || reopen.isPending;

  return (
    <Dialog open onOpenChange={(open) => feedback.close(() => onOpenChange(open))}>
      <DialogContent ref={feedback.root} className="max-w-lg max-h-[88dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Unlock className="h-4 w-4" />Mở khóa &amp; lịch sử — {cashbookName || 'sổ quỹ'}</DialogTitle>
          <DialogDescription>Chỉ chủ tổ chức được mở khóa sổ. Người thực hiện, thời điểm và lý do được lưu trong lịch sử.</DialogDescription>
        </DialogHeader>

        {feedback.notice}
        <QueryRegion label="trạng thái mở khóa sổ" queries={[state]} skeleton="lines" rows={3}>
          {ready && state.data && (
            <div className="space-y-4">
              <p className="text-sm">{state.data.lock_date ? `Sổ đang khóa đến ngày ${displayDate(state.data.lock_date)}.` : 'Sổ hiện không bị khóa.'}</p>
              {state.data.lock_date && !state.data.can_reopen && <p className="text-sm text-muted-foreground">Bạn không có quyền mở khóa sổ này. Chỉ chủ của tổ chức sở hữu sổ được thực hiện.</p>}
              {canReopen && pendingClosure && <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Sổ có đề nghị chốt đang chờ. Xử lý đề nghị đó trước khi mở khóa.</p>}

              {canReopen && (
                <>
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                    Mở khóa cho phép xử lý lại các phiếu trong kỳ đã chốt theo quyền hiện có. Biên bản chốt cũ được giữ nguyên. Khóa tháng lợi nhuận và khóa phiên bàn giao vẫn có hiệu lực.
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cashbook-reopen-reason">Lý do mở khóa <span aria-hidden="true">*</span></Label>
                    <Textarea id="cashbook-reopen-reason" {...feedback.field('reason')} value={reason}
                      onChange={(event) => setReason(event.target.value)} rows={3} maxLength={1000} disabled={busy || feedback.blocked}
                      placeholder="Nêu nội dung cần kiểm tra hoặc điều chỉnh (ít nhất 10 ký tự)" />
                    {feedback.issue('reason')}
                  </div>
                </>
              )}

              <section aria-label="Lịch sử mở khóa" className="space-y-2 border-t pt-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" />Lịch sử mở khóa</h3>
                {state.data.history.length === 0 ? <p className="text-sm text-muted-foreground">Chưa có lần mở khóa nào.</p> : (
                  <ol className="space-y-3">
                    {state.data.history.map((entry) => (
                      <li key={entry.id} className="rounded-md border p-3 text-sm">
                        <p className="font-medium">{entry.reopened_by_name || 'Chủ tổ chức'} · {format(new Date(entry.reopened_at), 'dd/MM/yyyy HH:mm')}</p>
                        <p className="text-muted-foreground">Mở kỳ đã khóa đến {displayDate(entry.previous_lock_date)}</p>
                        <p className="mt-1 whitespace-pre-wrap break-words">{entry.reason}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}
        </QueryRegion>

        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={() => feedback.close(() => onOpenChange(false))}>Đóng</Button>
          {canReopen && (
            <Button disabled={busy || feedback.blocked || pendingClosure} onClick={() => void feedback.run(async () => {
              const current = state.data;
              if (!current?.can_reopen || !current.lock_date) throw new Error('Chưa xác nhận được trạng thái khóa sổ.');
              if (current.blocked_reason === 'PENDING_CLOSURE') throw new Error('[REOPEN_PENDING_CLOSURE] Sổ có đề nghị chốt đang chờ.');
              await reopen.mutateAsync({cashbookId, cashbookName, reason: reason.trim(), expectedLockDate: current.lock_date, expectedRevision: current.revision});
            }, () => onOpenChange(false), {reason: reason.trim().length < 10 ? 'Nhập lý do mở khóa ít nhất 10 ký tự.' : reason.trim().length > 1000 ? 'Lý do mở khóa không được dài quá 1000 ký tự.' : undefined})}>
              {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Đang mở khóa…</> : 'Xác nhận mở khóa'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ReopenCashbookDialog(props: Props) {
  return props.open && props.cashbookId ? <ReopeningContent key={props.cashbookId} {...props} cashbookId={props.cashbookId} /> : null;
}
