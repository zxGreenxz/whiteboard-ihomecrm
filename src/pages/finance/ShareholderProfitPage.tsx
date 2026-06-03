import MainLayout from "@/components/layout/MainLayout";
import { PieChart } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useMyPermissions, can } from "@/hooks/useMyPermissions";
import { useMyShareholder } from "@/hooks/useShareholders";
import ProfitOverviewTab from "@/components/shareholders/ProfitOverviewTab";
import ProfitLockTab from "@/components/shareholders/ProfitLockTab";
import ShareConfigTab from "@/components/shareholders/ShareConfigTab";
import ShareholderSelfView from "@/components/shareholders/ShareholderSelfView";

export default function ShareholderProfitPage() {
  const { data: perms } = useMyPermissions();
  const { data: me, isLoading: meLoading } = useMyShareholder();

  const isManager =
    !!perms?.__superadmin ||
    can(perms, "shareholder_profit", "create") ||
    can(perms, "shareholder_profit", "edit");

  return (
    <MainLayout title="Chia lợi nhuận cổ đông" subtitle="Tài chính → Cổ đông" icon={PieChart}>
      {isManager ? (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Tổng quan</TabsTrigger>
            <TabsTrigger value="lock">Chốt LN tháng</TabsTrigger>
            <TabsTrigger value="config">Cổ đông &amp; tỷ lệ</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><ProfitOverviewTab /></TabsContent>
          <TabsContent value="lock"><ProfitLockTab /></TabsContent>
          <TabsContent value="config"><ShareConfigTab /></TabsContent>
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
