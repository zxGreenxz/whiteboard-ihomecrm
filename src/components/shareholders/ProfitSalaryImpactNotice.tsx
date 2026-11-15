// Mục "Ảnh hưởng tới lương và sổ tổng" trong hộp Mở khoá / Đặt lại / Chốt lại tháng lợi nhuận (E14):
// ai đã nhận phần lợi nhuận của tháng qua phiếu lương (bao nhiêu, phiếu nào, trạng thái), và sổ tổng
// của từng cổ đông sẽ thành bao nhiêu. Có mục ⇒ phải tick "tôi hiểu" mới bấm được. Đang tải / lỗi ⇒
// màn gọi KHOÁ nút (đóng an toàn) — mục này hiện câu lỗi + Thử lại.

import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { profitLedgerErrorMessage } from '@/lib/profitLedger/errors';
import { ledgerBalanceText, voucherStateLabel } from '@/lib/profitLedger/ownerLedgerView';
import type { UnlockPaidViaSalary, UnlockSalaryImpact } from '@/lib/profitLedger/salaryReaders';
import { formatVND } from '@/lib/utils';

export type SalaryImpactMode = 'UNLOCK' | 'RESET' | 'RECLOSE';

export interface SalaryImpactQueryLike {
  data: UnlockSalaryImpact | undefined;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

export interface ProfitSalaryImpactNoticeProps {
  mode: SalaryImpactMode;
  query: SalaryImpactQueryLike;
  needsAck: boolean;
  acked: boolean;
  onAckChange: (acked: boolean) => void;
  disabled?: boolean;
}

const ACTION_LABEL: Readonly<Record<SalaryImpactMode, string>> = {
  UNLOCK: 'mở khoá',
  RESET: 'đặt lại',
  RECLOSE: 'chốt lại',
};

function voucherList(row: UnlockPaidViaSalary): string {
  const parts = row.salary_voucher_ids.map((id, index) => {
    const code = row.salary_voucher_codes[index] ?? 'phiếu chưa có mã';
    const state = row.voucher_states.find((s) => s.salary_voucher_id === id);
    return state ? `${code} (${voucherStateLabel(state.approval_status, state.posting_status).toLowerCase()})` : code;
  });
  return parts.join(', ');
}

export function ProfitSalaryImpactNotice({ mode, query, needsAck, acked, onAckChange, disabled }: ProfitSalaryImpactNoticeProps) {
  const action = ACTION_LABEL[mode];
  const impact = query.data;
  return (
    <section
      aria-label="Ảnh hưởng tới lương và sổ tổng"
      data-testid="profit-salary-impact"
      className="space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="font-medium text-foreground">Ảnh hưởng tới lương và sổ tổng</p>
      {query.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-destructive">{profitLedgerErrorMessage(query.error, 'read').message}</p>
          <p className="text-muted-foreground">Chưa kiểm được ai đã nhận phần lợi nhuận này qua lương — tạm khoá nút để an toàn.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => { void query.refetch(); }}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />Thử lại
          </Button>
        </div>
      ) : !impact || query.isFetching ? (
        <p className="text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang kiểm ai đã nhận phần lợi nhuận tháng này qua lương…</p>
      ) : (
        <ImpactBody mode={mode} impact={impact} />
      )}
      {needsAck && impact && !query.isError && (
        <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
          <Checkbox
            checked={acked}
            onCheckedChange={(value) => onAckChange(value === true)}
            aria-label="Đã hiểu ảnh hưởng tới lương và sổ tổng"
            disabled={disabled}
          />
          <span>
            Tôi hiểu: {action} làm đổi phần lợi nhuận đã trả qua lương
            {mode === 'RECLOSE' ? '' : ' và số dư sổ tổng'} của những người trên.
          </span>
        </label>
      )}
    </section>
  );
}

function ImpactBody({ mode, impact }: { mode: SalaryImpactMode; impact: UnlockSalaryImpact }) {
  const paid = impact.paid_via_salary;
  const effects = mode === 'RECLOSE'
    ? []
    : impact.ledger_effects.filter((effect) => effect.allocations_removed !== 0 || effect.settled_by_marker);
  if (paid.length === 0 && effects.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="profit-salary-impact-empty">
        Không ai nhận phần lợi nhuận tháng này qua lương{mode === 'RECLOSE' ? '.' : '; sổ tổng không đổi.'}
      </p>
    );
  }
  return (
    <div className="max-h-56 space-y-2 overflow-y-auto">
      {paid.length > 0 && (
        <ul className="space-y-1" data-testid="profit-salary-impact-paid">
          {paid.map((row) => (
            <li key={row.shareholder_id}>
              <strong>{row.name}</strong> đã nhận <strong>{formatVND(row.investment)}</strong> lợi nhuận tháng này qua lương
              {row.advance_offset !== 0 && <> · lương bù tạm ứng {formatVND(row.advance_offset)}</>}
              {row.salary_voucher_ids.length > 0 && <> — phiếu {voucherList(row)}</>}
              {row.needs_review_count > 0 && (
                <span className="ml-1 rounded bg-amber-100 px-1 text-xs font-medium text-amber-800">cần xem lại ({row.needs_review_count})</span>
              )}
              {row.offset_conflict === true && (
                <span className="ml-1 rounded bg-amber-100 px-1 text-xs font-medium text-amber-800">phần bù tạm ứng đang lệch bảng lương</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {mode === 'RECLOSE' && paid.length > 0 && (
        <p className="text-amber-700">
          Chốt lại thay phần lợi nhuận của tháng này. Phần đã trả qua lương giữ nguyên; phần mới nhỏ hơn thì người đó thành tạm ứng.
        </p>
      )}
      {effects.length > 0 && (
        <ul className="space-y-1" data-testid="profit-salary-impact-ledger">
          {effects.map((effect) => (
            <li key={effect.shareholder_id}>
              {effect.name}: {effect.settled_by_marker ? (
                <span className="text-muted-foreground">tháng nằm trong mốc đã trả đủ — sổ tổng không đổi</span>
              ) : (
                <>
                  sổ tổng {ledgerBalanceText(effect.balance_now)} → <strong>{ledgerBalanceText(effect.balance_after)}</strong>
                  {effect.becomes_advance && (
                    <span className="ml-1 rounded bg-destructive/10 px-1 text-xs font-medium text-destructive">thành tạm ứng</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ProfitSalaryImpactNotice;
