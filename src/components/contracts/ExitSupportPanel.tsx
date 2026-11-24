import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useReverseContractExitSupport } from '@/hooks/contracts/useContractExitEarlyTerms';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { canReverseExitSupport, contractNumberLabel, type ContractExitEarlyTerms } from '@/lib/contractExitEarlyTerms';

const vnd = (value: number) => new Intl.NumberFormat('vi-VN').format(value);

/** Đảo số tiền khách cũ hỗ trợ khách mới (vd khách nhận huỷ, ghi nhầm số), bắt buộc lý do. */
export function ExitSupportReverseDialog({ terms, open, onOpenChange }: {
  terms: ContractExitEarlyTerms; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const reverse = useReverseContractExitSupport();
  const [reason, setReason] = useState('');
  const requestIds = useRef(new Map<string, string>());
  const ready = !!reason.trim();
  const submit = async () => {
    if (!ready) return;
    const intent = JSON.stringify({ case: terms.exit_case_id, version: terms.version, reason: reason.trim() });
    let requestId = requestIds.current.get(intent);
    if (!requestId) { requestId = crypto.randomUUID(); requestIds.current.set(intent, requestId); }
    try {
      await reverse.mutateAsync({ caseId: terms.exit_case_id, expectedVersion: terms.version, requestId, reason: reason.trim() });
      onOpenChange(false);
    } catch { /* Hook đã báo lỗi; giữ lý do đang nhập để thử lại. */ }
  };
  return <Dialog open={open} onOpenChange={value => { if (!reverse.isPending) onOpenChange(value); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Đảo số tiền khách cũ hỗ trợ</DialogTitle>
        <DialogDescription>
          Huỷ cặp phiếu chuyển cọc {vnd(terms.support_amount)} đ. Cọc của {contractNumberLabel(terms.old_contract_number)} tăng lại và cọc
          của {contractNumberLabel(terms.new_contract_number)} giảm đúng số đó (khách mới phải nộp thêm phần này). Sau khi đảo mới đổi
          trường hợp hoặc xoá hợp đồng khách nhận được.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <div className="space-y-1">
          <Label htmlFor={`${id}-reason`}>Lý do đảo <span className="text-destructive">*</span></Label>
          <Textarea id={`${id}-reason`} rows={2} value={reason} disabled={reverse.isPending} aria-invalid={!ready}
            onChange={event => setReason(event.target.value)} placeholder="Ví dụ: khách nhận huỷ, ghi nhầm số" />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={reverse.isPending} onClick={() => onOpenChange(false)}>Huỷ</Button>
          <Button type="button" variant="destructive" disabled={!ready || reverse.isPending} onClick={() => void submit()}>
            {reverse.isPending ? 'Đang đảo…' : 'Đảo số hỗ trợ'}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

/** Dòng số hỗ trợ ở khối hồ sơ trả phòng / bước trường hợp; nút đảo cho người có quyền thanh lý ở toà. */
export function ExitSupportSummary({ terms, disabled }: { terms: ContractExitEarlyTerms; disabled?: boolean }) {
  if (!(terms.support_amount > 0)) return null;
  return <ExitSupportSummaryRow terms={terms} disabled={disabled} />;
}
function ExitSupportSummaryRow({ terms, disabled }: { terms: ContractExitEarlyTerms; disabled?: boolean }) {
  const { data: permissions } = useMyPermissions();
  const [open, setOpen] = useState(false);
  const codes = [terms.support_out_code, terms.support_in_code].filter(Boolean).join(' / ');
  const canReverse = canReverseExitSupport(terms) && canUse(permissions, 'contracts', 'terminate', terms.building_id);
  return <div className="flex flex-wrap items-center justify-between gap-2" data-testid="exit-support-summary">
    <p>Khách cũ hỗ trợ khách mới: <strong>{vnd(terms.support_amount)} đ</strong> · đã cấn sang cọc {contractNumberLabel(terms.new_contract_number)}
      {codes && <span className="text-muted-foreground"> (phiếu {codes})</span>}</p>
    {canReverse && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>Đảo số hỗ trợ</Button>}
    {open && <ExitSupportReverseDialog terms={terms} open={open} onOpenChange={setOpen} />}
  </div>;
}
