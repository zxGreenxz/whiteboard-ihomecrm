// Hộp "Xác nhận phần lương" (E16) — phiếu lương của một cổ đông bị máy ghi "cần chủ xem lại":
// chủ xác nhận phần lợi nhuận nằm trong phiếu (đầu tư Y) và phần lương đã giữ lại bù tạm ứng (D).
//
// KHÔNG để sẵn số: Y và D đều phải tự nhập (gợi ý hiện bên cạnh). Để sẵn D = 0 thì sổ trừ đủ Y thay
// vì Y − D, cổ đông bị thiếu D, mà dòng đã LINKED thì không sửa lại được. Phần còn lại của tháng đọc
// từ bảng lương (E12 cho đúng nhân viên + kỳ): D còn trừ được = D_m − ΣD, đầu tư còn lại = Y_cap − ΣY,
// tiền phiếu — chặn sớm cùng luật máy chủ (0 ≤ D ≤ D còn lại, Y giữa 0 và phần còn lại, Y − D ≤ tiền
// phiếu). Chưa đọc / chưa đối chiếu được bảng lương ⇒ KHOÁ nút (đóng an toàn), có Thử lại.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useResolveSalaryProfitLine } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { useSalaryProfitStaffInputs } from '@/hooks/profit-ledger/useSalaryProfitStaffInputs';
import { useShareholders } from '@/hooks/useShareholders';
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
  /** Cổ đông của sổ chi tiết — nhân viên của dòng lương là tài khoản đăng nhập của cổ đông này. */
  shareholderId: string | null;
  /** Dòng SALARY_REVIEW của sổ chi tiết (E2). */
  entry: ShareholderLedgerEntry | null;
  shareholderName: string | null;
}

// Ô trống (NaN) — người xác nhận phải tự nhập cả hai số, không có số mặc định.
const EMPTY_VALUES: ResolveFormValues = { investment: Number.NaN, offset: Number.NaN, reason: '' };

export function SalaryProfitResolveDialog({
  open, onOpenChange, organizationId, shareholderId, entry, shareholderName,
}: SalaryProfitResolveDialogProps) {
  const resolveMut = useResolveSalaryProfitLine();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lineId = entry?.line_id ?? null;

  // Nhân viên của dòng lương = tài khoản đăng nhập của cổ đông (danh sách cổ đông đã có trên trang).
  const shareholdersQuery = useShareholders();
  const shareholder = shareholdersQuery.data?.find((row) => row.id === shareholderId) ?? null;
  const staffId = shareholder?.auth_user_id ?? null;
  const inputsQuery = useSalaryProfitStaffInputs({
    periodMonth: entry?.period_month ?? null,
    staffId,
    enabled: open && !!entry,
  });
  const staff = inputsQuery.data ?? null;
  const line = staff?.paid_lines.find((row) => row.line_id === lineId) ?? null;
  // Đối chiếu chặt: đúng cổ đông, đúng dòng, dòng vẫn đang chờ xem lại.
  const matched = !!staff && !!line && staff.shareholder_id === shareholderId && line.state === 'NEEDS_REVIEW';
  // Trần cùng luật E16: tiền phiếu, D còn trừ được (D_m − ΣD), đầu tư còn lại (Y_cap − ΣY).
  const voucherAmount = matched ? line.voucher_amount : null;
  const maxOffset = matched ? Math.max(staff.remaining_offset, 0) : null;
  const investmentRemaining = matched ? staff.investment_cap - staff.paid_investment : null;
  const limits = matched && maxOffset !== null && investmentRemaining !== null
    ? { voucherAmount, maxOffset, investmentRemaining }
    : null;

  const schema = useMemo(
    () => makeResolveFormSchema({ voucherAmount, maxOffset, investmentRemaining }),
    [voucherAmount, maxOffset, investmentRemaining],
  );
  const form = useForm<ResolveFormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY_VALUES });
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
    reset(EMPTY_VALUES);
    setFailure(null);
    // Chỉ làm mới khi mở hộp hoặc đổi dòng.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lineId]);

  const submit = async (values: ResolveFormValues) => {
    if (!entry?.line_id || !organizationId || resolveMut.isPending) return;
    // Đóng an toàn: chưa đọc / chưa đối chiếu được phần còn lại của tháng thì không gửi.
    if (!saveBlocked && !matched) return;
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

  // Trạng thái nguồn số của tháng (E12) — mọi trạng thái khác "đã đối chiếu" đều khoá nút.
  const sourceProblem: string | null = matched
    ? null
    : shareholdersQuery.isError || inputsQuery.isError
      ? profitLedgerErrorMessage(inputsQuery.error ?? shareholdersQuery.error, 'read').message
      : shareholdersQuery.isLoading || inputsQuery.isLoading || (inputsQuery.isFetching && !staff)
        ? null
        : !staffId
          ? 'Cổ đông chưa gắn tài khoản nhân viên (hoặc đã xoá) — chưa đối chiếu được bảng lương của phiếu này.'
          : 'Chưa đối chiếu được dòng phiếu lương này với bảng lương tháng — tải lại sổ chi tiết rồi mở lại.';
  const sourceLoading = !matched && !sourceProblem;
  const suggested = line?.suggested_investment ?? entry?.suggested ?? null;

  return (
    <Dialog open={open && !!entry} onOpenChange={(next) => { if (!resolveMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={dialogRef} className="sm:max-w-[520px]">
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
                {matched && limits ? (
                  <>
                    <p>Tiền phiếu lương: <strong>{limits.voucherAmount === null ? '—' : formatVND(limits.voucherAmount)}</strong></p>
                    <p>Phần đầu tư còn lại của tháng: <strong>{formatVND(limits.investmentRemaining)}</strong></p>
                    <p data-testid="salary-resolve-offset-left">
                      Phần bù tạm ứng còn trừ được của tháng: <strong>{formatVND(limits.maxOffset)}</strong>
                      {' '}(cả tháng {formatVND(staff.advance_offset_month)} · đã trừ ở phiếu trước {formatVND(staff.paid_offset)})
                    </p>
                  </>
                ) : sourceProblem ? (
                  <div role="alert" className="space-y-2">
                    <p className="text-destructive">{sourceProblem}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => { void shareholdersQuery.refetch(); void inputsQuery.refetch(); }}>
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Thử lại
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang đọc phần lợi nhuận của tháng trong bảng lương…</p>
                )}
                <p className="text-muted-foreground">
                  Phần đầu tư là lợi nhuận đã trả trong phiếu này (trừ vào số còn phải trả). Phần bù tạm ứng là
                  tiền lương đã giữ lại để bù tạm ứng lợi nhuận (cộng lại vào số dư). Tự nhập cả hai số.
                </p>
              </div>
              <fieldset disabled={saveBlocked || resolveMut.isPending} className="space-y-4">
                <FormField control={form.control} name="investment" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Phần đầu tư (lợi nhuận trong phiếu) <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <CurrencyInput allowNegative name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} placeholder="Nhập số" />
                    </FormControl>
                    <p className="text-xs text-muted-foreground" data-testid="salary-resolve-suggested">
                      Máy gợi ý: {suggested === null ? '—' : formatVND(suggested)}
                    </p>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="offset" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Phần lương bù tạm ứng <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <CurrencyInput name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} placeholder="Nhập số" />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      Từ 0 đến {limits ? formatVND(limits.maxOffset) : '…'} (phần còn trừ được của tháng).
                    </p>
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
                  <Button type="submit" disabled={resolveMut.isPending || !organizationId || !matched}>
                    {(resolveMut.isPending || sourceLoading) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Xác nhận phần lương
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
