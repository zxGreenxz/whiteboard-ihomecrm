import { useRef, useState, type ReactNode } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { PieChart } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useMyShareholder } from "@/hooks/useShareholders";
import { useMyProfitManager } from "@/hooks/useProfitManagers";
import ProfitDistributionContent from "@/pages/reports/finance/ProfitDistributionReport";
import ProfitOverviewTab from "@/components/shareholders/ProfitOverviewTab";
import ProfitLockTab from "@/components/shareholders/ProfitLockTab";
import ShareConfigTab from "@/components/shareholders/ShareConfigTab";
import ShareholderSelfView from "@/components/shareholders/ShareholderSelfView";
import ProfitManagerSelfView from "@/components/shareholders/ProfitManagerSelfView";

/**
 * Trang gộp "Phân bổ & chia lợi nhuận" (/reports/finance/profit-distribution).
 * Gộp báo cáo Phân bổ lợi nhuận + module Chia lợi nhuận cổ đông thành 1 trang nhiều
 * tab phẳng. Tab hiển thị theo QUYỀN của người xem:
 *  - "Phân bổ lợi nhuận"  → quyền reports_finance.profit_distribution
 *  - "Tổng quan/Chốt LN/Cổ đông" → quyền shareholder_profit (như trang cũ)
 * Cổ đông thuần (không phải quản lý, không quyền báo cáo) → xem giao diện tự xem.
 */
export default function ProfitHubPage() {
  const { data: perms, isLoading: permsLoading } = useMyPermissions();
  const { data: me, isLoading: meLoading } = useMyShareholder();
  const { data: myManager, isLoading: mgrLoading } = useMyProfitManager();

  const canReport = canUse(perms, "reports_finance", "profit_distribution");
  const canLock = canUse(perms, "shareholder_profit", "lock");
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canManageShareholders = canUse(perms, "shareholder_profit", "manage_shareholders");
  const isManager = !!perms?.__superadmin || canLock || canDistribute || canManageShareholders;

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
  if (canReport) tabs.push({ value: "report", label: "Phân bổ lợi nhuận", node: <ProfitDistributionContent /> });
  if (isManager) {
    tabs.push({ value: "overview", label: "Tổng quan", node: <ProfitOverviewTab /> });
    if (canLock) tabs.push({ value: "lock", label: "Chốt LN tháng", node: <ProfitLockTab />, secret: true });
    if (canManageShareholders) tabs.push({ value: "config", label: "Cổ đông & tỷ lệ", node: <ShareConfigTab />, secret: true });
  }
  // Quản lý điều hành đang đăng nhập: thêm tab tự xem lương của mình.
  if (myManager) {
    tabs.push({ value: "my-salary", label: "Lương của tôi", node: <ProfitManagerSelfView me={myManager} />, secret: true });
  }

  const visibleTabs = tabs.filter((t) => revealSecret || !t.secret);

  return (
    <MainLayout
      title="Phân bổ & chia lợi nhuận"
      subtitle="Báo cáo Tài chính → Cổ đông"
      icon={PieChart}
      onIconClick={handleIconClick}
    >
      {permsLoading ? (
        <p className="text-muted-foreground">Đang tải...</p>
      ) : visibleTabs.length > 0 ? (
        <Tabs key={revealSecret ? "revealed" : "hidden"} defaultValue={visibleTabs[0].value} className="space-y-4">
          <TabsList>
            {visibleTabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
          {visibleTabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>{t.node}</TabsContent>
          ))}
        </Tabs>
      ) : me || myManager ? (
        <div className="space-y-6">
          {me && <ShareholderSelfView me={me} />}
          {myManager && <ProfitManagerSelfView me={myManager} />}
        </div>
      ) : meLoading || mgrLoading ? (
        <p className="text-muted-foreground">Đang tải...</p>
      ) : (
        <p className="text-muted-foreground">
          Bạn chưa được gán là cổ đông và không có quyền xem báo cáo này. Liên hệ quản trị.
        </p>
      )}
    </MainLayout>
  );
}
