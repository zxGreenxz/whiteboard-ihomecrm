import type { ReactNode } from "react";
import MainLayout from "@/components/layout/MainLayout";
import { PieChart } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useMyShareholder } from "@/hooks/useShareholders";
import ProfitDistributionContent from "@/pages/reports/finance/ProfitDistributionReport";
import ProfitOverviewTab from "@/components/shareholders/ProfitOverviewTab";
import ProfitLockTab from "@/components/shareholders/ProfitLockTab";
import ShareConfigTab from "@/components/shareholders/ShareConfigTab";
import ShareholderSelfView from "@/components/shareholders/ShareholderSelfView";

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

  const canReport = canUse(perms, "reports_finance", "profit_distribution");
  const canLock = canUse(perms, "shareholder_profit", "lock");
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canManageShareholders = canUse(perms, "shareholder_profit", "manage_shareholders");
  const isManager = !!perms?.__superadmin || canLock || canDistribute || canManageShareholders;

  const tabs: { value: string; label: string; node: ReactNode }[] = [];
  if (canReport) tabs.push({ value: "report", label: "Phân bổ lợi nhuận", node: <ProfitDistributionContent /> });
  if (isManager) {
    tabs.push({ value: "overview", label: "Tổng quan", node: <ProfitOverviewTab /> });
    if (canLock) tabs.push({ value: "lock", label: "Chốt LN tháng", node: <ProfitLockTab /> });
    if (canManageShareholders) tabs.push({ value: "config", label: "Cổ đông & tỷ lệ", node: <ShareConfigTab /> });
  }

  return (
    <MainLayout title="Phân bổ & chia lợi nhuận" subtitle="Báo cáo Tài chính → Cổ đông" icon={PieChart}>
      {permsLoading ? (
        <p className="text-muted-foreground">Đang tải...</p>
      ) : tabs.length > 0 ? (
        <Tabs defaultValue={tabs[0].value} className="space-y-4">
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>{t.node}</TabsContent>
          ))}
        </Tabs>
      ) : me ? (
        <ShareholderSelfView me={me} />
      ) : meLoading ? (
        <p className="text-muted-foreground">Đang tải...</p>
      ) : (
        <p className="text-muted-foreground">
          Bạn chưa được gán là cổ đông và không có quyền xem báo cáo này. Liên hệ quản trị.
        </p>
      )}
    </MainLayout>
  );
}
