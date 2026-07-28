import { useMemo, useRef, useState } from "react";

import { useAuth } from "@/hooks/useAuth";
import { useBuildings } from "@/hooks/useBuildings";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { useProfile } from "@/hooks/useProfile";
import { canUse } from "@/lib/permissionPages";
import type {
  MaintenanceInput,
  NetworkActionRequest,
  NetworkSettings,
  PhysicalBuildingRecord,
} from "@/lib/network-center/contracts";
import { resolveNetworkActor } from "@/lib/network-center/actorIdentity";
import { DemoNetworkCenterRepository } from "@/lib/network-center/demoRepository";
import { synchronizeDemoNetworkCenterRepository } from "@/lib/network-center/repositoryLifecycle";

const EXECUTE_DISABLED_MESSAGE =
  "Tài khoản chỉ có quyền xem. Cần network_center.execute để thay đổi dữ liệu mô phỏng cục bộ.";

export function useNetworkCenter() {
  const buildingsQuery = useBuildings();
  const permissionsQuery = useMyPermissions();
  const authQuery = useAuth();
  const profileQuery = useProfile();
  const [, forceRefresh] = useState(0);

  const physicalBuildings = useMemo<PhysicalBuildingRecord[]>(
    () =>
      (buildingsQuery.data ?? []).map((building: {
        id: string;
        name: string;
        rooms_count?: number | null;
      }) => ({
        id: building.id,
        name: building.name,
        roomsCount: building.rooms_count ?? 0,
      })),
    [buildingsQuery.data],
  );

  const buildingSignature = physicalBuildings
    .map((building) => `${building.id}:${building.name}:${building.roomsCount ?? 0}`)
    .join("|");

  const [repository] = useState(() => new DemoNetworkCenterRepository([]));
  const repositorySignature = useRef("");
  if (repositorySignature.current !== buildingSignature) {
    synchronizeDemoNetworkCenterRepository(repository, physicalBuildings);
    repositorySignature.current = buildingSignature;
  }

  const actor = resolveNetworkActor(authQuery.data, profileQuery.data);
  const canExecute = Boolean(actor.id) && canUse(permissionsQuery.data, "network_center", "execute");
  const refresh = () => forceRefresh((version) => version + 1);
  const requireExecute = () => {
    if (!canExecute) throw new Error(EXECUTE_DISABLED_MESSAGE);
  };

  return {
    buildingsQuery,
    permissionsQuery,
    authQuery,
    profileQuery,
    physicalBuildings,
    fleet: repository.listFleet(),
    actor,
    canExecute,
    executeDisabledMessage: EXECUTE_DISABLED_MESSAGE,
    getBuilding: (buildingId: string) => repository.getBuilding(buildingId),
    acknowledgeIncident(buildingId: string, incidentId: string) {
      requireExecute();
      repository.acknowledgeIncident(buildingId, incidentId, actor);
      refresh();
    },
    createMaintenance(buildingId: string, input: MaintenanceInput) {
      requireExecute();
      const maintenance = repository.createMaintenance(buildingId, input, actor);
      refresh();
      return maintenance;
    },
    cancelMaintenance(buildingId: string, maintenanceId: string) {
      requireExecute();
      repository.cancelMaintenance(buildingId, maintenanceId, actor);
      refresh();
    },
    captureConfiguration(buildingId: string, label: string) {
      requireExecute();
      const revision = repository.captureConfiguration(buildingId, label, actor);
      refresh();
      return revision;
    },
    compareRevisions: repository.compareRevisions.bind(repository),
    executeAction(buildingId: string, request: NetworkActionRequest) {
      requireExecute();
      const job = repository.executeAction(buildingId, request, actor);
      refresh();
      return job;
    },
    updateSettings(buildingId: string, settings: Partial<NetworkSettings>) {
      requireExecute();
      repository.updateSettings(buildingId, settings, actor);
      refresh();
    },
  };
}

export type NetworkCenterController = ReturnType<typeof useNetworkCenter>;
