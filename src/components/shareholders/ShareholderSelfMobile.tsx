import type { Shareholder } from "@/hooks/useShareholders";
import { useMyProfitLedger } from "@/hooks/profit-ledger/useProfitLedgerQueries";
import { shareholderOrganizationId } from "@/lib/profitLedger/selfView";
import { MyProfitLedgerGate, ProfitLedgerOffNotice } from "./MyProfitLedgerGate";
import ShareholderLedgerSelfMobile from "./ShareholderLedgerSelfMobile";
import type { ShareholderSelfAccess } from "./ShareholderLedgerSelfView";

// Tab "Của tôi" MOBILE — cổ đông-partner tự xem phần lợi nhuận của mình, đọc sổ tổng (E3), cùng luật bản
// máy tính ShareholderSelfView: `ready` ⇒ màn sổ tổng; sổ tổng tắt ⇒ một câu, không số nào (thân cũ đọc
// bảng phân bổ đã gỡ ở Đợt 3 — D3.14); máy chủ nói không xem được ⇒ không hiện số nào.
export default function ShareholderSelfMobile({
  me,
  year,
  onYearChange,
  canViewPercent,
  canViewBuildingTotals,
  canAdvanceOwn,
}: {
  me: Shareholder;
  year: number;
  onYearChange: (y: number) => void;
} & ShareholderSelfAccess) {
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
          <ShareholderLedgerSelfMobile
            ledger={ledger}
            access={{ canViewPercent, canViewBuildingTotals, canAdvanceOwn }}
            year={year}
            onYearChange={onYearChange}
          />
        ) : (
          <ProfitLedgerOffNotice />
        )
      }
    </MyProfitLedgerGate>
  );
}
