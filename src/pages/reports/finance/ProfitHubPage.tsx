import { useRef, useState, type ReactNode } from "react";
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
import ProfitManagerSelfView from "@/components/shareholders/ProfitManagerSelfView";
import { useProfitCloseOrganizations } from "@/hooks/useShareholderProfit";

/**
 * Trang gộp "Báo cáo Lợi Nhuận" (/reports/finance/profit-distribution).
 * Gộp báo cáo Doanh thu — Chi phí + module Chia lợi nhuận cổ đông thành 1 trang
 * nhiều tab phẳng. Tab hiển thị theo QUYỀN của người xem:
 *  - "Tổng quan"           → cổ đông-partner tự xem LN của mình (me && canReport)
 *  - "BC Doanh Thu Chi Phí" → quyền reports_finance.profit_distribution
 *  - "Tổng quan/Chốt LN/Cổ đông" (quản lý) → quyền shareholder_profit (như trang cũ)
 * Quản lý điều hành đang đăng nhập → xem giao diện tự xem lương của mình.
 */
export default function ProfitHubPage() {
  const { data: perms, isLoading: permsLoading } = useMyPermissions();
  const { data: me, isLoading: meLoading } = useMyShareholder();
  const { data: myManager, isLoading: mgrLoading } = useMyProfitManager();
  const {
    data: profitCloseOrganizations = [],
    isLoading: profitCloseOrganizationsLoading,
  } = useProfitCloseOrganizations();
  const phone = usePhoneViewport();

  const canReport = canUse(perms, "reports_finance", "profit_distribution");
  const canViewManagedProfit = canUse(perms, "shareholder_profit", "view");
  const canLock = profitCloseOrganizations.some((organization) => organization.can_lock);
  const canUnlock = profitCloseOrganizations.some((organization) => organization.can_unlock);
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canManageShareholders = canUse(perms, "shareholder_profit", "manage_shareholders");
  const isManager = !!perms?.__superadmin || canLock || canUnlock || canDistribute || canManageShareholders;

  // Cổ đông-partner (B.Huy…) được cấp quyền xem báo cáo LN → thêm tab "Tổng quan"
  // xem phần lợi nhuận của CHÍNH MÌNH (RLS tự lọc, không lộ cổ đông khác). Quản lý
  // tòa (Joey/Nathan) tuy cũng là cổ đông nhưng KHÔNG có quyền báo cáo này nên không
  // thấy tab — đúng yêu cầu chủ. Super admin / quản lý LN đã có tab "Tổng quan" quản
  // lý (ProfitOverviewTab) nên loại trừ (!isManager) để khỏi trùng.
  const canSeeOwnShare = !!me && canReport && !isManager;

  // Các tab nhạy cảm (Chốt LN tháng, Cổ đông & tỷ lệ, Lương của tôi) MẶC ĐỊNH ẨN.
  // Nhấp 3 lần vào icon xanh bên trái tiêu đề để hiện ra (easter egg).
  const [revealSecret, setRevealSecret] = useState(false);
  const clickCount = useRef(0);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleIconClick = () => {
    clickCount.current += 1;
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (clickCount.current >= 3) {
      clickCount.current = 0;
      setRevealSecret((prev) => !prev); // nhấp lại 3 lần để ẩn đi
      return;
    }
    // reset chuỗi nhấp nếu chậm quá (mỗi nhịp cách nhau tối đa 600ms)
    clickTimer.current = setTimeout(() => {
      clickCount.current = 0;
    }, 600);
  };

  const tabs: { value: string; label: string; node: ReactNode; secret?: boolean }[] = [];
  // Tab tự-xem của cổ đông-partner ĐỨNG ĐẦU (mặc định) — xem [[canSeeOwnShare]].
  if (canSeeOwnShare && me) tabs.push({ value: "my-overview", label: "Tổng quan", node: <ShareholderSelfView me={me} /> });
  if (canReport) tabs.push({ value: "report", label: "BC Doanh Thu Chi Phí", node: <ProfitDistributionContent /> });
  if (isManager) {
    if (canViewManagedProfit) tabs.push({ value: "overview", label: "Tổng quan", node: <ProfitOverviewTab /> });
    if (canLock || canUnlock) tabs.push({
      value: "lock",
      label: "Chốt LN tháng",
      node: <ProfitLockTab organizations={profitCloseOrganizations} />,
      secret: true,
    });
    if (canManageShareholders) tabs.push({ value: "config", label: "Cổ đông & tỷ lệ", node: <ShareConfigTab />, secret: true });
  }
  // Quản lý điều hành đang đăng nhập: thêm tab tự xem lương của mình.
  if (myManager) {
    tabs.push({ value: "my-salary", label: "Lương của tôi", node: <ProfitManagerSelfView me={myManager} />, secret: true });
  }

  const visibleTabs = tabs.filter((t) => revealSecret || !t.secret);
  // Tab đang mở — tự rơi về tab đầu khi danh sách đổi (bật/tắt easter egg, quyền
  // tải xong) để không kẹt ở value không còn tồn tại.
  const [tabValue, setTabValue] = useState<string | null>(null);
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
      <ProfitHubMobile
        canReport={canReport}
        isManager={isManager && canViewManagedProfit}
        me={me ?? null}
        myManager={myManager ?? null}
      />
    );
  }

  return (
    <MainLayout>
      <ProfitHubShell
        // Chờ đủ quyền rồi mới dựng thanh tab — nếu không tab sẽ "mọc" dần theo
        // từng query (vd "Chốt LN tháng" chỉ có sau khi profitCloseOrganizations về).
        tabs={
          loading ? [] : visibleTabs.map((t) => ({ value: t.value, label: t.label, secret: t.secret }))
        }
        value={activeTab}
        onValueChange={setTabValue}
        onIconClick={handleIconClick}
      >
        {loading ? (
          <p className="ph-empty">Đang tải...</p>
        ) : visibleTabs.length > 0 ? (
          visibleTabs.map((t) => (
            <ProfitHubTabPanel key={t.value} value={t.value}>
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
    </MainLayout>
  );
}
