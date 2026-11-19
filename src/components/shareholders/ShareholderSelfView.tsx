import type { Shareholder } from "@/hooks/useShareholders";
import { useMyProfitLedger } from "@/hooks/profit-ledger/useProfitLedgerQueries";
import { shareholderOrganizationId } from "@/lib/profitLedger/selfView";
import { MyProfitLedgerGate, ProfitLedgerOffNotice } from "./MyProfitLedgerGate";
import ShareholderLedgerSelfView, { type ShareholderSelfAccess } from "./ShareholderLedgerSelfView";

/**
 * Tab "Tổng quan" của cổ đông tự xem (máy tính) — đọc sổ tổng (E3):
 *   sổ tổng đang chạy (`ready`: SHADOW/CANONICAL/FROZEN) ⇒ màn sổ tổng (tiền của chính mình);
 *   sổ tổng tắt (`ready = false`) ⇒ một câu, không số nào — thân cũ đọc bảng phân bổ đã gỡ ở Đợt 3 (D3.14);
 *   máy chủ nói không xem được (42501) ⇒ không hiện số nào.
 */
export default function ShareholderSelfView({
  me,
  canViewPercent,
  canViewBuildingTotals,
  canAdvanceOwn,
}: { me: Shareholder } & ShareholderSelfAccess) {
  const organizationId = shareholderOrganizationId(me);
  const ledgerQuery = useMyProfitLedger(organizationId);
  return (
    <MyProfitLedgerGate
      organizationId={organizationId}
      query={ledgerQuery}
      hiddenText="Bạn chưa xem được phần lợi nhuận của mình ở công ty này — liên hệ chủ công ty."
    >
      {(ledger) =>
        ledger.ready ? (
          <ShareholderLedgerSelfView ledger={ledger} access={{ canViewPercent, canViewBuildingTotals, canAdvanceOwn }} />
        ) : (
          <ProfitLedgerOffNotice />
        )
      }
    </MyProfitLedgerGate>
  );
}
