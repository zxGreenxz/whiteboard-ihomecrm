import { ArrowLeft, Router } from "lucide-react";
import { Link } from "react-router-dom";

import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { backupAgeText } from "@/lib/network-center/model";
import { BuildingTabs } from "./BuildingTabs";
import { NetworkStatus } from "./NetworkStatus";

export function BuildingWorkspace({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  return (
    <div className="nc-page-stack">
      <section className="nc-building-heading">
        <div>
          <Link to="/network-center" className="nc-inline-back"><ArrowLeft /> Danh sách mạng</Link>
          <p className="nc-eyebrow">Không gian toà nhà / {controller.isDemo ? "dữ liệu mô phỏng" : "dữ liệu trực tiếp"}</p>
          <h2>{site.buildingName}</h2>
          <p className="nc-building-subtitle"><Router /> {site.router.identity} · {site.router.model} · RouterOS {site.router.firmware} · {site.router.lastSeenLabel}</p>
        </div>
        <div className="nc-building-statuses">
          <NetworkStatus kind={site.health} />
          <NetworkStatus kind={site.backupStatus} label={site.backupAgeHours < 0 ? "Backup chưa có" : `Backup ${backupAgeText(site.backupAgeHours)}`} />
          {site.maintenance ? <NetworkStatus kind="maintenance" /> : null}
        </div>
      </section>
      <BuildingTabs site={site} controller={controller} />
    </div>
  );
}
