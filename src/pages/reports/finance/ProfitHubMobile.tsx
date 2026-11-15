import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, PieChart, CircleUserRound, Wallet, HandCoins } from "lucide-react";
import { usePersistedState } from "@/hooks/usePersistedState";
import { LoadingState, SkeletonBar } from "@/components/loading/LoadingState";
import type { Shareholder } from "@/hooks/useShareholders";
import type { ProfitManager } from "@/hooks/useProfitManagers";
import { currentYear } from "@/components/shareholders/shareholderUtils";
import { MobileHeader } from "@/components/shareholders/profitMobileShared";
import ProfitDistributionMobile from "@/pages/reports/finance/ProfitDistributionMobile";
import ProfitOverviewMobile from "@/components/shareholders/ProfitOverviewMobile";
import ShareholderSelfMobile from "@/components/shareholders/ShareholderSelfMobile";
import ShareholderAdvanceTab from "@/components/shareholders/ShareholderAdvanceTab";
import ProfitManagerSelfView from "@/components/shareholders/ProfitManagerSelfView";

// Shell MOBILE của trang Báo cáo Lợi Nhuận (/reports/finance/profit-distribution):
// header + bottom tab bar 3 tab (BC Thu Chi · Tổng quan · Của tôi) theo thiết kế
// ProfitMobileC. Tab hiện theo QUYỀN — cùng logic với ProfitHubPage desktop; tab
// quản trị desktop (Chốt LN, Cổ đông & tỷ lệ) không đưa lên mobile. Q9: quản lý
// điều hành luôn có tab "Lương" (tự xem lương) kể cả khi còn tab khác.
// Tab BC Thu Chi tự render header riêng (pill tháng + nút toà + nút lọc — kiểu 1b).
// Đợt 2: tab BC cần thêm quyền xem số toà; tab "Tạm ứng" cho người được cấp riêng quyền tạm ứng
// mà không có tab "Của tôi".

type TabKey = "report" | "overview" | "my" | "advance" | "salary";

/** `?tab=` của trang (tên tab máy tính) → tab điện thoại. */
const TAB_FROM_PARAM: Readonly<Record<string, TabKey>> = {
  report: "report",
  overview: "overview",
  "my-overview": "my",
  "my-advance": "advance",
  "my-salary": "salary",
};

// Shell nền kem dùng cho cả màn chờ (tránh nháy MainLayout desktop lúc chưa biết quyền).
// z-40 CHỦ Ý: dialog Radix (z-50, portal cuối body) phải nổi LÊN TRÊN shell.
function MobileShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#f5f3ee] text-[#1b1813]">
      {children}
    </div>
  );
}

// Chờ quyền/hồ sơ: shell kem giữ nguyên, tiêu đề + thẻ số là khối xám — không vòng xoay
// + chữ "Đang tải báo cáo…" (chủ chốt 02/10/2026); câu đó chỉ cho trình đọc màn hình.
export function ProfitMobileBoot() {
  return (
    <MobileShell>
      <div className="flex-1 overflow-hidden px-4 pt-5">
        <div className="ld-appear mb-3 flex flex-col gap-2" aria-hidden="true">
          <SkeletonBar className="h-5" style={{ width: "42%" }} />
          <SkeletonBar className="h-3" style={{ width: "28%" }} />
        </div>
        <LoadingState label="báo cáo" variant="cards" rows={4} />
      </div>
    </MobileShell>
  );
}

export default function ProfitHubMobile({
  canReport,
  isManager,
  me,
  myManager,
  canViewBuildingTotals,
  canViewPercent,
  canAdvanceOwn,
  requestedTab = null,
}: {
  canReport: boolean;
  isManager: boolean;
  me: Shareholder | null;
  myManager: ProfitManager | null;
  /** shareholder_profit.view_building_totals — tab BC Thu Chi + thẻ số toà ở "Của tôi". */
  canViewBuildingTotals: boolean;
  /** shareholder_profit.view_percent — tỷ lệ % ở "Của tôi". */
  canViewPercent: boolean;
  /** shareholder_profit.advance_own_cashbook — tạm ứng cho chính mình. */
  canAdvanceOwn: boolean;
  /** `?tab=` của trang (tên tab máy tính); tab không có thì bỏ qua. */
  requestedTab?: string | null;
}) {
  const navigate = useNavigate();
  const goBack = () => navigate(-1);
  // Cổ đông-partner có quyền báo cáo (không phải quản lý) → tab tự-xem "Của tôi"
  // (RLS tự lọc về phần của mình) — cùng điều kiện với desktop [[canSeeOwnShare]].
  const canSeeOwnShare = !!me && canReport && !isManager;
  // Cùng điều kiện với desktop [[canSeeOwnAdvance]].
  const canSeeOwnAdvance = !!me && canAdvanceOwn && !isManager && !canSeeOwnShare;
  const selfAccess = { canViewPercent, canViewBuildingTotals, canAdvanceOwn };

  const tabs: { key: TabKey; label: string; icon: ComponentType<{ className?: string }> }[] = [];
  if (canReport && canViewBuildingTotals) tabs.push({ key: "report", label: "BC Thu Chi", icon: BarChart3 });
  if (isManager) tabs.push({ key: "overview", label: "Tổng quan", icon: PieChart });
  if (canSeeOwnShare) tabs.push({ key: "my", label: "Của tôi", icon: CircleUserRound });
  if (canSeeOwnAdvance) tabs.push({ key: "advance", label: "Tạm ứng", icon: HandCoins });
  if (myManager && tabs.length > 0) tabs.push({ key: "salary", label: "Lương", icon: Wallet });

  const defaultTab: TabKey = canSeeOwnShare ? "my" : tabs[0]?.key ?? "report";
  const [tabRaw, setTabRaw] = usePersistedState<TabKey>("flt:profit-hub-mb:tab", defaultTab);
  // `?tab=` thắng tab đã nhớ cho tới khi người dùng tự bấm tab khác.
  const [urlTab, setUrlTab] = useState<TabKey | null>(() => (requestedTab ? TAB_FROM_PARAM[requestedTab] ?? null : null));
  const setTab = (key: TabKey) => {
    setUrlTab(null);
    setTabRaw(key);
  };
  const tab = [urlTab, tabRaw].find((key): key is TabKey => !!key && tabs.some((t) => t.key === key)) ?? defaultTab;

  // Năm của 2 tab tổng-quan/của-tôi hoisted lên shell để hiện pill "Năm …" trên header.
  const [oYear, setOYear] = useState(currentYear());
  const [sYear, setSYear] = useState(currentYear());

  // Quản lý điều hành thuần (không quyền nào khác) → tự xem lương của mình.
  const managerOnly = tabs.length === 0 && !!myManager;

  const yearPill = (
    <span className="font-mono text-[11px] font-bold text-[#514c42] bg-[#faf8f4] border border-[#e7e3da] px-2.5 py-1 rounded-full">
      Năm {tab === "overview" ? oYear : sYear}
    </span>
  );

  return (
    <MobileShell>
      {tab === "report" && tabs.length > 0 && !managerOnly ? (
        // Tab BC Thu Chi: component tự render header (pill tháng/toà/lọc) + body cuộn.
        <ProfitDistributionMobile onBack={goBack} />
      ) : (
        <>
          <MobileHeader
            onBack={goBack}
            right={!managerOnly && tabs.length > 0 && tab !== "salary" && tab !== "advance" ? yearPill : undefined}
          />
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto w-full max-w-[480px] px-3.5 pt-3 pb-2">
              {managerOnly && myManager ? (
                <ProfitManagerSelfView me={myManager} />
              ) : tabs.length === 0 ? (
                <p className="text-[13px] font-semibold text-[#8d8678] text-center pt-16 px-6">
                  Bạn không có quyền xem báo cáo này. Liên hệ quản trị.
                </p>
              ) : tab === "salary" && myManager ? (
                <ProfitManagerSelfView me={myManager} />
              ) : tab === "overview" ? (
                <ProfitOverviewMobile year={oYear} onYearChange={setOYear} />
              ) : tab === "advance" ? (
                // Nhánh riêng: tab Tạm ứng KHÔNG rơi vào màn "Của tôi" (người này không có quyền xem đó).
                me && <ShareholderAdvanceTab me={me} phone />
              ) : (
                me && <ShareholderSelfMobile me={me} year={sYear} onYearChange={setSYear} {...selfAccess} />
              )}
            </div>
          </div>
        </>
      )}

      {/* Bottom tab bar */}
      {tabs.length > 1 && (
        <div
          className="shrink-0 bg-white border-t border-[#e7e3da]"
          // Cấn bớt safe-area đáy (iPhone ~34px) — để nguyên sẽ thành băng trắng
          // dày dưới nhãn tab khi chạy PWA thêm-vào-màn-hình-chính (chủ chê thừa).
          // Giữ ~20px là vừa né home indicator.
          style={{ paddingBottom: "max(calc(env(safe-area-inset-bottom, 0px) - 14px), 0px)" }}
        >
          <div
            className="mx-auto w-full max-w-[480px] grid gap-1 px-2.5 pt-1 pb-1"
            style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}
          >
            {tabs.map((t) => {
              const active = tab === t.key;
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex flex-col items-center gap-0.5 py-0.5 ${active ? "text-[#1a6645]" : "text-[#8d8678]"}`}
                >
                  <span
                    className={`w-[46px] h-[26px] rounded-full grid place-items-center ${active ? "bg-[#e8f3ec]" : ""}`}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="text-[10px] font-bold tracking-[-0.1px]">{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </MobileShell>
  );
}
