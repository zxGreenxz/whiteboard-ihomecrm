// Thẻ số dư sổ tổng trong màn Chờ duyệt (D2.9) — chỉ dựng cho phiếu chi theo sổ tổng (nguồn
// profit.ledger_payout / profit.manager_salary). Đọc E7 (profit_ledger_payout_detail_v1): lúc lập còn phải
// trả bao nhiêu, phần nào tạm ứng; bây giờ (không tính phiếu này) ra sao; khi nào duyệt sẽ bị từ chối.
// E7 lỗi ⇒ báo tại chỗ (không che bằng số 0), nút Duyệt của dòng tự khoá theo cùng câu hỏi.

import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProfitLedgerPayoutDetail } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { ledgerApprovalGate, ledgerApprovalNoteView } from '@/lib/profitLedger/approvalGate';
import { profitLedgerErrorMessage } from '@/lib/profitLedger/errors';

export interface ProfitLedgerApprovalNoteProps {
  voucherId: string;
  className?: string;
}

export function ProfitLedgerApprovalNote({ voucherId, className }: ProfitLedgerApprovalNoteProps) {
  const detail = useProfitLedgerPayoutDetail(voucherId);
  const box = `rounded-md border px-3 py-2 text-xs ${className ?? ''}`;

  if (detail.isPending) {
    return (
      <p role="status" className={`${box} flex items-center gap-1.5 text-muted-foreground`} data-testid="ledger-approval-note">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Đang tải số dư sổ tổng…
      </p>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div role="alert" className={`${box} border-destructive text-destructive`} data-testid="ledger-approval-note">
        <p>{profitLedgerErrorMessage(detail.error, 'read').message} Chưa duyệt được phiếu này ở đây.</p>
        <Button type="button" size="sm" variant="outline" className="mt-1.5 h-7" onClick={() => { void detail.refetch(); }}>
          Thử lại
        </Button>
      </div>
    );
  }

  const view = ledgerApprovalNoteView(detail.data);
  const gate = ledgerApprovalGate(detail.data);
  return (
    <div className={`${box} space-y-0.5 bg-muted/30`} data-testid="ledger-approval-note">
      <p className="font-medium text-foreground">{view.title}</p>
      {view.atCreate
        ? <p>{view.atCreate}</p>
        : <p className="text-muted-foreground">Phiếu lập trước sổ tổng — không có số lúc lập.</p>}
      <p>{view.now}</p>
      {view.notes.map((note) => <p key={note} className="text-muted-foreground">{note}</p>)}
      {gate.blockReason && (
        <p className="flex items-start gap-1 font-medium text-amber-700" data-testid="ledger-approval-block">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{gate.blockReason}
        </p>
      )}
    </div>
  );
}

export default ProfitLedgerApprovalNote;
