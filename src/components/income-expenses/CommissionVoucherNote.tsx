// =============================================================================
// Ghi chú phiếu hoa hồng — tính LÚC XEM từ facts hợp đồng (quyết định chủ
// 02/09/2026). Dùng chung cho dialog desktop, sheet mobile, trang chi tiết và
// trang in. Phiếu không phải hoa hồng ⇒ chỉ hiện ghi chú DB như cũ.
//
// Ghi chú DB ("Người nhận: X") vẫn hiện BÊN DƯỚI: extractRecipientFromNotes
// đọc nó cho nút chi tiền qua app ngân hàng, và nó là thứ người tạo phiếu gõ.
// =============================================================================

import { useCommissionVoucherFacts } from "@/hooks/useCommissionVoucher";
import { buildCommissionNoteLines } from "@/lib/commissionVoucherNote";

export interface CommissionVoucherRef {
  id: string;
  commission_kind?: "broker" | "sale" | null;
  contract_id?: string | null;
}

/** Phiếu hoa hồng có HĐ — có facts để dựng ghi chú. */
export const laPhieuHoaHong = (v: CommissionVoucherRef): boolean =>
  (v.commission_kind === "broker" || v.commission_kind === "sale") && !!v.contract_id;

interface Props {
  voucher: CommissionVoucherRef;
  /** Ghi chú lưu trong DB (income_expenses.notes). */
  fallbackNotes?: string | null;
  /** Bật/tắt gọi RPC (vd chỉ khi dialog mở). */
  enabled?: boolean;
}

export function CommissionVoucherNote({ voucher, fallbackNotes, enabled = true }: Props) {
  const isCommission = laPhieuHoaHong(voucher);
  const { data: facts, isLoading, isError } = useCommissionVoucherFacts(
    isCommission ? voucher.id : null,
    enabled
  );

  const lines = facts ? buildCommissionNoteLines(facts) : null;
  const notes = fallbackNotes?.trim() || null;

  if (!isCommission) {
    return notes ? <div className="whitespace-pre-line">{notes}</div> : null;
  }

  return (
    <div className="space-y-1">
      {isLoading ? (
        <div className="text-muted-foreground">Đang tính thông tin hợp đồng…</div>
      ) : isError ? (
        <div className="text-muted-foreground">Không đọc được thông tin hợp đồng.</div>
      ) : lines ? (
        <div className="whitespace-pre-line" data-testid="commission-voucher-note">
          {lines.join("\n")}
        </div>
      ) : null}
      {notes ? (
        <div className="whitespace-pre-line text-muted-foreground">{notes}</div>
      ) : null}
    </div>
  );
}

export default CommissionVoucherNote;
