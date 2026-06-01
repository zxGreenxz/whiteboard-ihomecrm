import { useEffect, useMemo, useRef, useState } from 'react';
import { Control, UseFormRegister, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { Loader2, RotateCcw } from 'lucide-react';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useExcessAmount } from '@/hooks/useInvoices';
import { formatCurrency } from '@/lib/utils';
import { computePreviousDebt } from '@/lib/invoiceHelpers';
import { DiscountNoteTrigger } from './DiscountNoteTrigger';
import type { InvoiceFormData, PreviousDebtSource } from '@/types/invoice';

interface InvoiceSummarySectionProps {
  control: Control<InvoiceFormData>;
  register: UseFormRegister<InvoiceFormData>;
  watch: UseFormWatch<InvoiceFormData>;
  setValue: UseFormSetValue<InvoiceFormData>;
  contractId?: string;
  /** Khi edit HĐ hiện có — loại HĐ này khỏi nguồn nợ cũ. */
  excludeInvoiceId?: string;
}

const InvoiceSummarySection = ({
  watch,
  setValue,
  contractId,
  excludeInvoiceId,
}: InvoiceSummarySectionProps) => {
  const items = watch('items') || [];
  const discountAmount = watch('discount_amount') || 0;
  const discountNotes = watch('discount_notes') || '';
  const prepaidAmount = watch('prepaid_amount') || 0;
  const previousDebt = watch('previous_debt') || 0;
  const previousDebtSources = (watch('previous_debt_sources') ?? []) as PreviousDebtSource[];

  const { data: excessBalance = 0 } = useExcessAmount(contractId);

  // Auto-fill discount + note + applied_credit khi contract thay đổi và có
  // credit. Chỉ fill nếu user chưa chỉnh discount manually (discount đang = 0).
  const autoFilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!contractId) {
      autoFilledRef.current = null;
      return;
    }
    if (autoFilledRef.current === contractId) return;
    if (excessBalance <= 0) return;
    if (discountAmount > 0) {
      // User đã có discount khác → không ghi đè.
      autoFilledRef.current = contractId;
      return;
    }
    setValue('discount_amount', excessBalance, { shouldDirty: true });
    setValue('discount_notes', `Nợ ${excessBalance.toLocaleString('vi-VN')} Tiền Thối`, {
      shouldDirty: true,
    });
    setValue('applied_credit', excessBalance, { shouldDirty: true });
    autoFilledRef.current = contractId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, excessBalance]);

  // Nợ cũ — auto-fill khi đổi contract, chỉ ghi đè nếu user chưa chỉnh tay.
  const previousDebtFilledRef = useRef<string | null>(null);
  const previousDebtDirtyRef = useRef(false);
  const {
    data: previousDebtBreakdown,
    isFetching: isLoadingDebt,
    refetch: refetchDebt,
  } = useQuery({
    queryKey: ['compute-previous-debt', contractId, excludeInvoiceId],
    queryFn: () => computePreviousDebt(contractId!, { excludeInvoiceId }),
    enabled: !!contractId,
    staleTime: 5_000,
  });

  useEffect(() => {
    if (!contractId) {
      previousDebtFilledRef.current = null;
      previousDebtDirtyRef.current = false;
      return;
    }
    if (previousDebtFilledRef.current === contractId) return;
    if (!previousDebtBreakdown) return;
    if (previousDebtDirtyRef.current) {
      previousDebtFilledRef.current = contractId;
      return;
    }
    setValue('previous_debt', previousDebtBreakdown.total, { shouldDirty: true });
    setValue('previous_debt_sources', previousDebtBreakdown.sources, { shouldDirty: true });
    previousDebtFilledRef.current = contractId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, previousDebtBreakdown]);

  const handleReloadDebt = async () => {
    const { data } = await refetchDebt();
    if (data) {
      setValue('previous_debt', data.total, { shouldDirty: true });
      setValue('previous_debt_sources', data.sources, { shouldDirty: true });
      previousDebtDirtyRef.current = false;
    }
  };

  const totals = useMemo(() => {
    const subtotal = items.reduce(
      (sum, item) => sum + (item.unit_price || 0) * (item.quantity || 0) * (item.coefficient || 1),
      0,
    );
    const total = subtotal - discountAmount + (previousDebt || 0);
    const remaining = total - prepaidAmount;
    return { subtotal, total, remaining };
  }, [items, discountAmount, prepaidAmount, previousDebt]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Tổng kết</h3>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 max-w-md ml-auto text-sm">
        {/* Tạm tính - read only */}
        <Label className="text-muted-foreground self-center">Tạm tính</Label>
        <div className="text-right font-medium">{formatCurrency(totals.subtotal)}</div>

        {/* Giảm trừ (mình nợ khách) - editable + ghi chú tooltip */}
        <Label htmlFor="discount_amount" className="self-center">Giảm trừ</Label>
        <div className="relative">
          <CurrencyInput
            value={watch('discount_amount')}
            onChange={(v) => setValue('discount_amount', v, { shouldValidate: true, shouldDirty: true })}
            className="h-8 text-sm text-right pr-3"
          />
          <DiscountNoteTrigger
            value={discountNotes}
            onChange={(v) => setValue('discount_notes', v, { shouldDirty: true })}
            disabled={discountAmount <= 0}
          />
        </div>

        {/* Nợ cũ (khách nợ mình) - editable + HoverCard breakdown */}
        <Label htmlFor="previous_debt" className="self-center text-red-700">
          Nợ cũ
        </Label>
        <div>
          <HoverCard openDelay={0} closeDelay={100}>
            <HoverCardTrigger asChild>
              <div className="relative flex items-center gap-1">
                <CurrencyInput
                  value={previousDebt}
                  onChange={(v) => {
                    previousDebtDirtyRef.current = true;
                    setValue('previous_debt', v, { shouldValidate: true, shouldDirty: true });
                    // User chỉnh tay → clear sources để DB trigger không cascade
                    // sai (amount đã không khớp). Bấm ↻ để khôi phục.
                    setValue('previous_debt_sources', [], { shouldDirty: true });
                  }}
                  className={`h-8 text-sm text-right ${previousDebt > 0 ? 'text-red-600 font-medium' : ''}`}
                />
                <button
                  type="button"
                  title="Tải lại nợ cũ tự động"
                  onClick={handleReloadDebt}
                  className="text-slate-400 hover:text-amber-600 p-1 rounded"
                  disabled={!contractId || isLoadingDebt}
                >
                  {isLoadingDebt ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </HoverCardTrigger>
            <HoverCardContent className="w-80 text-xs" align="end">
              <div className="font-semibold text-sm mb-2 text-red-700">
                Nợ cũ: {formatCurrency(previousDebt)}
              </div>
              {previousDebtSources.length === 0 ? (
                <p className="text-muted-foreground">Không có nợ cũ (HĐ &lt; 10K được làm tròn bỏ qua).</p>
              ) : (
                <ul className="space-y-1">
                  {previousDebtSources.map((s, i) => (
                    <li key={i} className="flex justify-between gap-2 border-b border-dashed pb-1 last:border-0">
                      <span className="truncate">
                        {s.type === 'deposit' ? '🏠 ' : '📄 '}
                        {s.label}
                      </span>
                      <span className="tabular-nums font-medium">{formatCurrency(s.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
                Khi HĐ này thanh toán đủ, các nguồn nợ trên sẽ tự tất toán (HĐ cũ → PAID, cọc → cập nhật <code>deposit_paid</code>).
              </p>
            </HoverCardContent>
          </HoverCard>
        </div>

        {/* Thành tiền - read only */}
        <Label className="text-muted-foreground self-center font-semibold">Thành tiền</Label>
        <div className="text-right font-semibold">{formatCurrency(totals.total)}</div>

        {/* Trả trước - editable with excess hint */}
        <Label htmlFor="prepaid_amount" className="self-center">Trả trước</Label>
        <div>
          <CurrencyInput
            value={watch('prepaid_amount')}
            onChange={(v) => setValue('prepaid_amount', v, { shouldValidate: true, shouldDirty: true })}
            className="h-8 text-sm text-right"
          />
          {contractId && (
            <p className="text-xs text-muted-foreground mt-1 text-right">
              Tiền thừa hiện có: {formatCurrency(excessBalance)}
            </p>
          )}
        </div>

        {/* Còn lại - read only */}
        <Label className="text-muted-foreground self-center font-semibold">Còn lại</Label>
        <div className="text-right font-semibold text-lg">
          {formatCurrency(totals.remaining)}
        </div>
      </div>
    </div>
  );
};

export default InvoiceSummarySection;
