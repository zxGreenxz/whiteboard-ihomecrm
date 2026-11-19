import { QueryRegion } from "@/components/errors/QueryRegion";
import { LoadingState } from "@/components/loading/LoadingState";
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import MainLayout from "@/components/layout/MainLayout";
import ProfitHubShell, { ProfitHubTabPanel } from "@/pages/reports/finance/ProfitHubShell";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useMyShareholder } from "@/hooks/useShareholders";
import { useMyProfitManager } from "@/hooks/useProfitManagers";
import ProfitDistributionContent from "@/pages/reports/finance/ProfitDistributionReport";
import ProfitHubMobile, { ProfitMobileBoot } from "@/pages/reports/finance/ProfitHubMobile";
import { usePhoneViewport } from "@/hooks/use-mobile";
import ProfitOverviewTab from "@/components/shareholders/ProfitOverviewTab";
import ProfitLockTab from "@/components/shareholders/ProfitLockTab";
import ShareConfigTab from "@/components/shareholders/ShareConfigTab";
import ShareholderSelfView from "@/components/shareholders/ShareholderSelfView";
import ShareholderAdvanceTab from "@/components/shareholders/ShareholderAdvanceTab";
import ProfitManagerSelfView from "@/components/shareholders/ProfitManagerSelfView";
import { useProfitCloseOrganizations } from "@/hooks/useShareholderProfit";

/**
 * Trang gộp "Báo cáo Lợi Nhuận" (/reports/finance/profit-distribution).
 * Gộp báo cáo Doanh thu — Chi phí + module Chia lợi nhuận cổ đông thành 1 trang
 * nhiều tab phẳng. Tab hiển thị theo QUYỀN của người xem:
 *  - "Tổng quan"           → cổ đông-partner tự xem LN của mình (me && canReport)
 *  - "Tạm ứng LN"          → người được cấp riêng quyền tạm ứng mà không có tab tự xem (Đợt 2)
 *  - "BC Doanh Thu Chi Phí" → reports_finance.profit_distribution VÀ shareholder_profit.view_building_totals (Đợt 2)
 *  - "Tổng quan/Chốt LN/Cổ đông" (quản lý) → quyền shareholder_profit (như trang cũ)
 * Quản lý điều hành đang đăng nhập → xem giao diện tự xem lương của mình.
 * `?tab=<value>` mở thẳng một tab (vd lối tắt "Tạm ứng lợi nhuận" từ Lương của tôi: ?tab=my-advance).
 */
export default function ProfitHubPage() {
  const [searchParams] = useSearchParams();
  const permissionQuery = useMyPermissions();
  const {data:perms,isLoading:permsLoading}=permissionQuery;
  const shareholderQuery = useMyShareholder();
  const {data:me,isLoading:meLoading}=shareholderQuery;
  const managerQuery = useMyProfitManager();
  const {data:myManager,isLoading:mgrLoading}=managerQuery;
  const closeOrganizationsQuery = useProfitCloseOrganizations();
  const {
    data: profitCloseOrganizations = [],
    isLoading: profitCloseOrganizationsLoading,
  } = closeOrganizationsQuery;
  const accessQueries = [permissionQuery,shareholderQuery,managerQuery,closeOrganizationsQuery];
  const phone = usePhoneViewport();

  // hermes-parity:begin shareholder-profit — Hermes chép vùng này, xem infra/hermes-broker/web-parity.json
  const canReport = canUse(perms, "reports_finance", "profit_distribution");
  const canViewManagedProfit = canUse(perms, "shareholder_profit", "view");
  const canLock = profitCloseOrganizations.some((organization) => organization.can_lock);
  const canUnlock = profitCloseOrganizations.some((organization) => organization.can_unlock);
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canManageShareholders = canUse(perms, "shareholder_profit", "manage_shareholders");
  const isManager = !!perms?.__superadmin || canLock || canUnlock || canDistribute || canManageShareholders;
  // hermes-parity:end shareholder-profit

  // Đợt 2 (sổ tổng) — ba quyền xem cấp RIÊNG, ngoài vùng Hermes chép ở trên:
  //   doanh thu / lợi nhuận toà (tab BC + thẻ số toà ở màn tự xem), tỷ lệ % của mình, tạm ứng từ sổ mình giữ.
  // Chỉ là lớp hiển thị: máy chủ (E3) bỏ hẳn phần % / số toà khi thiếu quyền.
  const canViewBuildingTotals = canUse(perms, "shareholder_profit", "view_building_totals");
  const canViewPercent = canUse(perms, "shareholder_profit", "view_percent");
  const canAdvanceOwn = canUse(perms, "shareholder_profit", "advance_own_cashbook");

  // Cổ đông-partner (B.Huy…) được cấp quyền xem báo cáo LN → thêm tab "Tổng quan"
  // xem phần lợi nhuận của CHÍNH MÌNH (RLS tự lọc, không lộ cổ đông khác). Quản lý
  // tòa (Joey/Nathan) tuy cũng là cổ đông nhưng KHÔNG có quyền báo cáo này nên không
  // thấy tab — đúng yêu cầu chủ. Super admin / quản lý LN đã có tab "Tổng quan" quản
  // lý (ProfitOverviewTab) nên loại trừ (!isManager) để khỏi trùng.
  const canSeeOwnShare = !!me && canReport && !isManager;
  // Người được chủ cấp riêng quyền tạm ứng mà không có tab tự xem (vd quản lý toà là cổ đông) →
  // tab "Tạm ứng LN": chỉ chi cho chính mình. Có tab tự xem thì nút tạm ứng nằm ngay trong đó.
  const canSeeOwnAdvance = !!me && canAdvanceOwn && !isManager && !canSeeOwnShare;
  const selfAccess = { canViewPercent, canViewBuildingTotals, canAdvanceOwn };

  // Q9 (chủ chốt 11/10/2026): "Chốt LN tháng", "Cổ đông & tỷ lệ" hiện THEO QUYỀN,
  // "Lương của tôi" luôn hiện với quản lý điều hành — bỏ cơ chế nhấp 3 lần vào logo.
  const tabs: { value: string; label: string; node: ReactNode; keepMounted?: boolean }[] = [];
  // Tab tự-xem của cổ đông-partner ĐỨNG ĐẦU (mặc định) — xem [[canSeeOwnShare]].
  if (canSeeOwnShare && me) tabs.push({ value: "my-overview", label: "Tổng quan", node: <ShareholderSelfView me={me} {...selfAccess} /> });
  if (canSeeOwnAdvance && me) tabs.push({ value: "my-advance", label: "Tạm ứng LN", node: <ShareholderAdvanceTab me={me} /> });
  // Đợt 2: tab doanh thu / chi phí toà cần thêm quyền xem số toà (cổ đông chỉ thấy tiền của mình).
  if (canReport && canViewBuildingTotals) tabs.push({ value: "report", label: "BC Doanh Thu Chi Phí", node: <ProfitDistributionContent /> });
  if (isManager) {
    if (canViewManagedProfit) tabs.push({ value: "overview", label: "Tổng quan", node: <ProfitOverviewTab /> });
    if (canLock || canUnlock) tabs.push({
      value: "lock",
      label: "Chốt LN tháng",
      node: <ProfitLockTab organizations={profitCloseOrganizations} />,
      // Nháp chốt (điều chỉnh, lý do, vùng chọn) không được mất khi ghé tab khác.
      keepMounted: true,
    });
    if (canManageShareholders) tabs.push({ value: "config", label: "Cổ đông & tỷ lệ", node: <ShareConfigTab /> });
  }
  // Quản lý điều hành đang đăng nhập: thêm tab tự xem lương của mình.
  if (myManager) {
    tabs.push({ value: "my-salary", label: "Lương của tôi", node: <ProfitManagerSelfView me={myManager} /> });
  }

  const visibleTabs = tabs;
  // Tab đang mở — tự rơi về tab đầu khi danh sách đổi (quyền tải xong) để không kẹt
  // ở value không còn tồn tại. Mở trang bằng `?tab=` thì bắt đầu ở tab đó (nếu người xem có).
  const requestedTab = searchParams.get("tab");
  const [tabValue, setTabValue] = useState<string | null>(requestedTab);
  const activeTab =
    tabValue && visibleTabs.some((t) => t.value === tabValue)
      ? tabValue
      : visibleTabs[0]?.value;

  // Chờ cả perms + me + manager trước khi dựng tab để thứ tự tab (và tab mặc định)
  // ổn định — tránh "Tổng quan" nhảy vào sau khiến trang mở nhầm tab.
  const loading = permsLoading || meLoading || mgrLoading || profitCloseOrganizationsLoading;

  // PHONE: shell riêng (header + bottom tab bar, thiết kế ProfitMobileC) — KHÔNG
  // dùng MainLayout desktop, kể cả lúc quyền đang tải (chờ bằng shell kem).
  if (phone) {
    if (loading) return <ProfitMobileBoot />;
    return (
      <QueryRegion label="quyền xem và hồ sơ lợi nhuận" queries={accessQueries} loading={<ProfitMobileBoot />}>
      <ProfitHubMobile
        canReport={canReport}
        isManager={isManager && canViewManagedProfit}
        me={me ?? null}
        myManager={myManager ?? null}
        canViewBuildingTotals={canViewBuildingTotals}
        canViewPercent={canViewPercent}
        canAdvanceOwn={canAdvanceOwn}
        requestedTab={requestedTab}
      />
      </QueryRegion>
    );
  }

  return (
    <MainLayout>
      <QueryRegion label="quyền xem và hồ sơ lợi nhuận" queries={accessQueries} skeleton="cards" rows={4}>
      <ProfitHubShell
        // Chờ đủ quyền rồi mới dựng thanh tab — nếu không tab sẽ "mọc" dần theo
        // từng query (vd "Chốt LN tháng" chỉ có sau khi profitCloseOrganizations về).
        tabs={
          loading ? [] : visibleTabs.map((t) => ({ value: t.value, label: t.label }))
        }
        value={activeTab}
        onValueChange={setTabValue}
      >
        {loading ? (
          <LoadingState label="báo cáo lợi nhuận" variant="table" rows={6} />
        ) : visibleTabs.length > 0 ? (
          visibleTabs.map((t) => (
            <ProfitHubTabPanel key={t.value} value={t.value} keepMounted={t.keepMounted}>
              {t.node}
            </ProfitHubTabPanel>
          ))
        ) : myManager ? (
          // Quản lý điều hành thuần (không quyền báo cáo) → tự xem lương của mình.
          <ProfitManagerSelfView me={myManager} />
        ) : (
          <p className="ph-empty">Bạn không có quyền xem báo cáo này. Liên hệ quản trị.</p>
        )}
      </ProfitHubShell>
      </QueryRegion>
    </MainLayout>
  );
}
