import { Activity, DatabaseBackup, Network, Users } from "lucide-react";

import type { NetworkCenterController } from "@/hooks/network-center/useNetworkCenter";
import type { NetworkBuilding } from "@/lib/network-center/contracts";
import { summarizeAruba } from "@/lib/network-center/model";
import { MaintenanceDialog } from "../MaintenanceDialog";
import { NetworkActionDialog } from "../NetworkActionDialog";
import { NetworkStatus } from "../NetworkStatus";

export function OverviewTab({ site, controller }: { site: NetworkBuilding; controller: NetworkCenterController }) {
  const aruba = summarizeAruba(site);
  const arubaOnline = aruba.online ?? 0;
  const openIncidents = site.incidents.filter((incident) => incident.status !== "resolved").length;
  const wanTone = site.router.wanStatus === "up" ? "good" : "bad";
  const arubaTone = aruba.online === null
    ? "info"
    : site.arubaNodes.some((node) => node.status === "offline")
      ? "bad"
      : site.arubaNodes.some((node) => node.status === "slow") ? "warn" : "good";
  const incidentTone = openIncidents === 0
    ? "good"
    : site.incidents.some((incident) => incident.status !== "resolved" && ["critical", "high"].includes(incident.severity)) ? "bad" : "warn";
  const backupTone = site.backupStatus === "fresh" ? "good" : "warn";
  return (
    <div className="nc-tab-stack">
      <section className="nc-kpis nc-building-kpis" aria-label="Chỉ số toà nhà">
        <article className={`nc-kpi nc-tone-${wanTone}`}><span className="nc-kpi-label"><Network /> WAN</span><strong>{site.router.wanStatus.toUpperCase()}</strong><small>{site.router.downloadMbps}/{site.router.uploadMbps} Mbps</small></article>
        <article className="nc-kpi nc-tone-info"><span className="nc-kpi-label"><Activity /> CPU / RAM</span><strong>{site.router.cpuPercent}/{site.router.memoryPercent}%</strong><small>{site.router.lastSeenLabel}</small></article>
        <article className="nc-kpi nc-tone-info"><span className="nc-kpi-label"><Users /> Client</span><strong>{site.activeClients}</strong><small>{site.clients.length} mẫu hiển thị</small></article>
        <article className={`nc-kpi nc-tone-${arubaTone}`}><span className="nc-kpi-label"><Network /> Aruba</span><strong>{aruba.online === null ? "—" : arubaOnline}/{aruba.total}</strong><small>Chỉ hiển thị</small></article>
        <article className={`nc-kpi nc-tone-${incidentTone}`}><span className="nc-kpi-label"><Activity /> Sự cố</span><strong>{openIncidents}</strong><small>đang theo dõi</small></article>
        <article className={`nc-kpi nc-tone-${backupTone}`}><span className="nc-kpi-label"><DatabaseBackup /> Backup</span><strong>{site.backupAgeHours < 0 ? "Chưa có" : `${site.backupAgeHours}h`}</strong><small>{site.revisions[0] ? `${controller.isDemo ? "Mã mô phỏng" : "SHA-256"} ${site.revisions[0].hash.slice(-8)}` : "Chưa có snapshot"}</small></article>
      </section>

      <div className="nc-building-layout">
        <section className="nc-topology" aria-labelledby="overview-topology-title">
          <div className="nc-panel-heading"><div><p className="nc-eyebrow">Luồng phụ thuộc</p><h3 id="overview-topology-title">Sơ đồ nhanh</h3></div><NetworkStatus kind={site.health} /></div>
          <div className="nc-router-node"><strong>{site.router.identity}</strong><span>{site.router.model} · RouterOS {site.router.firmware}</span></div>
          <div className="nc-node-connector" aria-hidden="true" />
          <div className="nc-aruba-nodes">
            {site.arubaNodes.slice(0, 6).map((node) => (
              <div className={`nc-aruba-node nc-node-${node.status}`} key={node.id}><strong>{node.name}</strong><span>{node.status === "online" ? "Online" : node.status === "slow" ? "Chậm" : "Offline"}</span></div>
            ))}
          </div>
        </section>

        <aside className="nc-panel nc-safe-actions">
          <div className="nc-panel-heading"><div><p className="nc-eyebrow">Danh sách được phép</p><h3>Thao tác an toàn</h3></div></div>
          {!controller.canExecute ? <div className="nc-locked-note"><NetworkStatus kind="view-only" /><p>{controller.executeDisabledMessage}</p></div> : null}
          {site.maintenance ? <div className="nc-safe-copy"><strong>Đang bảo trì</strong><span>{site.maintenance.reason} · {site.maintenance.durationMinutes} phút</span></div> : null}
          <NetworkActionDialog
            site={site}
            canExecute={controller.canExecute}
            disabledReason={controller.executeDisabledMessage}
            isDemo={controller.isDemo}
            persistedIntent={controller.activeActionIntent}
            onExecute={(request) => controller.executeAction(site.buildingId, request)}
          />
          <MaintenanceDialog
            buildingId={site.buildingId}
            buildingName={site.buildingName}
            canExecute={controller.canExecute}
            disabledReason={controller.executeDisabledMessage}
            isDemo={controller.isDemo}
            onCreate={(input) => controller.createMaintenance(site.buildingId, input)}
          />
          <div className="nc-safe-copy">
            <strong>{controller.isDemo ? "Chỉ mô phỏng cục bộ" : "Thực thi có kiểm soát"}</strong>
            <span>{controller.isDemo
              ? "Các nút ghi chỉ đổi bộ nhớ demo; không gọi thiết bị thật."
              : "Worker gọi thiết bị thật qua WireGuard; không cho phép CLI tùy ý, đổi tuyến WAN mặc định hoặc sắp xếp lại firewall."}</span>
          </div>
          <div className="nc-safe-copy"><strong>Aruba chỉ để theo dõi</strong><span>Không có thao tác ghi hoặc thông tin đăng nhập Aruba trong trình duyệt.</span></div>
        </aside>
      </div>

      <section className="nc-panel">
        <div className="nc-panel-heading"><div><p className="nc-eyebrow">Dòng thời gian</p><h3>Hoạt động gần đây</h3></div></div>
        <ol className="nc-timeline">
          {site.audit.slice(0, 5).map((record) => (
            <li key={record.id}><span>{new Date(record.at).toLocaleString("vi-VN")}</span><strong>{record.action}</strong><p>{record.detail}</p></li>
          ))}
        </ol>
      </section>
    </div>
  );
}
