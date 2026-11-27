import { useOrganization } from "@/contexts/OrganizationContext";
import { CameraAlertSettingsPage, type CameraAlertPageController } from "./CameraAlertSettingsPage";

/**
 * Route /network-center/camera-alerts (tải lười từ NetworkCenterApp).
 * Công ty = công ty đang chọn của iHomeCRM; chưa chọn mà mọi toà Network Center
 * cùng một công ty thì dùng công ty đó.
 */
export default function CameraAlertSettingsRoute({ controller }: { controller: CameraAlertPageController }) {
  const { selectedOrganizationId, organizations } = useOrganization();
  const buildingOrganizations = [...new Set(
    controller.physicalBuildings.map((building) => building.organizationId).filter((id): id is string => Boolean(id)),
  )];
  const organizationId = selectedOrganizationId
    ?? (buildingOrganizations.length === 1 ? buildingOrganizations[0] ?? null : null);
  const organizationName = organizations.find((organization) => organization.id === organizationId)?.name ?? null;
  return <CameraAlertSettingsPage controller={controller} organizationId={organizationId} organizationName={organizationName} />;
}
