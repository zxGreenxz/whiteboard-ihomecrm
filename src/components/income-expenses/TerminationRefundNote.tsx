/** Shared termination note uses exact authenticated financial facts; raw notes remain labelled reference data. */
import { useTerminationRefundFacts } from "@/hooks/useTerminationRefundFacts";
import { SettlementFinancialNote } from './SettlementFinancialNote';

export const TERMINATION_REFUND_SOURCE = "termination.refund";

export interface TerminationVoucherRef {
  id: string;
  system_source?: string | null;
  contract_id?: string | null;
}

/** Phiếu chi hoàn khách thanh lý có HĐ — có hồ sơ để dựng ghi chú. */
export const laPhieuTraKhachThanhLy = (v: TerminationVoucherRef): boolean =>
  v.system_source === TERMINATION_REFUND_SOURCE && !!v.contract_id;

interface Props {
  voucher: TerminationVoucherRef;
  /** income_expenses.notes — hiện bên dưới, đã xuống dòng. */
  fallbackNotes?: string | null;
  enabled?: boolean;
}

export function TerminationRefundNote({ voucher, fallbackNotes, enabled = true }: Props) {
  const ok = laPhieuTraKhachThanhLy(voucher);
  const { data: facts, isLoading, isError } = useTerminationRefundFacts(ok ? voucher.id : null, enabled);
  const notes = fallbackNotes?.trim() || null;

  if (!ok) {
    return notes ? <div className="whitespace-pre-line">{notes}</div> : null;
  }



  return (
    <div className="space-y-2">
      {isLoading ? (
        <div className="text-muted-foreground">Đang tính bản quyết toán…</div>
      ) : isError ? (
        <div className="text-muted-foreground">Không đọc được hồ sơ thanh lý.</div>
      ) : facts ? (
        <div className="whitespace-pre-line" data-testid="termination-refund-note">
          <SettlementFinancialNote context={facts} />
        </div>
      ) : null}
      {notes ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Ghi chú gốc của phiếu</summary>
          <div className="whitespace-pre-line mt-1">{notes}</div>
        </details>
      ) : null}
    </div>
  );
}

export default TerminationRefundNote;
