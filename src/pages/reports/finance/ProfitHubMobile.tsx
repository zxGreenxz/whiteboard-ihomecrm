import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, PieChart, CircleUserRound } from "lucide-react";
import { usePersistedState } from "@/hooks/usePersistedState";
import type { Shareholder } from "@/hooks/useShareholders";
import type { ProfitManager } from "@/hooks/useProfitManagers";
import { currentYear } from "@/components/shareholders/shareholderUtils";
import { MobileHeader } from "@/components/shareholders/profitMobileShared";
import ProfitDistributionMobile from "@/pages/reports/finance/ProfitDistributionMobile";
import ProfitOverviewMobile from "@/components/shareholders/ProfitOverviewMobile";
import ShareholderSelfMobile from "@/components/shareholders/ShareholderSelfMobile";
import ProfitManagerSelfView from "@/components/shareholders/ProfitManagerSelfView";

// Shell MOBILE của trang Báo cáo Lợi Nhuận (/reports/finance/profit-distribution):
// header + bottom tab bar 3 tab (BC Thu Chi · Tổng quan · Của tôi) theo thiết kế
// ProfitMobileC. Tab hiện theo QUYỀN — cùng logic với ProfitHubPage desktop; các
// tab "bí mật" desktop (Chốt LN, Cổ đông & tỷ lệ…) không đưa lên mobile.
// Tab BC Thu Chi tự render header riêng (pill tháng + nút toà + nút lọc — kiểu 1b).

type TabKey = "report" | "overview" | "my";

// Shell nền kem dùng cho cả màn chờ (tránh nháy MainLayout desktop lúc chưa biết quyền).
// z-40 CHỦ Ý: dialog Radix (z-50, portal cuối body) phải nổi LÊN TRÊN shell.
function MobileShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#f5f3ee] text-[#1b1813]">
      {children}
    </div>
  );
}

export function ProfitMobileBoot() {
  return (
    <MobileShell>
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <div
          className="w-12 h-12 rounded-full border-[3px] animate-spin"
          style={{ borderColor: "rgba(31,122,82,.18)", borderTopColor: "#1f7a52" }}
        />
        <div className="text-[14px] font-bold text-[#1a6645]">Đang tải báo cáo…</div>
      </div>
    </MobileShell>
  );
}

export default function ProfitHubMobile({
  canReport,
  isManager,
  me,
  myManager,
}: {
  canReport: boolean;
  isManager: boolean;
  me: Shareholder | null;
  myManager: ProfitManager | null;
}) {
  const navigate = useNavigate();
  const goBack = () => navigate(-1);
  // Cổ đông-partner có quyền báo cáo (không phải quản lý) → tab tự-xem "Của tôi"
  // (RLS tự lọc về phần của mình) — cùng điều kiện với desktop [[canSeeOwnShare]].
  const canSeeOwnShare = !!me && canReport && !isManager;

  const tabs: { key: TabKey; label: string; icon: ComponentType<{ className?: string }> }[] = [];
  if (canReport) tabs.push({ key: "report", label: "BC Thu Chi", icon: BarChart3 });
  if (isManager) tabs.push({ key: "overview", label: "Tổng quan", icon: PieChart });
  if (canSeeOwnShare) tabs.push({ key: "my", label: "Của tôi", icon: CircleUserRound });

  const defaultTab: TabKey = canSeeOwnShare ? "my" : tabs[0]?.key ?? "report";
  const [tabRaw, setTab] = usePersistedState<TabKey>("flt:profit-hub-mb:tab", defaultTab);
  const tab = tabs.some((t) => t.key === tabRaw) ? tabRaw : defaultTab;

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
            right={!managerOnly && tabs.length > 0 ? yearPill : undefined}
          />
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto w-full max-w-[480px] px-3.5 pt-3 pb-2">
              {managerOnly && myManager ? (
                <ProfitManagerSelfView me={myManager} />
              ) : tabs.length === 0 ? (
                <p className="text-[13px] font-semibold text-[#8d8678] text-center pt-16 px-6">
                  Bạn không có quyền xem báo cáo này. Liên hệ quản trị.
                </p>
              ) : tab === "overview" ? (
                <ProfitOverviewMobile year={oYear} onYearChange={setOYear} />
              ) : (
                me && <ShareholderSelfMobile me={me} year={sYear} onYearChange={setSYear} />
              )}
            </div>
          </div>
        </>
      )}

      {/* Bottom tab bar */}
      {tabs.length > 1 && (
        <div
          className="shrink-0 bg-white border-t border-[#e7e3da]"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
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
