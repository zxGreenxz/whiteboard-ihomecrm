// Hộp "Chi lợi nhuận" theo SỔ TỔNG (Đợt 2) — thay hộp cũ gọi distribute_shareholder_profit_v1.
//
// Hai chế độ:
//   OWNER        chủ (quyền chi lợi nhuận): chọn cổ đông (dòng sổ tổng E1), mọi sổ quỹ tiền thật của công ty.
//   SELF_ADVANCE người chỉ có quyền tạm ứng: chỉ chi cho CHÍNH MÌNH, chỉ từ sổ đang GIỮ (CUSTODIAN).
// Hộp xem trước bằng E4 ngay khi mở (chưa nhập số tiền vẫn hiện số dư), rồi theo số tiền (chờ 400 ms) và
// sổ quỹ: tách "trong số dư" / "tạm ứng". Vượt số dư ⇒ phải tick xác nhận + ghi lý do (gửi làm ghi chú).
// Gửi bằng E5: phiếu CHỜ DUYỆT, tiền chưa ra khỏi sổ. Sổ tổng chưa chạy thật / đóng băng / còn phiếu
// lương cần xem lại ⇒ khoá gửi (máy chủ cũng chặn).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { QueryRegion, type RegionQuery } from '@/components/errors/QueryRegion';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateInput } from '@/components/ui/date-input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Textarea } from '@/components/ui/textarea';
import { useAccounts } from '@/hooks/useAccounts';
import { useMyCashbookAccessV2 } from '@/hooks/income-expenses/financeV2Mutations';
import { useProfitPayoutPreview, useShareholderProfitLedger } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { useCreateProfitLedgerPayout } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { todayISO } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import type { PayoutPreview } from '@/lib/profitLedger/actionReaders';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { payoutAllowAdvance, payoutFormSchema, type PayoutFormValues } from '@/lib/profitLedger/forms';
import type { ShareholderLedgerRow } from '@/lib/profitLedger/ledgerReaders';
import { profitPayoutAccounts, type ProfitPayoutMode } from '@/lib/profitLedger/payoutAccounts';
import { profitLedgerRouteState } from '@/lib/profitLedger/route';
import { formatVND } from '@/lib/utils';

export interface ProfitDistributeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Công ty của cổ đông. */
  organizationId: string | null;
  /** Mặc định OWNER. */
  mode?: ProfitPayoutMode;
  /** OWNER: dòng sổ tổng (E1) trang đã có; không truyền thì hộp tự đọc E1 (cùng khoá query). */
  ledgerRows?: readonly ShareholderLedgerRow[];
  /** SELF_ADVANCE: cổ đông của chính người dùng (E3.shareholder). */
  me?: { shareholderId: string; name: string } | null;
  defaultShareholderId?: string | null;
  /** Bị chặn vì phiếu lương cần xem lại: trang mở sổ chi tiết để "Xác nhận phần lương". */
  onReviewSalary?: (shareholderId: string) => void;
}

const DEBOUNCE_MS = 400;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const validAmount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const emptyValues = (shareholderId: string): PayoutFormValues => ({
  shareholderId, amount: 0, accountId: '', voucherDate: todayISO(), note: '', allowAdvance: false, previewAdvance: 0,
});

export default function ProfitDistributeDialog({
  open, onOpenChange, organizationId, mode = 'OWNER', ledgerRows, me = null, defaultShareholderId, onReviewSalary,
}: ProfitDistributeDialogProps) {
  const selfAdvance = mode === 'SELF_ADVANCE';
  const accountsQuery = useAccounts({ enabled: open });
  const accessQuery = useMyCashbookAccessV2({ enabled: open && selfAdvance });
  const ledgerQuery = useShareholderProfitLedger(open && !selfAdvance && !ledgerRows ? organizationId : null);
  const createMut = useCreateProfitLedgerPayout();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  const [saveBlocked, setSaveBlocked] = useState(false);

  const initialShareholder = selfAdvance ? (me?.shareholderId ?? '') : (defaultShareholderId ?? '');
  const form = useForm<PayoutFormValues>({
    resolver: zodResolver(payoutFormSchema),
    defaultValues: emptyValues(initialShareholder),
  });
  const { reset } = form;

  // Mở lại hộp: làm mới form — TRỪ khi lần trước chưa rõ kết quả (giữ nguyên để đối chiếu đúng nội dung).
  useEffect(() => {
    if (open && !saveBlocked) {
      reset(emptyValues(initialShareholder));
      setFailure(null);
    }
  }, [open, saveBlocked, initialShareholder, reset]);

  const values = useWatch({ control: form.control });
  const shareholderId = values.shareholderId ?? '';
  const accountId = values.accountId ?? '';
  const amount = validAmount(values.amount);
  const debouncedAmount = useDebouncedValue(amount, DEBOUNCE_MS);
  const previewQuery = useProfitPayoutPreview({
    shareholderId: shareholderId || null,
    amount: debouncedAmount,
    accountId: accountId || null,
    enabled: open && !saveBlocked,
  });
  const preview = previewQuery.data;
  const previewCurrent = !!preview && debouncedAmount === amount;

  // Đổi người nhận ⇒ bỏ tick tạm ứng: xác nhận tạm ứng là cho ĐÚNG một cổ đông, không mang sang người khác.
  useEffect(() => {
    if (!saveBlocked && form.getValues('allowAdvance')) form.setValue('allowAdvance', false);
  }, [shareholderId, saveBlocked, form]);

  // Phần tạm ứng theo lần xem trước khớp số đang nhập: hiện ô tick + bắt lý do.
  const previewAdvance = previewCurrent ? (preview.advance_amount ?? 0) : 0;
  useEffect(() => {
    if (!saveBlocked && form.getValues('previewAdvance') !== previewAdvance) {
      form.setValue('previewAdvance', previewAdvance, { shouldValidate: form.formState.isSubmitted });
    }
  }, [previewAdvance, saveBlocked, form]);

  const ledgerData = ledgerQuery.data;
  // Chỉ cổ đông còn hiệu lực mới chi được (đã xoá / ngưng ⇒ máy chủ từ chối).
  const shareholderOptions = useMemo(() => (ledgerRows ?? ledgerData?.shareholders ?? [])
    .filter((row) => !row.is_deleted && row.is_active)
    .map((row) => ({ value: row.shareholder_id, label: row.name })), [ledgerRows, ledgerData]);

  const payoutAccounts = useMemo(() => profitPayoutAccounts({
    mode, organizationId, accounts: accountsQuery.data ?? [], access: selfAdvance ? (accessQuery.data ?? null) : null,
  }), [mode, organizationId, accountsQuery.data, accessQuery.data, selfAdvance]);

  // Route biết từ lần xem trước (E4) hoặc sổ tổng (E1) hộp tự đọc; chưa biết thì chưa khoá theo route
  // (bấm gửi vẫn phải đợi xem trước khớp — xem `submit`).
  const routeSource = preview?.route ?? ledgerQuery.data?.route;
  const routeState = profitLedgerRouteState(routeSource);
  const blockedByRoute = routeSource !== undefined && !routeState.canPayShareholder;
  const reviewCount = preview?.needs_review.count ?? 0;
  const blockedByReview = preview?.blocked_reason === 'SALARY_REVIEW_PENDING' || reviewCount > 0;
  const blockedOther = preview?.blocked_reason === 'OTHER';
  const noHeldCashbook = selfAdvance && accessQuery.isSuccess && accountsQuery.isSuccess && payoutAccounts.length === 0;
  const locked = blockedByRoute || blockedByReview || blockedOther || noHeldCashbook || !organizationId;

  const sources: readonly RegionQuery[] = [
    accountsQuery,
    ...(selfAdvance ? [accessQuery] : []),
    ...(!selfAdvance && !ledgerRows ? [ledgerQuery] : []),
  ];

  const submit = async (data: PayoutFormValues) => {
    if (createMut.isPending || !organizationId) return;
    setFailure(null);
    form.clearErrors('root');
    // Chỉ gửi khi số dư đã tính cho ĐÚNG số tiền + sổ đang nhập (không gửi theo lần xem trước cũ).
    if (!saveBlocked && (!previewCurrent || preview?.can_submit !== true)) {
      form.setError('root.preview', { type: 'preview', message: 'Đang tính số dư cho số tiền này — đợi kết quả rồi bấm lại.' });
      return;
    }
    try {
      const result = await createMut.mutateAsync({
        organizationId,
        shareholderId: data.shareholderId,
        amount: data.amount,
        accountId: data.accountId,
        voucherDate: data.voucherDate,
        note: data.note.trim() || null,
        allowAdvance: payoutAllowAdvance(data),
      });
      setSaveBlocked(false);
      toast.success(
        `Đã lập ${result.code ? `phiếu ${result.code}` : 'phiếu'}: chờ duyệt, chưa chi tiền. `
        + `Trong số dư ${formatVND(result.within_amount)} · tạm ứng ${formatVND(result.advance_amount)}.`,
      );
      onOpenChange(false);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'payout');
      setFailure(info);
      if (info.kind === 'UNKNOWN_OUTCOME') {
        setSaveBlocked(true);
        return;
      }
      setSaveBlocked(false);
      if (info.kind === 'ADVANCE_CONFIRM') {
        // Máy chủ tính lại: bật ô tick ngay theo phần tạm ứng nó báo; xem trước tự tải lại (đã làm mới khoá).
        const advance = Number(info.detail?.advance);
        if (Number.isFinite(advance) && advance > 0) form.setValue('previewAdvance', advance);
        await focusFirstError({ allowAdvance: info.message }, { root: dialogRef.current });
      }
    }
  };

  const onInvalid = (errors: unknown) => { void focusFirstError(errors, { root: dialogRef.current }); };
  const title = selfAdvance ? 'Chi tạm ứng lợi nhuận cho tôi' : 'Chi lợi nhuận cổ đông';
  const advanceShown = previewAdvance > 0 || (values.previewAdvance ?? 0) > 0;
  const rootPreviewError = form.formState.errors.root?.preview?.message;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!createMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={dialogRef} className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {selfAdvance
              ? 'Chỉ chi cho chính bạn, từ sổ quỹ bạn đang giữ. Mọi khoản chờ chủ duyệt.'
              : 'Lập phiếu chờ duyệt — tiền chưa ra khỏi sổ cho tới khi một chủ khác duyệt và chi.'}
          </DialogDescription>
        </DialogHeader>

        <QueryRegion label="sổ quỹ và sổ tổng lợi nhuận" queries={sources} skeleton="detail" rows={5}>
          {routeState.banner && blockedByRoute && (
            <p role="status" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />{routeState.banner}
            </p>
          )}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit, onInvalid)} className="space-y-4" noValidate>
              <fieldset disabled={saveBlocked || createMut.isPending} className="space-y-4">
                {selfAdvance ? (
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Người nhận</p>
                    <p className="text-sm">{me?.name ?? '—'}</p>
                  </div>
                ) : (
                  <FormField control={form.control} name="shareholderId" render={({ field, fieldState }) => (
                    <FormItem>
                      <FormLabel>Cổ đông <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <SearchableSelect
                          name={field.name}
                          aria-invalid={!!fieldState.error}
                          value={field.value}
                          onValueChange={field.onChange}
                          placeholder="Chọn cổ đông"
                          options={shareholderOptions}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                <BalanceBox
                  loading={!!shareholderId && previewQuery.isFetching && !preview}
                  error={previewQuery.isError ? profitLedgerErrorMessage(previewQuery.error, 'preview').message : null}
                  preview={preview ?? null}
                  previewCurrent={previewCurrent}
                  onReviewSalary={onReviewSalary && shareholderId ? () => onReviewSalary(shareholderId) : undefined}
                />

                <FormField control={form.control} name="amount" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Số tiền <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <CurrencyInput name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="accountId" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Chi từ sổ quỹ <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <SearchableSelect
                        name={field.name}
                        aria-invalid={!!fieldState.error}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder={noHeldCashbook ? 'Bạn chưa giữ sổ quỹ nào' : 'Chọn sổ quỹ nguồn'}
                        options={payoutAccounts.map((account) => ({ value: account.id, label: account.name, keywords: account.code }))}
                      />
                    </FormControl>
                    {noHeldCashbook && <p role="alert" className="text-sm text-destructive">Bạn chưa giữ sổ quỹ nào ở công ty này — chưa tạm ứng được.</p>}
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="voucherDate" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Ngày chi <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <DateInput name={field.name} aria-invalid={!!fieldState.error} value={field.value} onChange={field.onChange} onBlur={field.onBlur} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                {advanceShown && (
                  <FormField control={form.control} name="allowAdvance" render={({ field, fieldState }) => (
                    <FormItem className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
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
                        <FormLabel className="text-sm font-normal leading-snug">
                          Tôi xác nhận phần vượt {formatVND(previewAdvance || (values.previewAdvance ?? 0))} là tạm ứng lợi nhuận
                          (trừ dần vào lợi nhuận các tháng sau).
                        </FormLabel>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                <FormField control={form.control} name="note" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>{advanceShown ? <>Lý do tạm ứng <span className="text-destructive">*</span></> : 'Ghi chú'}</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={2} aria-invalid={!!fieldState.error} placeholder={advanceShown ? 'Vì sao chi vượt số còn phải trả' : undefined} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </fieldset>

              {rootPreviewError && <p role="alert" className="text-sm text-destructive">{rootPreviewError}</p>}
              {failure && (
                <div role="alert" className="space-y-2 rounded-md border border-destructive p-3 text-sm text-destructive">
                  <p>{failure.message}</p>
                  {failure.kind === 'SALARY_REVIEW_PENDING' && onReviewSalary && shareholderId && (
                    <Button type="button" variant="outline" size="sm" onClick={() => onReviewSalary(shareholderId)}>Xem lại phần lương</Button>
                  )}
                </div>
              )}

              <DialogFooter className="flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={createMut.isPending} onClick={() => onOpenChange(false)}>Đóng</Button>
                {saveBlocked ? (
                  // Đối chiếu: gửi lại ĐÚNG nội dung với khoá cũ — máy chủ trả biên nhận cũ nếu đã lập.
                  <Button type="submit" variant="secondary" disabled={createMut.isPending}>
                    {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                  </Button>
                ) : (
                  <Button type="submit" disabled={locked || createMut.isPending}>
                    {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Lập phiếu chờ duyệt
                  </Button>
                )}
              </DialogFooter>
            </form>
          </Form>
        </QueryRegion>
      </DialogContent>
    </Dialog>
  );
}

function BalanceBox({ loading, error, preview, previewCurrent, onReviewSalary }: {
  loading: boolean;
  error: string | null;
  preview: PayoutPreview | null;
  previewCurrent: boolean;
  onReviewSalary?: () => void;
}) {
  if (error) return <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>;
  if (loading) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang tính số dư…</p>;
  if (!preview) return null;
  const owed = preview.balance_before >= 0;
  const exceeds = preview.warnings.find((w) => w.code === 'ADVANCE_EXCEEDS_ESTIMATE');
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm" data-testid="profit-payout-balance">
      <p>
        {owed ? 'Còn phải trả: ' : 'Đang tạm ứng: '}
        <strong className={owed ? undefined : 'text-destructive'}>{formatVND(Math.abs(preview.balance_before))}</strong>
      </p>
      {previewCurrent && preview.within_amount !== null && preview.advance_amount !== null && (
        <p>
          Lần chi này: trong số dư <strong>{formatVND(preview.within_amount)}</strong>
          {' · '}tạm ứng <strong className={preview.advance_amount > 0 ? 'text-destructive' : undefined}>{formatVND(preview.advance_amount)}</strong>
        </p>
      )}
      {exceeds && exceeds.code === 'ADVANCE_EXCEEDS_ESTIMATE' && (
        <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {exceeds.outstanding_advance !== null && exceeds.open_estimate !== null
            ? `Tạm ứng còn treo sau lần chi này ${formatVND(exceeds.outstanding_advance)} vượt lợi nhuận ước tính các tháng chưa chốt ${formatVND(exceeds.open_estimate)}.`
            : 'Tạm ứng còn treo sau lần chi này vượt lợi nhuận ước tính các tháng chưa chốt.'}
        </p>
      )}
      {preview.needs_review.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-destructive">
          <span>Còn {preview.needs_review.count} phiếu lương cần chủ xem lại phần lợi nhuận — xác nhận trước khi chi.</span>
          {onReviewSalary && <Button type="button" variant="outline" size="sm" onClick={onReviewSalary}>Xem lại phần lương</Button>}
        </div>
      )}
      {preview.requires_owner_approval && (
        <p className="text-muted-foreground">Phiếu chờ một chủ khác duyệt; tiền chưa ra khỏi sổ.</p>
      )}
    </div>
  );
}
