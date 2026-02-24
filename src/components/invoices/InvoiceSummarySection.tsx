import { useMemo } from 'react';
import { Control, UseFormRegister, UseFormWatch, UseFormSetValue } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useExcessAmount } from '@/hooks/useInvoices';
import type { InvoiceFormData } from '@/types/invoice';

interface InvoiceSummarySectionProps {
  control: Control<InvoiceFormData>;
  register: UseFormRegister<InvoiceFormData>;
  watch: UseFormWatch<InvoiceFormData>;
  setValue: UseFormSetValue<InvoiceFormData>;
  contractId?: string;
}

const formatVND = (amount: number) =>
  new Intl.NumberFormat('vi-VN').format(Math.round(amount));

const InvoiceSummarySection = ({
  register,
  watch,
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
        <div className="text-right font-medium">{formatVND(totals.subtotal)}</div>

        {/* Giảm giá - editable */}
        <Label htmlFor="discount_amount" className="self-center">Giảm giá</Label>
        <Input
          id="discount_amount"
          type="number"
          min={0}
          className="h-8 text-sm text-right"
          {...register('discount_amount', { valueAsNumber: true })}
        />

        {/* Thuế % - editable */}
        <Label htmlFor="tax_percent" className="self-center">Thuế %</Label>
        <Input
          id="tax_percent"
          type="number"
          min={0}
          max={100}
          step="0.01"
          className="h-8 text-sm text-right"
          {...register('tax_percent', { valueAsNumber: true })}
        />

        {/* Tiền thuế - read only */}
        <Label className="text-muted-foreground self-center">Tiền thuế</Label>
        <div className="text-right font-medium">{formatVND(totals.taxAmount)}</div>

        {/* Thành tiền - read only */}
        <Label className="text-muted-foreground self-center font-semibold">Thành tiền</Label>
        <div className="text-right font-semibold">{formatVND(totals.total)}</div>

        {/* Trả trước - editable with excess hint */}
        <Label htmlFor="prepaid_amount" className="self-center">Trả trước</Label>
        <div>
          <Input
            id="prepaid_amount"
            type="number"
            min={0}
            className="h-8 text-sm text-right"
            {...register('prepaid_amount', { valueAsNumber: true })}
          />
          {contractId && (
            <p className="text-xs text-muted-foreground mt-1 text-right">
              Tiền thừa hiện có: {formatVND(excessBalance)}
            </p>
          )}
        </div>

        {/* Còn lại - read only */}
        <Label className="text-muted-foreground self-center font-semibold">Còn lại</Label>
        <div className="text-right font-semibold text-lg">
          {formatVND(totals.remaining)}
        </div>
      </div>
    </div>
  );
};

export default InvoiceSummarySection;
