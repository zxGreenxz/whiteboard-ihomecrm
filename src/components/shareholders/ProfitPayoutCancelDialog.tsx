// Hộp HUỶ phiếu chi theo sổ tổng (E6) — dùng chung cho trang lợi nhuận, Thu chi, Hộp duyệt.
// Phiếu chi lợi nhuận cổ đông / lương điều hành lập theo sổ tổng chỉ bỏ được ở đây, có lý do:
//   đã chi tiền ⇒ máy chủ tạo bút toán đảo, tiền về đúng sổ quỹ của phiếu;
//   đã duyệt chưa chi / đang chờ ⇒ huỷ phiếu (và yêu cầu duyệt), không có tiền di chuyển.
// LUÔN gửi trạng thái đang thấy (p_expected_state): phiếu vừa được duyệt / chi bởi người khác ⇒ máy chủ
// từ chối (PT409), hộp hiện trạng thái mới để người dùng quyết định lại. Huỷ chạy được ở MỌI trạng
// thái của công tắc sổ tổng (kể cả đóng băng).

import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useCancelProfitLedgerPayout } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { focusFirstError } from '@/lib/formErrors';
import type { LedgerCancelResult } from '@/lib/profitLedger/actionReaders';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { cancelFormSchema, PROFIT_REASON_MAX, type CancelFormValues } from '@/lib/profitLedger/forms';
import {
  cancelBalanceSentence, cancelEffectSentence, expectedCancelState,
  type ProfitCancelExpectedState, type ProfitPayoutCancelTarget,
} from '@/lib/profitLedger/vouchers';
import { formatVND } from '@/lib/utils';

export interface ProfitPayoutCancelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dựng bằng cancelTargetFromLedgerEntry / cancelTargetFromMyPayout / cancelTargetFromDetail. */
  target: ProfitPayoutCancelTarget | null;
  /** Gọi sau khi huỷ xong (kể cả "phiếu đã huỷ từ trước"). */
  onCancelled?: (result: LedgerCancelResult) => void;
}

type ObservedState = ProfitCancelExpectedState | 'CANCELLED';

const STATE_FROM_DETAIL: ReadonlySet<string> = new Set(['PENDING', 'APPROVED_UNPOSTED', 'POSTED', 'CANCELLED']);

export function ProfitPayoutCancelDialog({ open, onOpenChange, target, onCancelled }: ProfitPayoutCancelDialogProps) {
  const cancelMut = useCancelProfitLedgerPayout();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  // Lần huỷ chưa rõ kết quả — theo TỪNG phiếu (hộp mount một lần cho cả danh sách Thu chi): giữ lý do
  // và trạng thái đã gửi để "Kiểm tra lại" gửi lại y nguyên; phiếu khác vẫn huỷ được bình thường.
  const [blocked, setBlocked] = useState<{ voucherId: string; reason: string; state: ObservedState; failure: ProfitLedgerErrorInfo } | null>(null);
  const initialState = target ? expectedCancelState(target.approvalStatus, target.postingStatus) : null;
  const [observed, setObserved] = useState<ObservedState | null>(initialState);
  const form = useForm<CancelFormValues>({ resolver: zodResolver(cancelFormSchema), defaultValues: { reason: '' } });
  const { reset } = form;
  const reason = useWatch({ control: form.control, name: 'reason' }) ?? '';

  const voucherId = target?.voucherId ?? null;
  const saveBlocked = !!blocked && blocked.voucherId === voucherId;
  useEffect(() => {
    if (!open) return;
    if (blocked && blocked.voucherId === voucherId) {
      reset({ reason: blocked.reason });
      setObserved(blocked.state);
      setFailure(blocked.failure);
      return;
    }
    reset({ reason: '' });
    setFailure(null);
    setObserved(initialState);
    // Chỉ làm mới khi mở hộp hoặc đổi phiếu, không theo từng lần render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, voucherId]);

  const submit = async (values: CancelFormValues) => {
    if (!target || cancelMut.isPending || !observed || observed === 'CANCELLED') return;
    setFailure(null);
    try {
      const result = await cancelMut.mutateAsync({
        voucherId: target.voucherId,
        organizationId: target.organizationId,
        reason: values.reason,
        expectedState: observed,
      });
      setBlocked(null);
      const code = target.code ? `phiếu ${target.code}` : 'phiếu';
      const balance = cancelBalanceSentence(target.kind, result.balance_after);
      if (!result.changed) toast.info(`${target.code ? `Phiếu ${target.code}` : 'Phiếu'} đã được huỷ trước đó. ${balance}`);
      else if (result.cancellation_kind === 'CANCELLED_AFTER_POSTING') {
        toast.success(`Đã huỷ ${code} và đảo bút toán — tiền về sổ ${target.accountName ?? 'quỹ của phiếu'}. ${balance}`);
      } else toast.success(`Đã huỷ ${code}. ${balance}`);
      onCancelled?.(result);
      onOpenChange(false);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'cancel');
      setFailure(info);
      setBlocked(info.kind === 'UNKNOWN_OUTCOME' ? { voucherId: target.voucherId, reason: values.reason, state: observed, failure: info } : null);
      if (info.kind === 'CANCEL_STATE_CHANGED') {
        const actual = info.detail?.actual;
        // Hiện trạng thái mới; người dùng bấm lại thì gửi đúng trạng thái mới đó (lần PT409 không để lại gì).
        if (typeof actual === 'string' && STATE_FROM_DETAIL.has(actual)) setObserved(actual as ObservedState);
      }
    }
  };

  const alreadyCancelled = observed === 'CANCELLED';
  const unknownState = !!target && observed === null;
  const title = target?.kind === 'MANAGER' ? 'Huỷ phiếu lương điều hành' : 'Huỷ phiếu chi lợi nhuận';

  return (
    <Dialog open={open && !!target} onOpenChange={(next) => { if (!cancelMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={dialogRef} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {target ? `${target.code ? `Phiếu ${target.code}` : 'Phiếu'} · ${target.subjectName ?? '—'} · ${formatVND(target.amount)}` : null}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(submit, (errors) => { void focusFirstError(errors, { root: dialogRef.current }); })}
              className="space-y-4"
              noValidate
            >
              {alreadyCancelled ? (
                <p role="status" className="rounded-md border p-3 text-sm">Phiếu đã được huỷ. Đóng hộp và tải lại danh sách.</p>
              ) : unknownState ? (
                <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
                  Chưa xác định được trạng thái phiếu — tải lại phiếu rồi mở lại hộp huỷ.
                </p>
              ) : (
                <p className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="profit-cancel-effect">
                  {cancelEffectSentence(observed as ProfitCancelExpectedState, target.accountName)}
                </p>
              )}
              <fieldset disabled={saveBlocked || cancelMut.isPending || alreadyCancelled || unknownState}>
                <FormField control={form.control} name="reason" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Lý do huỷ <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} maxLength={PROFIT_REASON_MAX} aria-invalid={!!fieldState.error}
                        placeholder="Vì sao huỷ phiếu này (để còn đối soát về sau)" />
                    </FormControl>
                    <p className="text-right text-xs text-muted-foreground">{reason.trim().length}/{PROFIT_REASON_MAX}</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </fieldset>
              {failure && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{failure.message}</p>}
              <DialogFooter className="flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={cancelMut.isPending} onClick={() => onOpenChange(false)}>Đóng</Button>
                {saveBlocked ? (
                  <Button type="submit" variant="secondary" disabled={cancelMut.isPending}>
                    {cancelMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                  </Button>
                ) : (
                  <Button type="submit" variant="destructive" disabled={cancelMut.isPending || alreadyCancelled || unknownState}>
                    {cancelMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Huỷ phiếu
                  </Button>
                )}
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ProfitPayoutCancelDialog;
