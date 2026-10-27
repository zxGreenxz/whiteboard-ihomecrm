// =============================================================================
// ProfitVoucherViewer — ADAPTER mở phiếu chi từ Báo cáo LN (chủ chốt 28/10/2026).
//
// Dùng lại NGUYÊN các thành phần của Thu chi — hộp "Thông tin thu/chi", form sửa phiếu chờ duyệt, hộp bổ sung
// chứng từ/ghi chú — và KHÔNG sửa dòng nào của chúng hay của trang Thu chi (khu Hợp đồng & quyết toán từng bị gỡ
// vì sửa thẳng trang Thu chi, xem src/hooks/useSettlementActions.ts). Nhờ vậy chính sách y như Thu chi: nút Sửa chỉ
// hiện khi voucherEditAction cho (phiếu chờ duyệt), máy chủ vẫn chặn quyền / lý do / phiên bản / tháng đã chốt LN.
//
// Chỉ truyền onEdit + onQuickEdit (nút In có sẵn trong hộp). Duyệt / Huỷ duyệt / Huỷ / Khôi phục / Bản sao làm ở
// trang Thu chi: hộp xác nhận của chúng nằm trong trang đó, chép sang đây là sinh bản thứ ba dễ lệch.
// =============================================================================
import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import IncomeExpenseDetailDialog from '@/components/income-expenses/IncomeExpenseDetailDialog';
import IncomeExpenseForm from '@/components/income-expenses/IncomeExpenseForm';
import IncomeExpenseQuickEditDialog from '@/components/income-expenses/IncomeExpenseQuickEditDialog';
import type { IncomeExpenseWithRelations } from '@/hooks/useIncomeExpenses';

type Stage = 'detail' | 'edit' | 'supplement' | 'closed';

/**
 * Nguồn số của Báo cáo LN mà cửa sửa phiếu của Thu chi không tự làm mới (nó chỉ làm mới tiền tố
 * ["income-expenses"]): cột LN 6 tháng, thanh kiểm chứng, chip "sau chốt", dòng "Của iHome".
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
  const [stage, setStage] = useState<Stage>('detail');
  const [target, setTarget] = useState<IncomeExpenseWithRelations | null>(null);

  // Hộp chi tiết gọi onEdit/onQuickEdit RỒI mới onOpenChange(false) — cập nhật dạng hàm để lệnh đóng không đè bước kế.
  const leaveDetail = () => setStage((s) => (s === 'detail' ? 'closed' : s));
  useEffect(() => {
    if (stage === 'closed') onClose();
  }, [stage, onClose]);

  return (
    <>
      <IncomeExpenseDetailDialog
        open={stage === 'detail'}
        onOpenChange={(open) => { if (!open) leaveDetail(); }}
        voucher={null}
        voucherId={voucherId}
        organizationIdHint={organizationId}
        onEdit={(v) => { setTarget(v); setStage('edit'); }}
        onQuickEdit={(v) => { setTarget(v); setStage('supplement'); }}
      />
      <IncomeExpenseForm
        open={stage === 'edit'}
        onOpenChange={(open) => {
          if (open) return;
          invalidateProfitReportExtras(qc);
          setStage('closed');
        }}
        voucher={target}
      />
      <IncomeExpenseQuickEditDialog
        open={stage === 'supplement'}
        onOpenChange={(open) => { if (!open) setStage('closed'); }}
        voucher={target}
      />
    </>
  );
}
