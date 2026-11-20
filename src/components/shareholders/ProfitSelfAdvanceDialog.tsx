// Hộp "Chi tạm ứng cho tôi" — cổ đông có quyền tạm ứng tự lập phiếu tạm ứng cho CHÍNH MÌNH, chỉ từ sổ quỹ
// mình đang GIỮ (W1 shareholder_profit_advance_v1; xem trước bằng R4).
//
// Mọi khoản ứng đều là TẠM ỨNG, cộng dồn: KHÔNG còn ô "xác nhận phần vượt" và KHÔNG bắt lý do (ghi chú tuỳ
// ý). Hộp hiện "Lợi nhuận chưa chi", "Tạm ứng đang có" và số sau phiếu này; ứng vượt lợi nhuận chưa chi chỉ
// CẢNH BÁO, không chặn. Phiếu nào cũng CHỜ CHỦ DUYỆT — tiền chưa ra khỏi sổ. Sổ tổng chưa chạy thật / đóng
// băng / còn phiếu lương cần chủ xem lại / chưa giữ sổ nào ⇒ khoá gửi (máy chủ cũng chặn). Chưa giữ sổ nào thì hộp
// chỉ đường: nhờ người đang giữ sổ quỹ lập phiếu Tạm Ứng hộ ở Thu chi (người nhận vẫn là mình).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Info, Loader2 } from 'lucide-react';
import { OwnerPayoutPostingSection } from '@/components/shareholders/OwnerPayoutPostingSection';
import { useOwnerAdvancePosting } from '@/hooks/profit-ledger/useOwnerAdvancePosting';
import { toast } from 'sonner';
import { QueryRegion, type RegionQuery } from '@/components/errors/QueryRegion';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateInput } from '@/components/ui/date-input';
import {
  Dialog, DIALOG_SCROLL_BODY, DIALOG_STICKY_FOOTER, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Textarea } from '@/components/ui/textarea';
import { useAccounts } from '@/hooks/useAccounts';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useMyCashbookAccessV2 } from '@/hooks/income-expenses/financeV2Mutations';
import { useShareholderAdvancePreview } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { useCreateShareholderAdvance } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { todayISO } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { advanceFormSchema, type AdvanceFormValues } from '@/lib/profitLedger/forms';
import { profitPayoutAccounts } from '@/lib/profitLedger/payoutAccounts';
import { profitLedgerRouteState } from '@/lib/profitLedger/route';
import { formatVND } from '@/lib/utils';
import { ShareholderAdvancePreviewBox } from './ShareholderAdvancePreviewBox';

export interface ProfitSelfAdvanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Công ty của cổ đông. */
  organizationId: string | null;
  /** Cổ đông của chính người dùng. */
  me: { shareholderId: string; name: string } | null;
}

const DEBOUNCE_MS = 400;

const validAmount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const emptyValues = (shareholderId: string): AdvanceFormValues => ({
  shareholderId, amount: 0, accountId: '', voucherDate: todayISO(), note: '',
});

export default function ProfitSelfAdvanceDialog({ open, onOpenChange, organizationId, me }: ProfitSelfAdvanceDialogProps) {
  const accountsQuery = useAccounts({ enabled: open });
  const accessQuery = useMyCashbookAccessV2({ enabled: open });
  const createMut = useCreateShareholderAdvance();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  const [saveBlocked, setSaveBlocked] = useState(false);

  const shareholderId = me?.shareholderId ?? '';
  const form = useForm<AdvanceFormValues>({ resolver: zodResolver(advanceFormSchema), defaultValues: emptyValues(shareholderId) });
  const { reset } = form;

  // Mở lại hộp: làm mới form — TRỪ khi lần trước chưa rõ kết quả (giữ nguyên để đối chiếu đúng nội dung).
  const previousOpen = useRef<{ shareholderId: string } | null>(null);
  useEffect(() => {
    const entering = open && previousOpen.current?.shareholderId !== shareholderId;
    previousOpen.current = open ? { shareholderId } : null;
    if (entering && !saveBlocked) {
      reset(emptyValues(shareholderId));
      setFailure(null);
    }
  }, [open, saveBlocked, shareholderId, reset]);

  const values = useWatch({ control: form.control });
  const accountId = values.accountId ?? '';
  const amount = validAmount(values.amount);
  const debouncedAmount = useDebouncedValue(amount, DEBOUNCE_MS);
  const previewQuery = useShareholderAdvancePreview({
    shareholderId: shareholderId || null,
    amount: debouncedAmount,
    accountId: accountId || null,
    enabled: open && !saveBlocked,
  });
  const preview = previewQuery.data ?? null;
  // Lần xem trước của ĐÚNG số tiền đang nhập (khoá query đã gồm sổ quỹ): đủ để HIỆN số sau phiếu này.
  const owner = useOwnerAdvancePosting(open, preview?.maker_kind === 'OWNER', accountId);
  const previewMatches = !!preview && debouncedAmount === amount;
  // Đủ để GỬI: còn phải tải xong — đang tải lại hay tải lại lỗi thì số đang hiện có thể đã cũ.
  const previewCurrent = previewMatches && !previewQuery.isFetching && !previewQuery.isError;

  // Số mới đã tính xong: bỏ câu "đang tính" của lần bấm trước.
  useEffect(() => {
    if (previewCurrent) form.clearErrors('root.preview');
  }, [previewCurrent, form]);

  // Chỉ sổ TIỀN THẬT của đúng công ty mà mình đang GIỮ (CUSTODIAN) — không bao giờ sổ ảo.
  const payoutAccounts = useMemo(() => profitPayoutAccounts({
    mode: 'SELF_ADVANCE', organizationId, accounts: accountsQuery.data ?? [], access: accessQuery.data ?? null,
  }), [organizationId, accountsQuery.data, accessQuery.data]);

  const routeState = profitLedgerRouteState(preview?.route);
  const blockedByRoute = !!preview && (!routeState.canPayShareholder || preview.blocked_reason === 'ROUTE');
  const noHeldCashbook = accessQuery.isSuccess && accountsQuery.isSuccess && payoutAccounts.length === 0;
  const locked = !organizationId || !me || blockedByRoute || noHeldCashbook
    || (!!preview && preview.blocked_reason !== null);

  const sources: readonly RegionQuery[] = [accountsQuery, accessQuery];

  const submit = async (data: AdvanceFormValues) => {
    if (createMut.isPending || !organizationId) return;
    setFailure(null);
    form.clearErrors('root');
    // Chỉ gửi khi đã kiểm XONG cho ĐÚNG số tiền + sổ đang nhập (không gửi theo lần kiểm cũ / đang tải lại).
    if (!owner.created && !saveBlocked && (!previewCurrent || preview?.can_submit !== true)) {
      form.setError('root.preview', {
        type: 'preview',
        message: previewQuery.isError
          ? 'Chưa kiểm tra được phiếu tạm ứng này — bấm "Tính lại" rồi gửi.'
          : 'Đang kiểm tra phiếu tạm ứng này — đợi kết quả rồi bấm lại.',
      });
      return;
    }
    try {
      const create = async () => {
        const receipt = await createMut.mutateAsync({
          organizationId,
          shareholderId: data.shareholderId,
          amount: data.amount,
          accountId: data.accountId,
          voucherDate: data.voucherDate,
          note: data.note.trim() || null,
        });
        setSaveBlocked(false);
        return receipt;
      };
      if (owner.active) {
        if (await owner.save(create, organizationId, data.voucherDate)) { onOpenChange(false); }
        return;
      }
      const result = await create();
      toast.success(`Đã lập ${result.code ? `phiếu ${result.code}` : 'phiếu'} tạm ứng ${formatVND(result.advance_amount)}: chờ chủ duyệt, chưa chi tiền.`);
      onOpenChange(false);
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'advance');
      setFailure(info);
      setSaveBlocked(info.kind === 'UNKNOWN_OUTCOME');
    }
  };

  const onInvalid = (errors: unknown) => { void focusFirstError(errors, { root: dialogRef.current }); };
  const rootPreviewError = form.formState.errors.root?.preview?.message;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!createMut.isPending && !owner.busy) onOpenChange(next); }}>
      {/* Khuôn hộp dài: giới hạn theo khung nhìn động + cuộn dọc, hàng nút dính đáy (điện thoại không mất tiêu đề / nút). */}
      <DialogContent ref={dialogRef} className={`sm:max-w-[520px] ${DIALOG_SCROLL_BODY}`}>
        <DialogHeader>
          <DialogTitle>Chi tạm ứng lợi nhuận cho tôi</DialogTitle>
          <DialogDescription>
            Chỉ ứng cho chính bạn, từ sổ quỹ bạn đang giữ. Quy trình duyệt hiển thị theo tài khoản lập phiếu.
          </DialogDescription>
        </DialogHeader>

        <QueryRegion label="sổ quỹ bạn đang giữ" queries={sources} skeleton="detail" rows={5}>
          {routeState.banner && blockedByRoute && (
            <p role="status" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />{routeState.banner}
            </p>
          )}
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit, onInvalid)} className="space-y-4" noValidate>
              <fieldset disabled={saveBlocked || createMut.isPending || owner.busy || !!owner.created} className="space-y-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Người nhận</p>
                  <p className="text-sm">{me?.name ?? '—'}</p>
                </div>

                <ShareholderAdvancePreviewBox
                  loading={!!shareholderId && previewQuery.isFetching && !preview}
                  refreshing={previewMatches && previewQuery.isFetching}
                  error={previewQuery.isError ? profitLedgerErrorMessage(previewQuery.error, 'preview').message : null}
                  onRetry={() => { void previewQuery.refetch(); }}
                  preview={preview}
                  showAfter={previewMatches}
                />

                <FormField control={form.control} name="amount" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Số tiền tạm ứng <span className="text-destructive">*</span></FormLabel>
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
                        placeholder={noHeldCashbook ? 'Bạn chưa giữ sổ quỹ nào' : 'Chọn sổ quỹ bạn đang giữ'}
                        options={payoutAccounts.map((account) => ({ value: account.id, label: account.name, keywords: account.code }))}
                      />
                    </FormControl>
                    {noHeldCashbook && (
                      // Có quyền tạm ứng mà không giữ sổ nào: chỉ đường thay vì chỉ báo khoá.
                      <p role="status" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="profit-advance-no-cashbook">
                        <Info className="mt-0.5 h-4 w-4 shrink-0" />
                        Bạn chưa giữ sổ quỹ nào — nhờ người đang giữ sổ quỹ lập phiếu Tạm Ứng cho bạn ở Thu chi.
                      </p>
                    )}
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

                <FormField control={form.control} name="note" render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Ghi chú</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={2} aria-invalid={!!fieldState.error} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </fieldset>

              {owner.active && <OwnerPayoutPostingSection {...owner.section} />}
        {rootPreviewError && <p role="alert" className="text-sm text-destructive">{rootPreviewError}</p>}
              {failure && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive" data-testid="profit-advance-failure">{failure.message}</p>}

              {/* Hàng nút dính đáy hộp: thân (số, cảnh báo, các ô) cuộn, nút luôn thấy. */}
              <DialogFooter className={DIALOG_STICKY_FOOTER}>
                <Button type="button" variant="outline" className="flex-1 sm:flex-none" disabled={createMut.isPending || owner.busy} onClick={() => onOpenChange(false)}>Đóng</Button>
                {saveBlocked ? (
                  // Đối chiếu: gửi lại ĐÚNG nội dung với khoá cũ — máy chủ trả biên nhận cũ nếu đã lập.
                  <Button type="submit" variant="secondary" className="flex-1 sm:flex-none" disabled={createMut.isPending || owner.busy}>
                    {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Kiểm tra lại kết quả
                  </Button>
                ) : (
                  <Button type="submit" className="flex-1 sm:flex-none" disabled={(!owner.created && locked) || createMut.isPending || owner.busy || (owner.active && owner.disabled)}>
                    {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{owner.active ? owner.label : 'Lập phiếu chờ duyệt'}
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
