// Cửa chung trước mọi màn cổ đông TỰ XEM đọc sổ tổng (E3): tab "Tổng quan" (máy tính + điện thoại),
// tab "Tạm ứng LN". Bốn trạng thái, không trạng thái nào hiện 0 đ thay cho số chưa có:
//   chưa biết công ty / đang tải / lỗi (câu tiếng Việt theo mã máy, nút Tải lại) / máy chủ nói không
//   xem được (42501 ⇒ hook trả null: ẩn số, chỉ một câu nhắc) — rồi mới tới dữ liệu.
// Thân con chỉ mount khi đã có E3. Sổ tổng tắt (`ready = false`) ⇒ tab "Tổng quan" tự xem (máy tính + điện thoại)
// dùng ProfitLedgerOffNotice — từ Đợt 3 (D3.14) web không còn thân cũ đọc bảng phân bổ; tab "Tạm ứng LN" tự xử lý
// `ready = false` (ẩn số dư, giữ danh sách phiếu của mình).

import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/loading/LoadingState';
import { profitLedgerErrorMessage } from '@/lib/profitLedger/errors';
import type { MyProfitLedger } from '@/lib/profitLedger/ledgerReaders';

const BOX = 'rounded-md border p-4 text-sm';

/** Câu khi sổ tổng đang tắt (route LEGACY ⇒ E3 `ready = false`): không hiện số nào thay cho số sổ tổng. */
export const PROFIT_LEDGER_OFF_TEXT = 'Sổ lợi nhuận đang tắt ở công ty này nên chưa có số để hiện — liên hệ chủ công ty.';

/** Màn tự xem khi sổ tổng tắt: một câu, không số, không đọc bảng phân bổ cũ. */
export function ProfitLedgerOffNotice() {
  return <p role="status" className={`${BOX} text-muted-foreground`}>{PROFIT_LEDGER_OFF_TEXT}</p>;
}

export function MyProfitLedgerGate({ organizationId, query, hiddenText, children }: {
  /** Công ty của dòng cổ đông; null ⇒ chưa gọi được E3. */
  organizationId: string | null;
  query: Pick<UseQueryResult<MyProfitLedger | null, unknown>, 'data' | 'error' | 'isError' | 'isFetching' | 'refetch'>;
  /** Câu khi máy chủ trả "không xem được" (42501). */
  hiddenText: string;
  children: (ledger: MyProfitLedger) => ReactNode;
}) {
  const reload = () => { void query.refetch(); };
  if (!organizationId) {
    return (
      <div role="alert" className={`${BOX} border-destructive/40`}>
        <p className="font-medium text-destructive">Chưa xác định được công ty của cổ đông.</p>
        <p className="mt-1 text-muted-foreground">Tải lại trang; nếu vẫn vậy, báo chủ công ty kiểm tra hồ sơ cổ đông.</p>
      </div>
    );
  }
  if (query.data === undefined) {
    if (query.isError) {
      return (
        <div role="alert" className={`${BOX} border-destructive/40`}>
          <p className="font-medium text-destructive">Chưa tải được lợi nhuận của bạn.</p>
          <p className="mt-1 text-muted-foreground">{profitLedgerErrorMessage(query.error, 'read').message}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={reload}>Tải lại</Button>
        </div>
      );
    }
    return <LoadingState label="lợi nhuận của bạn" variant="cards" rows={4} />;
  }
  if (query.data === null) {
    return <p role="status" className={`${BOX} text-muted-foreground`}>{hiddenText}</p>;
  }
  return (
    <>
      {query.isError && !query.isFetching && (
        <div role="alert" className="mb-3 rounded-md border border-amber-400 p-3 text-sm">
          <p>Chưa cập nhật được lợi nhuận của bạn — đang hiện kết quả của lần tải trước.</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={reload}>Tải lại</Button>
        </div>
      )}
      {children(query.data)}
    </>
  );
}
