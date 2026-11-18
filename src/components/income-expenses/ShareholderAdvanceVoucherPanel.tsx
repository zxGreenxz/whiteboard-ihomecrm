// Thân form Thu chi ở chế độ "Tạm Ứng" (tạm ứng lợi nhuận cổ đông) — phiếu CHI tạo mới, form đầy đủ.
//
// Người đang GIỮ một sổ quỹ lập phiếu tạm ứng cho một cổ đông được cấp quyền tạm ứng (hoặc cho chính mình):
//   toà khoá về toà ảo của công ty · "người nhận" là dropdown các cổ đông có quyền tạm ứng · sổ quỹ chỉ còn
//   các sổ mình đang giữ · một hạng mục, một số tiền · không phòng / hợp đồng / lặp lại / KQKD / đính kèm.
// Lưu bằng lệnh tạm ứng (W1 shareholder_profit_advance_v1) — KHÔNG đi đường tạo phiếu thường. Mọi phiếu
// chờ chủ duyệt (người duyệt khác người lập và người nhận), tiền chưa ra khỏi sổ.
// Người lập HỘ không thấy số của cổ đông: máy chủ không gửi (xem ShareholderAdvancePreviewBox).

import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ShareholderAdvancePreviewBox } from '@/components/shareholders/ShareholderAdvancePreviewBox';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateSegmentInput } from '@/components/ui/date-segment-input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Textarea } from '@/components/ui/textarea';
import { useShareholderAdvancePreview } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { useCreateShareholderAdvance } from '@/hooks/profit-ledger/useProfitLedgerMutations';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { todayISO } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import { profitLedgerErrorMessage, type ProfitLedgerErrorInfo } from '@/lib/profitLedger/errors';
import { advanceFormSchema, PROFIT_PAYOUT_NOTE_MAX, type AdvanceFormValues } from '@/lib/profitLedger/forms';
import type { AdvanceOptions } from '@/lib/profitLedger/positionReaders';
import { ADVANCE_BUILDING_NAME, advanceTypeName } from '@/lib/profitLedger/positionView';
import { formatVND } from '@/lib/utils';

export interface ShareholderAdvanceVoucherPanelProps {
  /** Công ty đang chọn (công ty của các cổ đông trong `options`). */
  organizationId: string | null;
  /** Lựa chọn máy chủ trả (R3): sổ đang giữ, người nhận có quyền tạm ứng, hạng mục. */
  options: AdvanceOptions;
  /** Tên toà ảo của công ty khi form biết chắc; không biết thì hiện tên chuẩn. */
  buildingName?: string | null;
  isMobile: boolean;
  /** Bỏ hạng mục Tạm Ứng ⇒ quay về form phiếu chi thường. */
  onExit: () => void;
  /** Huỷ bỏ, hoặc lưu xong ⇒ đóng hộp. */
  onClose: () => void;
  /** Sau khi lập xong (số tiền của phiếu). */
  onSaved?: (amount: number) => void;
  /**
   * Đang gửi lệnh lập phiếu (true) / đã xong (false). Form cha khoá tab "Phiếu thu" và nút đóng hộp trong lúc
   * này: gỡ thân Tạm Ứng giữa chừng thì lưu xong sẽ đóng nhầm form thường.
   */
  onSavingChange?: (saving: boolean) => void;
}

const DEBOUNCE_MS = 400;

const validAmount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export function ShareholderAdvanceVoucherPanel({
  organizationId, options, buildingName, isMobile, onExit, onClose, onSaved, onSavingChange,
}: ShareholderAdvanceVoucherPanelProps) {
  const createMut = useCreateShareholderAdvance();
  const formRef = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<ProfitLedgerErrorInfo | null>(null);
  const [saveBlocked, setSaveBlocked] = useState(false);
  const form = useForm<AdvanceFormValues>({
    shouldFocusError: false,
    resolver: zodResolver(advanceFormSchema),
    defaultValues: { shareholderId: '', amount: 0, accountId: '', voucherDate: todayISO(), note: '' },
  });

  const values = useWatch({ control: form.control });
  const shareholderId = values.shareholderId ?? '';
  const accountId = values.accountId ?? '';
  const amount = validAmount(values.amount);
  const debouncedAmount = useDebouncedValue(amount, DEBOUNCE_MS);
  const previewQuery = useShareholderAdvancePreview({
    shareholderId: shareholderId || null,
    amount: debouncedAmount,
    accountId: accountId || null,
    enabled: !saveBlocked,
  });
  // Lần kiểm của ĐÚNG người nhận đang chọn (khoá query đã gồm người nhận + sổ quỹ).
  const preview = previewQuery.data && previewQuery.data.shareholder_id === shareholderId ? previewQuery.data : null;
  const previewMatches = !!preview && debouncedAmount === amount;
  // Đủ để GỬI: còn phải tải xong — đang tải lại hay tải lại lỗi thì lần kiểm đang hiện có thể đã cũ.
  const previewCurrent = previewMatches && !previewQuery.isFetching && !previewQuery.isError;

  useEffect(() => {
    if (previewCurrent) form.clearErrors('root.preview');
  }, [previewCurrent, form]);

  const typeName = advanceTypeName(options);
  const payee = options.payees.find((row) => row.shareholder_id === shareholderId) ?? null;
  const locked = !organizationId || (!!preview && preview.blocked_reason !== null);
  const pending = createMut.isPending;

  // Báo form cha lúc đang lưu; thân này bị gỡ thì luôn báo "hết lưu" để form cha không kẹt khoá.
  useEffect(() => {
    onSavingChange?.(pending);
  }, [pending, onSavingChange]);
  useEffect(() => () => { onSavingChange?.(false); }, [onSavingChange]);

  const submit = async (data: AdvanceFormValues) => {
    if (pending || !organizationId) return;
    setFailure(null);
    form.clearErrors('root');
    // Chỉ gửi khi đã kiểm XONG cho ĐÚNG người nhận + số tiền + sổ đang nhập.
    if (!saveBlocked && (!previewCurrent || preview?.can_submit !== true)) {
      form.setError('root.preview', {
        type: 'preview',
        message: previewQuery.isError
          ? 'Chưa kiểm tra được phiếu tạm ứng này — bấm "Tính lại" rồi lưu.'
          : 'Đang kiểm tra phiếu tạm ứng này — đợi kết quả rồi bấm Lưu lại.',
      });
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
      });
      setSaveBlocked(false);
      toast.success(
        `Đã lập ${result.code ? `phiếu ${result.code}` : 'phiếu'} tạm ứng ${formatVND(result.advance_amount)}${payee ? ` cho ${payee.name}` : ''}: chờ chủ duyệt, chưa chi tiền.`,
      );
      onSaved?.(result.advance_amount);
      onClose();
    } catch (error) {
      const info = profitLedgerErrorMessage(error, 'advance');
      setFailure(info);
      setSaveBlocked(info.kind === 'UNKNOWN_OUTCOME');
    }
  };

  const rootPreviewError = form.formState.errors.root?.preview?.message;

  return (
    <Form {...form}>
      <form
        ref={formRef}
        onSubmit={form.handleSubmit(submit, (errors) => { void focusFirstError(errors, { root: formRef.current }); })}
        className="space-y-4"
        noValidate
        data-testid="shareholder-advance-panel"
      >
        <p className="text-sm text-muted-foreground">
          Phiếu <b>{typeName}</b> cho cổ đông: một hạng mục, chi từ sổ quỹ bạn đang giữ, <b>chờ chủ duyệt</b> rồi mới chi tiền.
          Tên phiếu do hệ thống đặt theo người nhận.
        </p>

        <fieldset disabled={saveBlocked || pending} className="space-y-4">
          {/* Row 1: Tòa nhà (khoá) + Sổ quỹ — cùng lưới với form phiếu thường, bỏ ô Phòng. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2" data-field-name="building">
              <label className="text-sm font-medium leading-none" htmlFor="shareholder-advance-building">Tòa nhà</label>
              <Input id="shareholder-advance-building" value={buildingName?.trim() || ADVANCE_BUILDING_NAME} readOnly disabled />
            </div>

            <FormField control={form.control} name="accountId" render={({ field, fieldState }) => (
              <FormItem data-field-name={field.name}>
                <FormLabel>Sổ quỹ *</FormLabel>
                <FormControl>
                  <SearchableSelect
                    name={field.name}
                    aria-invalid={!!fieldState.error}
                    value={field.value || undefined}
                    onValueChange={field.onChange}
                    placeholder="Chọn sổ quỹ bạn đang giữ"
                    searchPlaceholder="Tìm sổ quỹ..."
                    options={options.accounts.map((account) => ({ value: account.account_id, label: account.name }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>

          {/* Row 2: Người nhận (dropdown cổ đông được tạm ứng) + Ngày */}
          <div className="grid grid-cols-2 gap-3">
            <FormField control={form.control} name="shareholderId" render={({ field, fieldState }) => (
              <FormItem data-field-name={field.name}>
                <FormLabel>Tên người nhận *</FormLabel>
                <FormControl>
                  <SearchableSelect
                    name={field.name}
                    aria-invalid={!!fieldState.error}
                    value={field.value || undefined}
                    onValueChange={(next) => { field.onChange(next); setFailure(null); }}
                    placeholder="Chọn cổ đông được tạm ứng"
                    searchPlaceholder="Tìm người nhận..."
                    options={options.payees.map((row) => ({ value: row.shareholder_id, label: row.is_self ? `${row.name} (bạn)` : row.name }))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="voucherDate" render={({ field }) => (
              <FormItem data-field-name={field.name}>
                <FormLabel>Ngày thực chi *</FormLabel>
                <FormControl>
                  <DateSegmentInput value={field.value || ''} onChange={field.onChange} onBlur={field.onBlur} name={field.name} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>

          <FormField control={form.control} name="note" render={({ field, fieldState }) => (
            <FormItem data-field-name={field.name}>
              <FormLabel>Ghi chú</FormLabel>
              <FormControl>
                <Textarea {...field} rows={3} maxLength={PROFIT_PAYOUT_NOTE_MAX} aria-invalid={!!fieldState.error} placeholder="Không bắt buộc" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          {/* Hạng mục: đúng một dòng "Tạm Ứng" — không thêm hạng mục khác, không kỳ áp dụng. */}
          <div className="space-y-3">
            <FormLabel>Hạng mục</FormLabel>
            <FormField control={form.control} name="amount" render={({ field, fieldState }) => (
              <FormItem data-field-name={field.name}>
                <div className={isMobile ? 'grid grid-cols-2 gap-2 items-end rounded-lg border p-2' : 'grid grid-cols-[1fr_160px_36px] gap-2 items-center rounded-lg border p-2'}>
                  <p className={isMobile ? 'text-sm font-medium truncate col-start-1 row-start-1 self-center' : 'text-sm font-medium truncate'}>{typeName}</p>
                  <div className={isMobile ? 'col-span-2' : undefined}>
                    {isMobile && <span className="mb-1 block text-[11px] text-muted-foreground">Số tiền</span>}
                    <FormControl>
                      <CurrencyInput
                        name={field.name}
                        aria-invalid={!!fieldState.error}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        className={fieldState.error ? 'h-8 border-destructive' : 'h-8'}
                        placeholder="Số tiền"
                      />
                    </FormControl>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={isMobile ? 'shrink-0 h-8 w-8 text-destructive hover:text-destructive col-start-2 row-start-1 self-center justify-self-end' : 'shrink-0 h-8 w-8 text-destructive hover:text-destructive'}
                    aria-label={`Bỏ hạng mục ${typeName}`}
                    title="Bỏ hạng mục này để lập phiếu chi thường"
                    onClick={onExit}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <FormMessage />
              </FormItem>
            )} />
            <div className="flex justify-end pt-2 border-t">
              <p className="text-sm font-semibold">
                Tổng cộng: <span className="text-red-600">{(amount ?? 0).toLocaleString('vi-VN')} đ</span>
              </p>
            </div>
          </div>

          <ShareholderAdvancePreviewBox
            loading={!!shareholderId && previewQuery.isFetching && !preview}
            refreshing={previewMatches && previewQuery.isFetching}
            error={previewQuery.isError ? profitLedgerErrorMessage(previewQuery.error, 'preview').message : null}
            onRetry={() => { void previewQuery.refetch(); }}
            preview={preview}
            showAfter={previewMatches}
          />
        </fieldset>

        {rootPreviewError && <p role="alert" className="text-sm text-destructive">{rootPreviewError}</p>}
        {failure && <p role="alert" className="text-sm text-destructive" data-testid="shareholder-advance-failure">{failure.message}</p>}

        <div
          className={isMobile
            ? 'sticky bottom-0 -mx-4 -mb-4 px-4 py-3 bg-white border-t border-zinc-200 flex gap-2 items-center'
            : 'flex justify-end gap-3 pt-4'}
          style={isMobile ? { paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' } : undefined}
        >
          <Button type="button" variant="outline" className={isMobile ? 'flex-1' : ''} disabled={pending} onClick={onClose}>
            Huỷ bỏ
          </Button>
          {saveBlocked ? (
            // Đối chiếu: gửi lại ĐÚNG nội dung với khoá cũ — máy chủ trả biên nhận cũ nếu đã lập.
            <Button type="submit" variant="secondary" className={isMobile ? 'flex-1' : ''} disabled={pending}>
              Kiểm tra lại kết quả
            </Button>
          ) : (
            <Button type="submit" className={isMobile ? 'flex-1' : ''} disabled={locked || pending} data-testid="shareholder-advance-save">
              {pending ? 'Đang lưu...' : 'Lưu'}
            </Button>
          )}
        </div>
      </form>
    </Form>
  );
}

export default ShareholderAdvanceVoucherPanel;
