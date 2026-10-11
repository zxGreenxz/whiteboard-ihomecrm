import { Textarea } from '@/components/ui/textarea';
import { formatVND } from '@/lib/utils';
import { COMMISSION_REASON_MAX, commissionNeedsReason, commissionReasonValid } from '@/lib/commissionCreationPolicy';

interface Props {
  kind: 'broker' | 'sale'; amount: number; defaultAmount: number | null;
  reason: string; onReason: (value: string) => void; showError?: boolean; gross?: boolean; requireReason?: boolean;
}

export function CommissionAmountReview({ kind, amount, defaultAmount, reason, onReason, showError = false, gross = false, requireReason = false }: Props) {
  const required = requireReason || commissionNeedsReason(amount, defaultAmount);
  const invalid = required && showError && !commissionReasonValid(reason);
  const label = kind === 'broker' ? 'hoa hồng' : 'thưởng Sale';
  const id = `commission-reason-${kind}`;
  const delta = defaultAmount === null ? null : amount - defaultAmount;
  return <div className="col-span-full space-y-2 rounded border bg-muted/30 p-3 text-sm" aria-label={`Đối chiếu ${label}`}>
    <p>Mặc định: <b>{defaultAmount === null ? 'Chưa có cấu hình' : formatVND(defaultAmount)}</b> · {gross ? 'Quyền lợi đang nhập' : 'Số tiền đang nhập'}: <b>{formatVND(amount)}</b> · Chênh lệch: <b>{delta === null ? 'Chưa xác định' : `${delta > 0 ? '+' : ''}${formatVND(delta)}`}</b></p>
    {gross && <p className="text-xs text-muted-foreground">Đối chiếu quyền lợi trước khấu trừ. Khoản giữ theo lịch hỗ trợ đã lưu được thể hiện riêng bên dưới.</p>}
    {required && <div className="space-y-1">
      <label htmlFor={id} className="font-medium">Lý do điều chỉnh {label} *</label>
      <Textarea id={id} name={id} value={reason} onChange={event => onReason(event.target.value)} maxLength={COMMISSION_REASON_MAX}
        aria-invalid={invalid} aria-describedby={`${id}-help`} placeholder="Nêu thỏa thuận hoặc căn cứ của số tiền này" />
      <p id={`${id}-help`} className={invalid ? 'text-destructive' : 'text-xs text-muted-foreground'} role={invalid ? 'alert' : undefined}>Nhập lý do từ 8 đến 2000 ký tự. Lý do được lưu cùng yêu cầu tạo phiếu.</p>
    </div>}
  </div>;
}
