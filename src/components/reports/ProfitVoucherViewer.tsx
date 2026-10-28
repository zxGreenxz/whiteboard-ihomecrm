// =============================================================================
// ProfitVoucherViewer — mở phiếu từ Báo cáo LN với ĐỦ nút như trang Thu chi (chủ chốt 28/10/2026).
//
// Báo cáo KHÔNG có logic thao tác riêng. Hộp "Thông tin thu/chi", bảng luật nút
// (src/lib/voucherActionRules.ts), bộ xử lý + hộp xác nhận (useVoucherActions / VoucherActionDialogs)
// và Chi nhanh (useQuickExpense) đều là đúng bản trang Thu chi máy tính lẫn điện thoại đang dùng.
// Sửa luồng nào thì sửa ở đó, báo cáo tự theo — chủ dặn "đừng để phân mảnh mất sự thống nhất".
//
// Phần riêng duy nhất: sau mỗi thao tác có thể đã ghi, làm mới các nguồn số của báo cáo mà hook ghi
// của Thu chi không tự làm mới (chúng chỉ làm mới tiền tố ["income-expenses"]).
// =============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import IncomeExpenseDetailDialog from '@/components/income-expenses/IncomeExpenseDetailDialog';
import VoucherActionDialogs from '@/components/income-expenses/VoucherActionDialogs';
import { useIncomeExpenseDetail } from '@/hooks/income-expenses/detailRead';
import { useVoucherActions } from '@/hooks/income-expenses/useVoucherActions';
import { useQuickExpense, type QuickExpenseActions } from '@/hooks/income-expenses/useQuickExpense';

/**
 * Nguồn số của Báo cáo LN mà hook ghi của Thu chi không tự làm mới: cột LN 6 tháng, thanh kiểm chứng
 * (duyệt xong mà không làm mới thì thanh báo lệch engine giả), chip "sau chốt", dòng "Của iHome".
 */
const PROFIT_REPORT_EXTRA_KEYS = [
  ['financial-analysis', 'monthly-pnl'],
  ['profit-verification'],
  ['profit-post-lock'],
  ['landlord-settlement', 'ihome'],
] as const;

function invalidateProfitReportExtras(qc: QueryClient): void {
  for (const queryKey of PROFIT_REPORT_EXTRA_KEYS) void qc.invalidateQueries({ queryKey: [...queryKey] });
}

export default function ProfitVoucherViewer({ voucherId, organizationId, onClose }: {
  voucherId: string;
  /** Công ty đang xem báo cáo — mọi dòng thuộc toà của công ty này; chỉ để tải chi tiết phiếu song song. */
  organizationId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [detailOpen, setDetailOpen] = useState(true);
  // Cùng khoá đọc với hộp chi tiết (chung cache): phiếu đang mở cũng là phiếu bộ thao tác tra loại /
  // phiên bản khi chỉ có id, và hỏi máy chủ trước xem có huỷ được không.
  const detail = useIncomeExpenseDetail(voucherId, true, organizationId);
  const vouchers = useMemo(() => (detail.data ? [detail.data] : []), [detail.data]);
  const refreshReport = useCallback(() => invalidateProfitReportExtras(qc), [qc]);
  const actions = useVoucherActions({ vouchers, onChanged: refreshReport });
  // Chi nhanh: cùng hook với trang Thu chi (phạm vi riêng của báo cáo); chi xong thì làm mới số báo cáo.
  const quick = useQuickExpense('profit-report');
  const quickExpense: QuickExpenseActions = {
    ...quick,
    run: async (rows) => {
      try { await quick.run(rows); } finally { refreshReport(); }
    },
  };

  // Hộp chi tiết gọi onApprove/onCancel… RỒI mới đóng — cùng một lượt cập nhật nên hộp xác nhận đã
  // mở trước khi xét "còn gì đang mở"; chỉ khi mọi hộp đã đóng mới trả quyền về báo cáo.
  const open = detailOpen || actions.anyOpen;
  useEffect(() => {
    if (!open) onClose();
  }, [open, onClose]);

  return (
    <>
      <IncomeExpenseDetailDialog
        open={detailOpen}
        onOpenChange={(next) => { if (!next) setDetailOpen(false); }}
        voucher={null}
        voucherId={voucherId}
        organizationIdHint={organizationId}
        quickExpense={quickExpense}
        onEdit={actions.edit}
        onQuickEdit={actions.quickEdit}
        onApprove={actions.approve}
        onUnapprove={actions.unapprove}
        onCancel={actions.cancel}
        onRestore={actions.restore}
        onCopy={actions.copy}
        onPostApproved={actions.postApproved}
        onReversePosting={actions.reverse}
        onVerify={actions.verify}
        onHistory={actions.history}
        onStopRecurring={actions.stopRecurring}
        cancelEligibility={actions.cancelEligibility}
        incomeCancelEligibility={actions.incomeCancelEligibility}
      />
      <VoucherActionDialogs actions={actions} />
    </>
  );
}
