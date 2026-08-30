import { Route, Routes, useMatch } from "react-router-dom";

import { BuildingWorkspace } from "@/components/network-center/BuildingWorkspace";
import { FleetOverview } from "@/components/network-center/FleetOverview";
import { NetworkCenterShell } from "@/components/network-center/NetworkCenterShell";
import {
  NetworkCenterEmpty,
  NetworkCenterError,
  NetworkCenterLoading,
  NetworkCenterNotFound,
} from "@/components/network-center/NetworkCenterStates";
import { useNetworkCenter, type NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import "./networkCenter.css";

export default function NetworkCenterApp() {
  const buildingMatch = useMatch("/network-center/buildings/:buildingId");
  const controller = useNetworkCenter(buildingMatch?.params.buildingId);

  if (
    controller.authQuery.isLoading
    || controller.buildingsQuery.isLoading
    || controller.permissionsQuery.isLoading
    || controller.fleetQuery.isLoading
  ) {
    return <NetworkCenterLoading />;
  }
  if (
    controller.authQuery.isError
    || controller.buildingsQuery.isError
    || controller.permissionsQuery.isError
    || controller.fleetQuery.isError
  ) {
    return <NetworkCenterError retry={() => {
      void controller.authQuery.refetch();
      void controller.buildingsQuery.refetch();
      void controller.permissionsQuery.refetch();
      void controller.fleetQuery.refetch();
    }} />;
  }
  if (!controller.availableBuildings.length) return <NetworkCenterEmpty />;

  return (
    <NetworkCenterShell
      buildings={controller.availableBuildings}
      selectedBuildingId={buildingMatch?.params.buildingId}
      canExecute={controller.canExecute}
      mode={controller.mode}
      onRefresh={controller.refreshAll}
      isRefreshing={controller.isRefreshing}
    >
      <Routes>
        <Route index element={<FleetOverview controller={controller} />} />
        <Route path="buildings/:buildingId" element={<BuildingRoute controller={controller} />} />
        <Route path="*" element={<NetworkCenterNotFound />} />
      </Routes>
    </NetworkCenterShell>
  );
}

function BuildingRoute({ controller }: { controller: NetworkCenterController }) {
  if (controller.buildingQuery.isLoading) return <NetworkCenterLoading />;
  if (controller.buildingQuery.isError) {
    return <NetworkCenterError retry={() => void controller.buildingQuery.refetch()} />;
  }
  return controller.selectedBuilding
    ? <BuildingWorkspace site={controller.selectedBuilding} controller={controller} />
    : <NetworkCenterNotFound building />;
}
