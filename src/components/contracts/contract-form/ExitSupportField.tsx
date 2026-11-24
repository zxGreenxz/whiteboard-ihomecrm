import { useId } from 'react';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { EARLY_REASON_LABELS, contractNumberLabel } from '@/lib/contractExitEarlyTerms';
import { formatISODateVN } from '@/lib/vnDate';
import { formatVND } from './types';
import type { ContractFormState } from './useContractFormState';

type ExitSupportFieldProps = Pick<ContractFormState, 'exitSupport'> & { onAmountChange?: () => void };

/**
 * Ô "Khách cũ hỗ trợ khách mới" ở form tạo hợp đồng, chỉ hiện khi phòng đang chờ khách nhận của hồ sơ trả phòng trước
 * hạn nhờ sale / tự tìm (hợp đồng này sẽ tự nối). Số nhập tính như cọc khách mới đã nộp; máy chủ ghi cặp phiếu chuyển
 * cọc trên sổ nội bộ và kiểm lại hai trần hiện ở đây.
 */
export function ExitSupportField({ exitSupport, onAmountChange }: ExitSupportFieldProps) {
  const id = useId();
  if (exitSupport.readError) {
    return <p role="status" className="text-xs text-muted-foreground">
      Chưa kiểm được phòng có đang chờ khách sang nhượng không, nên chưa ghi được số khách cũ hỗ trợ.{' '}
      <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={exitSupport.retry}>Thử lại</Button>
    </p>;
  }
  const hold = exitSupport.hold;
  if (!hold) return null;
  const caps = exitSupport.caps;
  const fee = hold.early_reason === 'SALE_ASSISTED' ? hold.broker_fee : 0;
  const disabled = !exitSupport.links || !exitSupport.permitted;
  const blockedReason = !exitSupport.links
    ? `Ngày bắt đầu hợp đồng phải từ ${formatISODateVN(hold.actual_move_out_on)} (ngày khách cũ trả phòng) thì hợp đồng mới tự nối và ghi được số hỗ trợ.`
    : !exitSupport.permitted ? 'Cần quyền thanh lý hợp đồng ở toà này để ghi số khách cũ hỗ trợ khách mới.' : null;
  const errorId = `${id}-error`;
  return <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30"
    data-field-name="transfer_support_amount" aria-label="Khách cũ hỗ trợ khách mới" role="group">
    <div className="space-y-0.5">
      <Label htmlFor={`${id}-amount`}>Khách cũ hỗ trợ khách mới</Label>
      <p className="text-xs text-muted-foreground">
        Hồ sơ trả phòng {contractNumberLabel(hold.old_contract_number)}{hold.old_customer_name ? ` (${hold.old_customer_name})` : ''} ·{' '}
        {EARLY_REASON_LABELS[hold.early_reason]}. Số này chuyển từ cọc khách cũ sang cọc hợp đồng này: khách mới nộp ít đi,
        quyết toán khách cũ trả ít đi đúng số đó. Không qua quỹ, không vào doanh thu. Không hỗ trợ thì để trống.
      </p>
    </div>
    <div className="max-w-xs">
      <CurrencyInput id={`${id}-amount`} name="transfer_support_amount" value={exitSupport.amount} disabled={disabled}
        aria-invalid={!!exitSupport.issue} aria-describedby={exitSupport.issue ? errorId : undefined}
        onChange={value => { exitSupport.setAmount(Number(value) || 0); onAmountChange?.(); }} />
    </div>
    {blockedReason && <p className="text-xs text-amber-800 dark:text-amber-200">{blockedReason}</p>}
    {caps && !blockedReason && <p className="text-xs text-muted-foreground" data-testid="exit-support-cap">
      Tối đa {formatVND(caps.cap)}: cọc cũ đã thu {formatVND(hold.old_contract_deposit_paid ?? 0)}
      {fee > 0 ? ` − phí môi giới ${formatVND(fee)}` : ''} = {formatVND(caps.oldCap)}; cọc còn thiếu của hợp đồng này {formatVND(caps.newCap)}.
    </p>}
    {exitSupport.issue && <p id={errorId} role="alert" className="text-sm font-medium text-destructive">{exitSupport.issue}</p>}
  </div>;
}
