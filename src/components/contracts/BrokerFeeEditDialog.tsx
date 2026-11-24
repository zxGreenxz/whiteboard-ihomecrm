import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateContractExitBrokerFee } from '@/hooks/contracts/useContractExitEarlyTerms';
import type { ContractExitEarlyTerms } from '@/lib/contractExitEarlyTerms';

const vnd = (value: number) => new Intl.NumberFormat('vi-VN').format(value);

/** Sửa phí môi giới của hồ sơ nhờ sale (kể cả về 0) kèm lý do; không vượt cọc đã thu của hợp đồng cũ. */
export function BrokerFeeEditDialog({ terms, open, onOpenChange }: {
  terms: ContractExitEarlyTerms; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const update = useUpdateContractExitBrokerFee();
  const [fee, setFee] = useState<number>(terms.broker_fee);
  const [reason, setReason] = useState('');
  const requestIds = useRef(new Map<string, string>());
  const cap = Math.max(terms.old_contract_deposit_paid ?? 0, 0);
  const overCap = fee > cap;
  const ready = Number.isFinite(fee) && fee >= 0 && !overCap && fee !== terms.broker_fee && !!reason.trim();
  const submit = async () => {
    if (!ready) return;
    const intent = JSON.stringify({ case: terms.exit_case_id, version: terms.version, fee, reason: reason.trim() });
    let requestId = requestIds.current.get(intent);
    if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(intent, requestId); }
    try {
      await update.mutateAsync({ caseId: terms.exit_case_id, expectedVersion: terms.version, requestId, brokerFee: fee, reason: reason.trim() });
      onOpenChange(false);
    } catch { /* Hook đã báo lỗi; giữ số đang nhập. */ }
  };
  return <Dialog open={open} onOpenChange={value => { if (!update.isPending) onOpenChange(value); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Sửa phí môi giới</DialogTitle>
        <DialogDescription>Mặc định 50% cọc theo hợp đồng cũ ({vnd(Math.round(terms.deposit_base * 0.5))} đ). Không vượt cọc đã thu ({vnd(cap)} đ).</DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <div className="space-y-1">
          <Label htmlFor={`${id}-fee`}>Phí môi giới mới</Label>
          <CurrencyInput id={`${id}-fee`} value={fee} onChange={value => setFee(Number(value) || 0)} disabled={update.isPending} />
          {overCap && <p role="alert" className="text-xs text-destructive">Phí không được vượt cọc đã thu {vnd(cap)} đ.</p>}
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-reason`}>Lý do sửa phí <span className="text-destructive">*</span></Label>
          <Textarea id={`${id}-reason`} rows={2} value={reason} disabled={update.isPending} aria-invalid={!reason.trim()}
            onChange={event => setReason(event.target.value)} placeholder="Ví dụ: sale đồng ý nhận ít hơn" />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={update.isPending} onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button type="button" disabled={!ready || update.isPending} onClick={() => void submit()}>{update.isPending ? 'Đang lưu…' : 'Lưu phí'}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
