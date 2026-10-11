import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { COMMISSION_REASON_MAX, COMMISSION_REASON_MESSAGE } from '@/lib/commissionAudit';

export function CommissionReasonField({ id, value, onChange, error, label = 'Lý do thay đổi hoa hồng', disabled = false }: {
  id: string; value: string; onChange: (value: string) => void; error?: boolean; label?: string; disabled?: boolean;
}) {
  return <div className="space-y-1.5">
    <Label htmlFor={id}>{label} <span className="text-destructive">*</span></Label>
    <Textarea id={id} value={value} onChange={event => onChange(event.target.value)} maxLength={COMMISSION_REASON_MAX}
      disabled={disabled} aria-invalid={!!error} aria-describedby={`${id}-help`} placeholder="Nêu rõ vì sao cần thay đổi và nội dung đã thống nhất." />
    <p id={`${id}-help`} className={error ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'} role={error ? 'alert' : undefined}>
      {error ? COMMISSION_REASON_MESSAGE : 'Lý do được lưu cùng giá trị trước/sau, giai đoạn, người thực hiện và ngày giờ.'}
    </p>
  </div>;
}
