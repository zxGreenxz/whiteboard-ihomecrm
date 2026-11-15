// Hộp "Mốc đã trả đủ" (E8 xem trước → E9 ghi) cho một cổ đông hoặc một người nhận lương điều hành.
// Đặt (hoặc đè) mốc "đã trả đủ đến hết tháng X" — mọi khoản tới hết tháng X không còn tính vào số dư;
// hoặc gỡ mốc. Xem trước số dư trước/sau; mốc làm mất dấu một khoản tạm ứng ⇒ chữ đỏ + phải tick.
// Gửi kèm id mốc đang thấy (CAS): người khác vừa đổi mốc ⇒ máy chủ từ chối, hộp tải lại xem trước
// để người dùng xem lại rồi mới bấm (KHÔNG tự gửi lại).

import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useProfitLedgerMarkerPreview } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { useSetProfitLedgerMarker, type SetProfitLedgerMarkerInput } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { currentMonthVN } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import type { MarkerPreview } from '@/lib/profitLedger/actionReaders';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import {
  isPastMarkerMonth, markerFormSchema, markerMonthValue, PROFIT_REASON_MAX, type MarkerFormValues,
} from '@/lib/profitLedger/forms';
import {
  ledgerBalanceText, ledgerMonthLabel, markerText, previousYearMonth,
} from '@/lib/profitLedger/ownerLedgerView';
import { profitLedgerRouteState } from '@/lib/profitLedger/route';
import { activeMarkerMonth, type ProfitLedgerMarker, type ProfitLedgerSubjectKind } from '@/lib/profitLedger/sharedReaders';
import { formatVND } from '@/lib/utils';

export interface ProfitLedgerMarkerSubject {
  id: string;
  name: string;
  /** Mốc hiệu lực theo E1/E10 (chỉ để chọn mặc định; số và id CAS lấy từ xem trước E8). */
  marker: ProfitLedgerMarker | null;
}

export interface ProfitLedgerMarkerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Công ty của sổ. */
  organizationId: string | null;
  subjectKind: ProfitLedgerSubjectKind;
  subject: ProfitLedgerMarkerSubject | null;
}

type MarkerAction = 'SET' | 'REMOVE';

const valuesFor = (action: MarkerAction, subject: ProfitLedgerMarkerSubject | null): MarkerFormValues => ({
  settledThroughMonth: action === 'REMOVE'
    ? null
    : (activeMarkerMonth(subject?.marker) ?? markerMonthValue(previousYearMonth(currentMonthVN()))),
  reason: '',
  acknowledgeAdvanceErase: false,
  previewAdvanceErased: 0,
});

export function ProfitLedgerMarkerDialog({ open, onOpenChange, organizationId, subjectKind, subject }: ProfitLedgerMarkerDialogProps) {
  const markerMut = useSetProfitLedgerMarker();
  const dialogRef = useRef<HTMLDivElement>(null);
  const subjectKey = subject ? `${subjectKind}:${subject.id}` : null;
  const hasActiveMarker = !!activeMarkerMonth(subject?.marker);
  const [action, setAction] = useState<MarkerAction>('SET');
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  // Lần ghi chưa rõ kết quả — theo TỪNG chủ thể: gửi lại ĐÚNG nội dung đã gửi để đối chiếu.
  const [blocked, setBlocked] = useState<{ subjectKey: string; input: SetProfitLedgerMarkerInput; failure: ProfitLedgerErrorInfo } | null>(null);
  const saveBlocked = !!blocked && blocked.subjectKey === subjectKey;

  const form = useForm<MarkerFormValues>({ resolver: zodResolver(markerFormSchema), defaultValues: valuesFor('SET', subject) });
  const { reset, setValue, getValues } = form;
  const settled = useWatch({ control: form.control, name: 'settledThroughMonth' });
  const reason = useWatch({ control: form.control, name: 'reason' }) ?? '';
  const selected = settled ?? null;
  const selectionValid = selected === null || isPastMarkerMonth(selected);

  useEffect(() => {
    if (!open) return;
    if (blocked && blocked.subjectKey === subjectKey) {
      setFailure(blocked.failure);
      return;
    }
    setAction('SET');
    reset(valuesFor('SET', subject));
    setFailure(null);
    // Chỉ làm mới khi mở hộp hoặc đổi chủ thể.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subjectKey]);

  const previewQuery = useProfitLedgerMarkerPreview({
    organizationId,
    subjectKind,
    subjectId: subject?.id ?? null,
    settledThroughMonth: selected,
    enabled: open && !!subject && !saveBlocked && selectionValid,
  });
  const preview: MarkerPreview | undefined = previewQuery.data;
  const previewCurrent = !!preview && preview.settled_through_month === selected && !previewQuery.isFetching;
  const routeState = profitLedgerRouteState(preview?.route);
  const routeBlocked = !!preview && !routeState.canSetMarker;

  // Phần tạm ứng bị xoá dấu theo lần xem trước khớp lựa chọn: đổi số ⇒ phải tick lại.
  const erased = previewCurrent ? preview.advance_erased : 0;
  useEffect(() => {
    if (saveBlocked) return;
    if (getValues('previewAdvanceErased') !== erased) {
      setValue('previewAdvanceErased', erased, { shouldValidate: form.formState.isSubmitted });
      setValue('acknowledgeAdvanceErase', false);
    }
  }, [erased, saveBlocked, getValues, setValue, form.formState.isSubmitted]);

  const changeAction = (next: MarkerAction) => {
    setAction(next);
    setFailure(null);
    setValue('settledThroughMonth', valuesFor(next, subject).settledThroughMonth, { shouldValidate: form.formState.isSubmitted });
    setValue('acknowledgeAdvanceErase', false);
  };

  const send = async (input: SetProfitLedgerMarkerInput) => {
    if (!subject || markerMut.isPending) return;
    setFailure(null);
    try {
      const result = await markerMut.mutateAsync(input);
      setBlocked(null);
      const head = result.settled_through_month
        ? `Đã đặt mốc đã trả đủ đến hết ${ledgerMonthLabel(result.settled_through_month)} cho ${subject.name}.`
        : `Đã gỡ mốc đã trả đủ của ${subject.name}.`;
      toast.success(`${head} Số dư: ${ledgerBalanceText(result.balance_before)} → ${ledgerBalanceText(result.balance_after)}.`);
      onOpenChange(false);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'marker');
      setFailure(info);
      if (info.kind === 'UNKNOWN_OUTCOME') {
        setBlocked({ subjectKey: `${input.subjectKind}:${input.subjectId}`, input, failure: info });
        return;
      }
      setBlocked(null);
      if (info.kind === 'MARKER_CONFLICT') {
        // Mốc vừa đổi dưới tay: tải lại xem trước (id CAS mới) — người dùng xem lại rồi bấm lại.
        setValue('acknowledgeAdvanceErase', false);
        void previewQuery.refetch();
      } else if (info.kind === 'MARKER_ERASES_ADVANCE') {
        const amount = Number(info.detail?.advance_erased);
        if (Number.isFinite(amount) && amount > 0) setValue('previewAdvanceErased', amount);
        setValue('acknowledgeAdvanceErase', false);
        void previewQuery.refetch();
      }
    }
  };

  const submit = async (values: MarkerFormValues) => {
    if (!subject || !organizationId) return;
    form.clearErrors('root');
    if (!previewCurrent) {
      form.setError('root.preview', { type: 'preview', message: 'Đang tính số dư cho mốc này — đợi kết quả rồi bấm lại.' });
      return;
    }
    await send({
      organizationId,
      subjectKind,
      subjectId: subject.id,
      settledThroughMonth: values.settledThroughMonth,
      reason: values.reason,
      // CAS: đúng dòng mốc đang thấy trong lần xem trước (null khi chủ thể chưa từng có mốc).
      expectedMarkerId: preview.current_marker?.id ?? null,
      acknowledgeAdvanceErase: values.acknowledgeAdvanceErase && values.previewAdvanceErased > 0,
    });
  };

  const removing = action === 'REMOVE';
  const title = subjectKind === 'MANAGER' ? 'Mốc đã trả đủ — lương điều hành' : 'Mốc đã trả đủ — lợi nhuận cổ đông';
  const rootPreviewError = form.formState.errors.root?.preview?.message;
  const erasedShown = erased > 0 ? erased : (failure?.kind === 'MARKER_ERASES_ADVANCE' ? Number(failure.detail?.advance_erased) || 0 : 0);

  return (
    <Dialog open={open && !!subject} onOpenChange={(next) => { if (!markerMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={dialogRef} className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {subject ? `${subject.name} · mốc hiện tại: ${markerText(subject.marker) ?? 'chưa có'}` : null}
          </DialogDescription>
        </DialogHeader>
        {subject && (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(submit, (errors) => { void focusFirstError(errors, { root: dialogRef.current }); })}
              className="space-y-4"
              noValidate
            >
              <fieldset disabled={saveBlocked || markerMut.isPending} className="space-y-4">
                {hasActiveMarker && (
                  <div className="flex gap-2" role="radiogroup" aria-label="Việc cần làm với mốc">
                    <Button type="button" size="sm" variant={removing ? 'outline' : 'default'} role="radio" aria-checked={!removing} onClick={() => changeAction('SET')}>
                      Đặt / đổi mốc
                    </Button>
                    <Button type="button" size="sm" variant={removing ? 'destructive' : 'outline'} role="radio" aria-checked={removing} onClick={() => changeAction('REMOVE')}>
                      Gỡ mốc
                    </Button>
                  </div>
                )}

                {!removing && (
                  <FormField control={form.control} name="settledThroughMonth" render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>Đã trả đủ đến hết tháng <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input
                          type="month"
                          name={field.name}
                          aria-invalid={!!fieldState.error}
                          max={previousYearMonth(currentMonthVN())}
                          value={field.value ? field.value.slice(0, 7) : ''}
                          onChange={(event) => field.onChange(event.target.value ? markerMonthValue(event.target.value) : '')}
                          onBlur={field.onBlur}
                        />
                      </FormControl>
                      <p className="text-xs text-muted-foreground">Chỉ chọn tháng đã qua. Mọi khoản tới hết tháng này không còn tính vào số dư.</p>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                <MarkerPreviewBox
                  removing={removing}
                  loading={selectionValid && previewQuery.isFetching}
                  error={previewQuery.isError ? profitLedgerErrorMessage(previewQuery.error, 'preview').message : null}
                  preview={previewCurrent ? preview : null}
                />
                {routeBlocked && routeState.banner && (
                  <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{routeState.banner}</p>
                )}

                {erasedShown > 0 && (
                  <FormField control={form.control} name="acknowledgeAdvanceErase" render={({ field, fieldState }) => (
                    <FormItem className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                      <p className="flex gap-1.5 text-sm font-medium text-destructive" data-testid="marker-advance-erased">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        Mốc này loại các phiếu có phần tạm ứng tổng {formatVND(erasedShown)} — khoản tạm ứng đó không còn được theo dõi.
                      </p>
                      <div className="flex items-start gap-2">
                        <FormControl>
                          <Checkbox
                            name={field.name}
                            data-field-name={field.name}
                            aria-invalid={!!fieldState.error}
                            checked={field.value}
                            onCheckedChange={(checked) => field.onChange(checked === true)}
                          />
                        </FormControl>
                        <FormLabel className="text-sm font-normal leading-snug">Tôi xác nhận bỏ theo dõi phần tạm ứng này.</FormLabel>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                <FormField control={form.control} name="reason" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Lý do <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} maxLength={PROFIT_REASON_MAX} aria-invalid={!!fieldState.error}
                        placeholder={removing ? 'Vì sao gỡ mốc' : 'Vì sao coi là đã trả đủ đến tháng này (vd: đã trả ngoài app)'} />
                    </FormControl>
                    <p className="text-right text-xs text-muted-foreground">{reason.trim().length}/{PROFIT_REASON_MAX}</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </fieldset>

              {rootPreviewError && <p role="alert" className="text-sm text-destructive">{rootPreviewError}</p>}
              {failure && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{failure.message}</p>}

              <DialogFooter className="flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={markerMut.isPending} onClick={() => onOpenChange(false)}>Đóng</Button>
                {saveBlocked ? (
                  <Button type="button" variant="secondary" disabled={markerMut.isPending} onClick={() => { if (blocked) void send(blocked.input); }}>
                    {markerMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                  </Button>
                ) : (
                  <Button type="submit" variant={removing ? 'destructive' : 'default'} disabled={markerMut.isPending || routeBlocked || !organizationId}>
                    {markerMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{removing ? 'Gỡ mốc' : 'Đặt mốc'}
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

function MarkerPreviewBox({ removing, loading, error, preview }: {
  removing: boolean;
  loading: boolean;
  error: string | null;
  preview: MarkerPreview | null;
}) {
  if (error) return <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>;
  if (!preview) {
    return loading
      ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang tính số dư…</p>
      : null;
  }
  const current = preview.current_marker;
  const currentLabel = current?.settled_through_month
    ? `hết ${ledgerMonthLabel(current.settled_through_month)}`
    : current ? 'đã gỡ' : 'chưa có';
  const { excluded } = preview;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm" data-testid="marker-preview">
      <p>Mốc đang có: <strong>{currentLabel}</strong></p>
      <p>
        Số dư bây giờ <strong>{ledgerBalanceText(preview.balance_now)}</strong>
        {' → '}{removing ? 'sau khi gỡ mốc' : 'sau khi đặt mốc'} <strong>{ledgerBalanceText(preview.balance_after)}</strong>
      </p>
      {(excluded.allocated !== 0 || excluded.payouts !== 0 || excluded.salary !== 0) && (
        <p className="text-muted-foreground">
          Mốc không tính các khoản: được chia {formatVND(excluded.allocated)} · đã chi {formatVND(excluded.payouts)} · qua lương {formatVND(excluded.salary)}.
        </p>
      )}
    </div>
  );
}

export default ProfitLedgerMarkerDialog;
