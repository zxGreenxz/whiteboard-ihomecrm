import { Route, Routes, useMatch, useParams } from "react-router-dom";

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
  const controller = useNetworkCenter();
  const buildingMatch = useMatch("/network-center/buildings/:buildingId");

  if (controller.buildingsQuery.isLoading || controller.permissionsQuery.isLoading) {
    return <NetworkCenterLoading />;
  }
  if (controller.buildingsQuery.isError) {
    return <NetworkCenterError retry={() => controller.buildingsQuery.refetch()} />;
  }
  if (!controller.physicalBuildings.length) return <NetworkCenterEmpty />;

  return (
    <NetworkCenterShell
      buildings={controller.physicalBuildings}
      selectedBuildingId={buildingMatch?.params.buildingId}
      canExecute={controller.canExecute}
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
  const { buildingId = "" } = useParams<{ buildingId: string }>();
  const site = controller.getBuilding(buildingId);
  return site
    ? <BuildingWorkspace site={site} controller={controller} />
    : <NetworkCenterNotFound building />;
}
