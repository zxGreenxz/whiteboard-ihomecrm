// Khối xem trước của MỘT phiếu tạm ứng (R4) — dùng chung cho hộp "Chi tạm ứng cho tôi" và chế độ "Tạm Ứng"
// của form Thu chi.
//
// SỐ CỦA CỔ ĐÔNG chỉ hiện khi máy chủ gửi `position` (chính người nhận đang có quyền tạm ứng, hoặc người có
// quyền chi lợi nhuận). Người giữ sổ lập HỘ nhận `position = null`: khối này KHÔNG hiện con số nào của cổ
// đông, chỉ nói phiếu chờ chủ duyệt và lý do chưa lập được (nếu có).
// Ứng vượt lợi nhuận chưa chi chỉ CẢNH BÁO — không chặn (mọi phiếu chờ chủ duyệt). Một câu duy nhất: cảnh báo
// "vượt ước tính các tháng chưa chốt" (ADVANCE_EXCEEDS_ESTIMATE) của máy chủ chỉ có khi đã vượt lợi nhuận chưa chi,
// nên gộp vào câu đó (bỏ con số "ước tính" khó hiểu); máy chủ có báo mà số tính ở đây ra 0 thì lấy số của máy chủ.

import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AdvancePreview } from '@/lib/profitLedger/positionReaders';
import {
  advanceBlockedMessage, advanceOverUnpaid, advancePendingText, isUnpaidNegative, POSITION_LABELS, UNPAID_NEGATIVE_NOTE,
} from '@/lib/profitLedger/positionView';
import { formatVND } from '@/lib/utils';

export function ShareholderAdvancePreviewBox({ loading, refreshing, error, onRetry, preview, showAfter }: {
  loading: boolean;
  /** Đang tính lại (số đang hiện có thể đã cũ — chưa cho gửi). */
  refreshing: boolean;
  error: string | null;
  onRetry: () => void;
  preview: AdvancePreview | null;
  /** Lần xem trước khớp số tiền đang nhập: hiện số sau phiếu này. */
  showAfter: boolean;
}) {
  if (error) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive p-3 text-sm text-destructive">
        <span>{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>Tính lại</Button>
      </div>
    );
  }
  if (loading) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang kiểm tra…</p>;
  if (!preview) return null;
  const { position } = preview;
  const blocked = advanceBlockedMessage(preview.blocked_reason, preview.payee_is_maker);
  const after = showAfter ? position?.after_advance ?? null : null;
  const pendingNow = position ? advancePendingText(position) : null;
  const exceeds = position && after ? preview.warnings.find((w) => w.code === 'ADVANCE_EXCEEDS_ESTIMATE') : undefined;
  const serverOver = exceeds && exceeds.code === 'ADVANCE_EXCEEDS_ESTIMATE' ? exceeds.outstanding_advance ?? 0 : 0;
  const computedOver = position && after ? advanceOverUnpaid(position, after.advance_pending) : 0;
  const over = computedOver > 0 ? computedOver : serverOver;
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm" data-testid="profit-advance-preview">
      {refreshing && (
        <p className="text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />Đang tính lại…</p>
      )}
      {position && (
        <>
          <p data-testid="profit-advance-position">
            {POSITION_LABELS.unpaid}: <strong className={isUnpaidNegative(position) ? 'text-destructive' : undefined}>{formatVND(position.unpaid_profit)}</strong>
            {' · '}{POSITION_LABELS.advance}: <strong>{formatVND(position.advance_outstanding)}</strong>
            {pendingNow ? ` (${pendingNow})` : ''}
          </p>
          {isUnpaidNegative(position) && <p className="text-muted-foreground">{UNPAID_NEGATIVE_NOTE}</p>}
          {after && (
            <p data-testid="profit-advance-after">
              {preview.maker_kind === 'OWNER' ? 'Khi lập phiếu, trước bước duyệt:' : 'Sau phiếu này:'} tạm ứng chờ duyệt <strong>{formatVND(after.advance_pending)}</strong>
              {' · '}tổng tạm ứng <strong>{formatVND(position.advance_outstanding + after.advance_pending)}</strong>
            </p>
          )}
          {over > 0 && (
            <p className="flex gap-1.5 text-amber-700 dark:text-amber-400" data-testid="profit-advance-over">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Ứng vượt lợi nhuận chưa chi {formatVND(over)} — vẫn lập được{preview.maker_kind === 'OWNER' ? '.' : ', phiếu chờ chủ duyệt.'}</span>
            </p>
          )}
        </>
      )}
      {blocked && <p role="alert" className="text-destructive" data-testid="profit-advance-blocked">{blocked}</p>}
      <p className="text-muted-foreground">
        {preview.maker_kind === 'OWNER' ? 'Sau khi lập, chủ duyệt và ghi chi theo sổ quỹ đã chọn.' : preview.payee_is_maker
          ? 'Phiếu chờ chủ duyệt; tiền chưa ra khỏi sổ. Tạm ứng đã duyệt được khấu trừ khi chủ chốt chi lợi nhuận.'
          : 'Bạn lập hộ: phiếu chờ chủ duyệt (người duyệt khác người lập và người nhận); tiền chưa ra khỏi sổ.'}
      </p>
    </div>
  );
}

export default ShareholderAdvancePreviewBox;
