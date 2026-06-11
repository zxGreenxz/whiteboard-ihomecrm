import MainLayout from "@/components/layout/MainLayout";
import { PieChart } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useMyShareholder } from "@/hooks/useShareholders";
import ProfitOverviewTab from "@/components/shareholders/ProfitOverviewTab";
import ProfitLockTab from "@/components/shareholders/ProfitLockTab";
import ShareConfigTab from "@/components/shareholders/ShareConfigTab";
import ShareholderSelfView from "@/components/shareholders/ShareholderSelfView";

export default function ShareholderProfitPage() {
  const { data: perms } = useMyPermissions();
  const { data: me, isLoading: meLoading } = useMyShareholder();

  // Quyền chi tiết theo catalog (fallback legacy: create/edit cũ của module).
  const canLock = canUse(perms, "shareholder_profit", "lock");
  const canDistribute = canUse(perms, "shareholder_profit", "distribute");
  const canManageShareholders = canUse(perms, "shareholder_profit", "manage_shareholders");

  // "Quản lý" = có ít nhất 1 quyền thao tác — còn lại rơi về view cổ đông.
  const isManager = !!perms?.__superadmin || canLock || canDistribute || canManageShareholders;

  return (
    <MainLayout title="Chia lợi nhuận cổ đông" subtitle="Tài chính → Cổ đông" icon={PieChart}>
      {isManager ? (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Tổng quan</TabsTrigger>
            {canLock && <TabsTrigger value="lock">Chốt LN tháng</TabsTrigger>}
            {canManageShareholders && (
              <TabsTrigger value="config">Cổ đông &amp; tỷ lệ</TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="overview"><ProfitOverviewTab /></TabsContent>
          {canLock && <TabsContent value="lock"><ProfitLockTab /></TabsContent>}
          {canManageShareholders && (
            <TabsContent value="config"><ShareConfigTab /></TabsContent>
          )}
        </Tabs>
      ) : me ? (
        <ShareholderSelfView me={me} />
      ) : meLoading ? (
        <p className="text-muted-foreground">Đang tải...</p>
      ) : (
        <p className="text-muted-foreground">
          Bạn chưa được gán là cổ đông. Liên hệ quản trị để được cấp quyền.
        </p>
      )}
    </MainLayout>
  );
}
