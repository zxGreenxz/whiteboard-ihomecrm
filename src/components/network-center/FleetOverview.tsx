import { useMemo, useState } from "react";

import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { FleetFilters as FilterState } from "@/lib/network-center/contracts";
import { deriveFleetView } from "@/lib/network-center/model";
import { FleetFilters } from "./FleetFilters";
import { FleetTable } from "./FleetTable";
import { IncidentRail } from "./IncidentRail";
import { NetworkMetricStrip } from "./NetworkMetricStrip";

const EMPTY_FILTERS: FilterState = {
  search: "",
  health: "all",
  severity: "all",
  backup: "all",
  firmware: "all",
};

export function FleetOverview({ controller }: { controller: NetworkCenterController }) {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const view = useMemo(() => deriveFleetView(controller.fleet, filters), [controller.fleet, filters]);
  const buildingNames = useMemo(
    () => new Map(view.fleet.map((site) => [site.buildingId, site.buildingName])),
    [view.fleet],
  );

  return (
    <div className="nc-page-stack">
      <section className="nc-page-heading">
        <div>
          <p className="nc-eyebrow">Toàn hệ thống / {controller.fleet.length} toà vật lý</p>
          <h2>Bảng điều hành mạng</h2>
          <p>Mỗi toà dùng một MikroTik; dữ liệu Aruba chỉ để theo dõi. Mọi số liệu bên dưới đều là mô phỏng cục bộ.</p>
        </div>
      </section>

      <NetworkMetricStrip summary={view.summary} />
      <FleetFilters
        filters={filters}
        resultCount={view.fleet.length}
        totalCount={controller.fleet.length}
        onChange={setFilters}
        onReset={() => setFilters(EMPTY_FILTERS)}
      />

      <div className="nc-fleet-layout">
        <IncidentRail
          incidents={view.incidents}
          buildingNames={buildingNames}
          canExecute={controller.canExecute}
          disabledReason={controller.executeDisabledMessage}
          onAcknowledge={controller.acknowledgeIncident}
        />
        <section className="nc-panel nc-fleet-panel" aria-labelledby="fleet-title">
          <div className="nc-panel-heading">
            <div><p className="nc-eyebrow">Toàn bộ toà nhà</p><h2 id="fleet-title">Danh sách toà nhà</h2></div>
            <span>Mở từng toà nhà bằng liên kết có tên rõ ràng</span>
          </div>
          <FleetTable fleet={view.fleet} />
        </section>
      </div>
    </div>
  );
}
