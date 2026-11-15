// Hộp "Xác nhận phần lương" (E16) — phiếu lương của một cổ đông bị máy ghi "cần chủ xem lại":
// chủ xác nhận phần lợi nhuận nằm trong phiếu (đầu tư Y) và phần lương đã giữ lại bù tạm ứng (D).
// Máy gợi ý Y; chủ sửa nếu cần và ghi lý do. Trần theo tháng chỉ máy chủ biết (lỗi RESOLVE_RANGE trả
// lại trần); ở đây chặn sớm Y − D vượt tiền phiếu lương khi đọc được tiền phiếu.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useIncomeExpenseDetail } from '@/hooks/income-expenses/detailRead';
import { useResolveSalaryProfitLine } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { focusFirstError } from '@/lib/formErrors';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { makeResolveFormSchema, PROFIT_REASON_MAX, type ResolveFormValues } from '@/lib/profitLedger/forms';
import type { ShareholderLedgerEntry } from '@/lib/profitLedger/ledgerReaders';
import { ledgerBalanceText, ledgerMonthLabel } from '@/lib/profitLedger/ownerLedgerView';
import { formatVND } from '@/lib/utils';

export interface SalaryProfitResolveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Công ty của sổ tổng (= công ty của dòng phiếu lương). */
  organizationId: string | null;
  /** Dòng SALARY_REVIEW của sổ chi tiết (E2). */
  entry: ShareholderLedgerEntry | null;
  shareholderName: string | null;
}

const defaultsOf = (entry: ShareholderLedgerEntry | null): ResolveFormValues => ({
  investment: entry?.suggested ?? 0,
  offset: 0,
  reason: '',
});

export function SalaryProfitResolveDialog({ open, onOpenChange, organizationId, entry, shareholderName }: SalaryProfitResolveDialogProps) {
  const resolveMut = useResolveSalaryProfitLine();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lineId = entry?.line_id ?? null;
  const voucherQuery = useIncomeExpenseDetail(entry?.voucher_id ?? null, open && !!entry?.voucher_id, organizationId);
  const voucherAmount = voucherQuery.data ? voucherQuery.data.total_amount : null;
  const schema = useMemo(() => makeResolveFormSchema({ voucherAmount }), [voucherAmount]);
  const form = useForm<ResolveFormValues>({ resolver: zodResolver(schema), defaultValues: defaultsOf(entry) });
  const { reset } = form;
  const reason = useWatch({ control: form.control, name: 'reason' }) ?? '';
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  // Lần gửi chưa rõ kết quả — theo TỪNG dòng: giữ nguyên nội dung để "Kiểm tra lại" gửi lại y nguyên.
  const [blocked, setBlocked] = useState<{ lineId: string; values: ResolveFormValues; failure: ProfitLedgerErrorInfo } | null>(null);
  const saveBlocked = !!blocked && blocked.lineId === lineId;

  useEffect(() => {
    if (!open) return;
    if (blocked && blocked.lineId === lineId) {
      reset(blocked.values);
      setFailure(blocked.failure);
      return;
    }
    reset(defaultsOf(entry));
    setFailure(null);
    // Chỉ làm mới khi mở hộp hoặc đổi dòng.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lineId]);

  const submit = async (values: ResolveFormValues) => {
    if (!entry?.line_id || !organizationId || resolveMut.isPending) return;
    setFailure(null);
    try {
      const result = await resolveMut.mutateAsync({
        organizationId,
        lineId: entry.line_id,
        investment: values.investment,
        offset: values.offset,
        reason: values.reason,
      });
      setBlocked(null);
      toast.success(
        `Đã xác nhận phần lợi nhuận ${entry.voucher_code ? `của phiếu lương ${entry.voucher_code}` : 'trong phiếu lương'}: `
        + `đầu tư ${formatVND(result.investment_amount)} · bù tạm ứng ${formatVND(result.advance_offset_amount)}. `
        + `Số dư sổ tổng: ${ledgerBalanceText(result.balance_before)} → ${ledgerBalanceText(result.balance_after)}.`,
      );
      onOpenChange(false);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'resolve');
      setFailure(info);
      setBlocked(info.kind === 'UNKNOWN_OUTCOME' ? { lineId: entry.line_id, values, failure: info } : null);
    }
  };

  const voucherLine = voucherQuery.isError
    ? 'Chưa đọc được tiền phiếu lương — máy chủ vẫn kiểm trần khi xác nhận.'
    : voucherAmount !== null ? `Tiền phiếu lương: ${formatVND(voucherAmount)}` : null;

  return (
    <Dialog open={open && !!entry} onOpenChange={(next) => { if (!resolveMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={dialogRef} className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Xác nhận phần lợi nhuận trong phiếu lương</DialogTitle>
          <DialogDescription>
            {entry
              ? `${entry.voucher_code ? `Phiếu ${entry.voucher_code}` : 'Phiếu lương'} · ${shareholderName ?? '—'}`
                + `${entry.period_month ? ` · kỳ ${ledgerMonthLabel(entry.period_month)}` : ''}`
              : null}
          </DialogDescription>
        </DialogHeader>
        {entry && (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(submit, (errors) => { void focusFirstError(errors, { root: dialogRef.current }); })}
              className="space-y-4"
              noValidate
            >
              <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm" data-testid="salary-resolve-context">
                <p>Máy gợi ý phần đầu tư: <strong>{entry.suggested === null ? '—' : formatVND(entry.suggested)}</strong></p>
                {voucherQuery.isLoading && <p className="text-muted-foreground">Đang đọc tiền phiếu lương…</p>}
                {voucherLine && <p className={voucherQuery.isError ? 'text-amber-700' : undefined}>{voucherLine}</p>}
                <p className="text-muted-foreground">
                  Phần đầu tư là lợi nhuận đã trả trong phiếu này (trừ vào số còn phải trả). Phần bù tạm ứng là
                  tiền lương đã giữ lại để bù tạm ứng lợi nhuận (cộng lại vào số dư).
                </p>
              </div>
              <fieldset disabled={saveBlocked || resolveMut.isPending} className="space-y-4">
                <FormField control={form.control} name="investment" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Phần đầu tư (lợi nhuận trong phiếu) <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <CurrencyInput allowNegative name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="offset" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Phần lương bù tạm ứng</FormLabel>
                    <FormControl>
                      <CurrencyInput name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="reason" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Lý do xác nhận <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} maxLength={PROFIT_REASON_MAX} aria-invalid={!!fieldState.error}
                        placeholder="Vì sao chọn số này (để còn đối soát về sau)" />
                    </FormControl>
                    <p className="text-right text-xs text-muted-foreground">{reason.trim().length}/{PROFIT_REASON_MAX}</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </fieldset>
              {failure && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{failure.message}</p>}
              <DialogFooter className="flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={resolveMut.isPending} onClick={() => onOpenChange(false)}>Đóng</Button>
                {saveBlocked ? (
                  <Button type="button" variant="secondary" disabled={resolveMut.isPending} onClick={() => { if (blocked) void submit(blocked.values); }}>
                    {resolveMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                  </Button>
                ) : (
                  <Button type="submit" disabled={resolveMut.isPending || !organizationId}>
                    {resolveMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Xác nhận phần lương
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

export default SalaryProfitResolveDialog;
