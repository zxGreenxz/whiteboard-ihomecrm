// Trang "Cài đặt thông báo" `/account/notifications` (plan 21/10/2026, gói D).
//
// Gom về MỘT chỗ thứ trước đây rải ở 3 nơi (Hồ sơ desktop, Tài khoản mobile, tab Thông báo của
// Cài đặt chung) cộng một khoá ẩn: thiết bị này, thiết bị đã đăng ký, loại thông báo, giờ yên
// cá nhân, nhắc cục bộ của "Việc của tôi", và — chỉ với người có `settings.view` — cấu hình
// công ty + sức khoẻ giao thông báo.
//
// Route chỉ bọc ProtectedRoute: mọi thành viên phải tự chỉnh được thông báo CỦA MÌNH (đa số
// người nhận không có `settings.view`). Theo khuôn trang tài khoản: điện thoại dựng vỏ app
// toàn màn hình `.cm-app` như AccountMobilePage, máy tính dùng MainLayout như ProfilePage.
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, BellRing, ListTodo } from "lucide-react";
import "@/styles/mobileApp.css";
import MainLayout from "@/components/layout/MainLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/loading/LoadingState";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import PushNotificationSettings from "@/components/notifications/PushNotificationSettings";
import PushDevicesCard from "@/components/notifications/PushDevicesCard";
import NotificationPreferencesCard from "@/components/notifications/NotificationPreferencesCard";
import NotificationQuietHoursCard from "@/components/notifications/NotificationQuietHoursCard";
import NotificationOrgConfigCard from "@/components/notifications/NotificationOrgConfigCard";
import NotificationDeliveryHealthCard from "@/components/notifications/NotificationDeliveryHealthCard";

/** Đường mở thẳng ô "Nhắc hẹn" của trang Việc của tôi (PersonalTasksPage đọc `?mo=nhac-hen`). */
export const PERSONAL_TASK_REMINDER_SETTINGS_URL = "/viec-cua-toi?mo=nhac-hen";

function DeviceRemindersCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListTodo className="h-5 w-5" />
          Nhắc trên thiết bị
        </CardTitle>
        <CardDescription>
          Nhắc hẹn của "Việc của tôi" là nhắc cục bộ trên thiết bị này: cài đặt lưu trong trình duyệt,
          chỉ chạy khi trang Việc của tôi đang mở và không đi qua máy chủ — khác với các thông báo ở trên.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline" size="sm">
          <Link to={PERSONAL_TASK_REMINDER_SETTINGS_URL}>Mở cài đặt nhắc hẹn của Việc của tôi</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>;
}

export function NotificationSettingsContent() {
  const { selectedOrganizationId, organization, isLoading: orgLoading, isError: orgError, isMultiOrg, refetchOrganizations } = useOrganization();
  const { data: perms } = useMyPermissions();
  const canView = canUse(perms, "settings", "view");
  const canEdit = canUse(perms, "settings", "edit");

  return (
    <div className="grid gap-4">
      <SectionTitle>Trên thiết bị</SectionTitle>
      <PushNotificationSettings />
      <PushDevicesCard />
      <DeviceRemindersCard />

      <SectionTitle>Thông báo của tôi</SectionTitle>
      {orgLoading ? (
        <LoadingState label="công ty đang chọn" variant="cards" rows={2} onRetry={() => void refetchOrganizations()} />
      ) : orgError ? (
        <Card><CardContent className="space-y-3 p-4">
          <p role="alert">Chưa tải được danh sách công ty của bạn nên chưa đọc được tuỳ chọn thông báo.</p>
          <Button variant="outline" onClick={() => void refetchOrganizations()}>Tải lại</Button>
        </CardContent></Card>
      ) : (
        <>
          {organization && (
            <p className="text-sm text-muted-foreground">
              Áp dụng cho công ty <b className="text-foreground">{organization.name}</b>
              {isMultiOrg ? ". Đổi công ty đang chọn để chỉnh thông báo của công ty khác." : "."}
            </p>
          )}
          <NotificationPreferencesCard organizationId={selectedOrganizationId} />
          <NotificationQuietHoursCard organizationId={selectedOrganizationId} />
        </>
      )}

      {canView && selectedOrganizationId && !orgLoading && (
        <>
          <SectionTitle>Công ty</SectionTitle>
          <NotificationOrgConfigCard organizationId={selectedOrganizationId} organizationName={organization?.name ?? null} canEdit={canEdit} />
          <NotificationDeliveryHealthCard organizationId={selectedOrganizationId} />
        </>
      )}
    </div>
  );
}

function NotificationSettingsMobile() {
  const navigate = useNavigate();
  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate("/account/profile")} aria-label="Về trang Tài khoản">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Cài đặt thông báo</h1>
              <p>Thiết bị nhận · loại thông báo · giờ yên</p>
            </div>
          </div>
          <div className="mbody">
            <NotificationSettingsContent />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function NotificationSettingsPage() {
  const isPhone = usePhoneViewport();
  if (isPhone) return <NotificationSettingsMobile />;
  return (
    <MainLayout title="Cài đặt thông báo" subtitle="Thiết bị nhận, loại thông báo và giờ yên của bạn" icon={BellRing}>
      <div className="max-w-3xl">
        <NotificationSettingsContent />
      </div>
    </MainLayout>
  );
}
