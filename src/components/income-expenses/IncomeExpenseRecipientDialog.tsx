import { useEffect, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { buildRecipientPatch, type VoucherRecipient } from '@/lib/incomeExpenseRecipient';
const schema = z.object({ payerName: z.string(), bankName: z.string(), bankAccount: z.string() }).strict();
type Fields = z.infer<typeof schema>;
interface Props {
  code: string; original: VoucherRecipient; busy: boolean; enabled: boolean; reason?: string | null;
  feedback?: ReactNode; onClose: () => void; onSubmit: (draft: VoucherRecipient) => Promise<unknown>;
}
export function IncomeExpenseRecipientDialog({ code, original, busy, enabled, reason, feedback, onClose, onSubmit }: Props) {
  const { register, handleSubmit, reset, watch, formState } = useForm<Fields>({ resolver: zodResolver(schema),
    defaultValues: { payerName: original.payerName ?? '', bankName: original.bankName ?? '', bankAccount: original.bankAccount ?? '' } });
  useEffect(() => { reset({ payerName: original.payerName ?? '', bankName: original.bankName ?? '', bankAccount: original.bankAccount ?? '' }); },
    [original.payerName, original.bankName, original.bankAccount, reset]);
  const draft = watch();
  const changed = Object.keys(buildRecipientPatch(original, { payerName: draft.payerName ?? '', bankName: draft.bankName ?? '', bankAccount: draft.bankAccount ?? '' })).length > 0;
  const close = () => { if (!busy && !formState.isSubmitting) onClose(); };
  const blocked = busy || formState.isSubmitting;
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent onInteractOutside={event => { if (blocked) event.preventDefault(); }} onEscapeKeyDown={event => { if (blocked) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Sửa người nhận · {code}</DialogTitle>
        <DialogDescription>Cập nhật người nhận và ngân hàng. Phiếu giữ nguyên số tiền và trạng thái duyệt.</DialogDescription></DialogHeader>
      <form onSubmit={handleSubmit(async values => {
        if (blocked || !enabled || !changed) return;
        await onSubmit({ payerName: values.payerName, bankName: values.bankName, bankAccount: values.bankAccount }).catch(() => {
          /* Mutation owns the error state; keep the dialog open for correction. */
        });
      })} className="space-y-4">
        <fieldset disabled={blocked || !enabled} className="space-y-3">
          <div className="space-y-1"><Label htmlFor="recipient-name">Người nhận</Label><Input id="recipient-name" {...register('payerName')} disabled={blocked || !enabled} /></div>
          <div className="space-y-1"><Label htmlFor="recipient-bank">Ngân hàng</Label><Input id="recipient-bank" {...register('bankName')} disabled={blocked || !enabled} /></div>
          <div className="space-y-1"><Label htmlFor="recipient-account">Số tài khoản người nhận</Label><Input id="recipient-account" {...register('bankAccount')} disabled={blocked || !enabled} /></div>
        </fieldset>
        {reason && <p role="status" className="text-sm text-muted-foreground">{reason}</p>}
        {feedback}
        <DialogFooter><Button type="button" variant="outline" disabled={blocked} onClick={close}>Đóng</Button>
          <Button type="submit" disabled={blocked || !enabled || !changed}>Lưu người nhận</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
