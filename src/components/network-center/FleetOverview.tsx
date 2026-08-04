import { AlertTriangle } from "lucide-react";
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
  // Toà nào có RPC chi tiết hỏng thật thì phải nói ra: hàng vẫn là số liệu thật
  // của RPC hạm đội, nhưng sự cố/cổng giao tiếp của toà đó đang thiếu.
  const detailFailures = useMemo(
    () => controller.fleet.filter((site) => Boolean(site.detailError)),
    [controller.fleet],
  );
  const buildingNames = useMemo(
    () => new Map(view.fleet.map((site) => [site.buildingId, site.buildingName])),
    [view.fleet],
  );
  const rolloutStates = useMemo(
    () => new Map(view.fleet.map((site) => [site.buildingId, site.rolloutState])),
    [view.fleet],
  );

  return (
    <div className="nc-page-stack">
      <section className="nc-page-heading">
        <div>
          <p className="nc-eyebrow">Toàn hệ thống / {controller.fleet.length} toà vật lý</p>
          <h2>Bảng điều hành mạng</h2>
          <p>{controller.isDemo
            ? "Mỗi toà dùng một MikroTik; dữ liệu Aruba chỉ để theo dõi. Mọi số liệu bên dưới đều là mô phỏng cục bộ."
            : "Mỗi toà dùng một MikroTik; Aruba không giới hạn tổng số và luôn chỉ hiển thị. Trạng thái bên dưới lấy trực tiếp từ control plane."}</p>
        </div>
      </section>

      {detailFailures.length > 0 ? (
        <section className="nc-state-card" role="alert">
          <AlertTriangle aria-hidden="true" />
          <h2>Chưa tải được chi tiết {detailFailures.length} toà nhà</h2>
          <p>
            Số liệu hạm đội bên dưới là thật, nhưng sự cố và cổng giao tiếp của các toà
            sau đang thiếu vì truy vấn chi tiết thất bại — Network Center không tự tạo
            dữ liệu thay thế:
          </p>
          <ul className="nc-detail-failures">
            {detailFailures.map((site) => (
              <li key={site.buildingId}>
                <strong>{site.buildingName}</strong> — {site.detailError}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <NetworkMetricStrip summary={view.summary} isDemo={controller.isDemo} />
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
          rolloutStates={rolloutStates}
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
