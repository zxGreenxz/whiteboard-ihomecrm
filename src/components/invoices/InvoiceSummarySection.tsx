import { useMemo } from 'react';
import { Control, UseFormRegister, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { useExcessAmount } from '@/hooks/useInvoices';
import { formatCurrency } from '@/lib/utils';
import type { InvoiceFormData } from '@/types/invoice';

interface InvoiceSummarySectionProps {
  control: Control<InvoiceFormData>;
  register: UseFormRegister<InvoiceFormData>;
  watch: UseFormWatch<InvoiceFormData>;
  setValue: UseFormSetValue<InvoiceFormData>;
  contractId?: string;
}

const InvoiceSummarySection = ({
  watch,
  setValue,
  contractId,
}: InvoiceSummarySectionProps) => {
  const items = watch('items') || [];
  const discountAmount = watch('discount_amount') || 0;
  const taxPercent = watch('tax_percent') || 0;
  const prepaidAmount = watch('prepaid_amount') || 0;

  const { data: excessBalance = 0 } = useExcessAmount(contractId);

  const totals = useMemo(() => {
    const subtotal = items.reduce(
      (sum, item) => sum + (item.unit_price || 0) * (item.quantity || 0) * (item.coefficient || 1),
      0,
    );
    const taxAmount = subtotal * taxPercent / 100;
    const total = subtotal - discountAmount + taxAmount;
    const remaining = total - prepaidAmount;
    return { subtotal, taxAmount, total, remaining };
  }, [items, discountAmount, taxPercent, prepaidAmount]);

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Tổng kết</h3>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 max-w-md ml-auto text-sm">
        {/* Tạm tính - read only */}
        <Label className="text-muted-foreground self-center">Tạm tính</Label>
        <div className="text-right font-medium">{formatCurrency(totals.subtotal)}</div>

        {/* Giảm giá - editable */}
        <Label htmlFor="discount_amount" className="self-center">Giảm giá</Label>
        <CurrencyInput
          value={watch('discount_amount')}
          onChange={(v) => setValue('discount_amount', v, { shouldValidate: true, shouldDirty: true })}
          className="h-8 text-sm text-right"
        />

        {/* Thuế % - editable */}
        <Label htmlFor="tax_percent" className="self-center">Thuế %</Label>
        <NumberInput
          value={watch('tax_percent')}
          onChange={(v) => setValue('tax_percent', v, { shouldValidate: true, shouldDirty: true })}
          allowDecimal
          min={0}
          max={100}
          className="h-8 text-sm text-right"
        />

        {/* Tiền thuế - read only */}
        <Label className="text-muted-foreground self-center">Tiền thuế</Label>
        <div className="text-right font-medium">{formatCurrency(totals.taxAmount)}</div>

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
