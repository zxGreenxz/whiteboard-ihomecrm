// Vị thế của CHÍNH cổ đông đang đăng nhập (R2) đã quy về bốn trạng thái mà các màn tự xem cần để vẽ:
// có số · đang tải lần đầu · lỗi đọc (kèm câu tiếng Việt) · máy chủ nói không xem được (không số, không lỗi).
// Màn hình không bao giờ hiện 0 thay cho số chưa đọc được.

import { useMyShareholderPosition } from '@/hooks/profit-ledger/useProfitLedgerQueries';
import { profitLedgerErrorMessage } from '@/lib/profitLedger/errors';
import type { MyShareholderPosition } from '@/lib/profitLedger/positionReaders';

export interface MyPositionView {
  /** null = chưa có số (đang tải, lỗi, hoặc máy chủ nói không xem được). */
  position: MyShareholderPosition | null;
  /** Đang tải lần đầu. */
  pending: boolean;
  /** Câu báo lỗi đọc (null khi không lỗi). */
  errorMessage: string | null;
  retry: () => void;
}

export function useMyPositionView(organizationId: string | null, options: { enabled?: boolean } = {}): MyPositionView {
  const query = useMyShareholderPosition(organizationId, options);
  return {
    position: query.data ?? null,
    pending: !!organizationId && (options.enabled ?? true) && query.data === undefined && !query.isError,
    errorMessage: query.isError ? profitLedgerErrorMessage(query.error, 'read').message : null,
    retry: () => { void query.refetch(); },
  };
}
