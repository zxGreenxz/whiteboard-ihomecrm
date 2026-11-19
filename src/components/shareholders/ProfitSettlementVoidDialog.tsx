// Hộp HUỶ một lần chốt chi lợi nhuận KHÔNG có phiếu tiền (W3). Lần chốt không ra tiền có hiệu lực ngay, một
// người làm — muốn bỏ thì huỷ ở đây, có lý do (8–1000 ký tự). Huỷ xong, phần lợi nhuận đã ghi nhận trở lại
// "lợi nhuận chưa chi" và phần đã khấu trừ trở lại "tạm ứng đang có".
// Lần chốt CÓ phiếu tiền không huỷ ở đây: huỷ phiếu chi đó bằng hộp huỷ phiếu, lần chốt tự hết hiệu lực.

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
import { useVoidProfitSettlement } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { focusFirstError } from '@/lib/formErrors';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { PROFIT_REASON_MAX, settlementVoidFormSchema, type SettlementVoidFormValues } from '@/lib/profitLedger/forms';
import { settleMonthLabel } from '@/lib/profitLedger/positionView';
import { formatVND } from '@/lib/utils';

export interface ProfitSettlementVoidTarget {
  settlementId: string;
  /** Công ty của cổ đông — khoá chống gửi trùng gắn theo công ty này. */
  organizationId: string;
  subjectName: string | null;
  throughMonth: string;
  recognizedAmount: number;
  advanceOffsetAmount: number;
}

export interface ProfitSettlementVoidDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ProfitSettlementVoidTarget | null;
  /** Gọi sau khi huỷ xong (để hộp chốt tải lại xem trước). */
  onVoided?: () => void;
}

export function ProfitSettlementVoidDialog({ open, onOpenChange, target, onVoided }: ProfitSettlementVoidDialogProps) {
  const voidMut = useVoidProfitSettlement();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  // Lần huỷ chưa rõ kết quả — theo TỪNG lần chốt: giữ lý do đã gửi để "Kiểm tra lại" gửi lại y nguyên.
  const [blocked, setBlocked] = useState<{ settlementId: string; reason: string; failure: ProfitLedgerErrorInfo } | null>(null);
  const form = useForm<SettlementVoidFormValues>({ resolver: zodResolver(settlementVoidFormSchema), defaultValues: { reason: '' } });
  const { reset } = form;
  const reason = useWatch({ control: form.control, name: 'reason' }) ?? '';
  const settlementId = target?.settlementId ?? null;
  const saveBlocked = !!blocked && blocked.settlementId === settlementId;

  useEffect(() => {
    if (!open) return;
    if (blocked && blocked.settlementId === settlementId) {
      reset({ reason: blocked.reason });
      setFailure(blocked.failure);
      return;
    }
    reset({ reason: '' });
    setFailure(null);
    // Chỉ làm mới khi mở hộp hoặc đổi lần chốt, không theo từng lần render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settlementId]);

  const submit = async (values: SettlementVoidFormValues) => {
    if (!target || voidMut.isPending) return;
    setFailure(null);
    try {
      await voidMut.mutateAsync({ organizationId: target.organizationId, settlementId: target.settlementId, reason: values.reason });
      setBlocked(null);
      toast.success(`Đã huỷ lần chốt đến hết ${settleMonthLabel(target.throughMonth)}${target.subjectName ? ` của ${target.subjectName}` : ''}. Lợi nhuận và tạm ứng trở lại như trước lần chốt.`);
      onVoided?.();
      onOpenChange(false);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'settle_void');
      setFailure(info);
      setBlocked(info.kind === 'UNKNOWN_OUTCOME' ? { settlementId: target.settlementId, reason: values.reason, failure: info } : null);
      // Lần chốt đã huỷ từ trước / vừa có phiếu: để hộp chốt tải lại danh sách.
      if (info.reload && info.kind !== 'UNKNOWN_OUTCOME') onVoided?.();
    }
  };

  return (
    <Dialog open={open && !!target} onOpenChange={(next) => { if (!voidMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={dialogRef} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Huỷ lần chốt chi lợi nhuận</DialogTitle>
          <DialogDescription>
            {target ? `${target.subjectName ?? '—'} · chốt đến hết ${settleMonthLabel(target.throughMonth)}` : null}
          </DialogDescription>
        </DialogHeader>
        {target && (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(submit, (errors) => { void focusFirstError(errors, { root: dialogRef.current }); })}
              className="space-y-4"
              noValidate
            >
              <p className="rounded-md border bg-muted/30 p-3 text-sm" data-testid="profit-settlement-void-effect">
                Lần chốt này không ra tiền: đã ghi nhận {formatVND(target.recognizedAmount)} lợi nhuận và khấu trừ{' '}
                {formatVND(target.advanceOffsetAmount)} tạm ứng. Huỷ thì hai số đó trở lại như trước lần chốt; không có tiền di chuyển.
              </p>
              <fieldset disabled={saveBlocked || voidMut.isPending}>
                <FormField control={form.control} name="reason" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Lý do huỷ chốt <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} maxLength={PROFIT_REASON_MAX} aria-invalid={!!fieldState.error}
                        placeholder="Vì sao huỷ lần chốt này (để còn đối soát về sau)" />
                    </FormControl>
                    <p className="text-right text-xs text-muted-foreground">{reason.trim().length}/{PROFIT_REASON_MAX}</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </fieldset>
              {failure && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{failure.message}</p>}
              <DialogFooter className="flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={voidMut.isPending} onClick={() => onOpenChange(false)}>Đóng</Button>
                {saveBlocked ? (
                  <Button type="submit" variant="secondary" disabled={voidMut.isPending}>
                    {voidMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                  </Button>
                ) : (
                  <Button type="submit" variant="destructive" disabled={voidMut.isPending}>
                    {voidMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Huỷ chốt
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

export default ProfitSettlementVoidDialog;
